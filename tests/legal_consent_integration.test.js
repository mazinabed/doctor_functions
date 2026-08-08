'use strict';

/**
 * Legal Consent Modernization (Phase 1) — integration smoke test for the
 * ACTUAL getAccountLegalStatus / acceptAccountLegalDocument handler logic
 * (not just the security-rules boundary, already covered in
 * legal_consent_rules.test.js). Exercises the real Firestore
 * reads/transaction against the emulator via firebase-admin, bypassing
 * security rules entirely (Cloud Functions always use the Admin SDK) —
 * same convention as phase1b_expire_centers_integration.test.js.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest legal_consent_integration --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

// Reuses the functions/ workspace's own firebase-admin install (this test
// package.json is scoped to @firebase/rules-unit-testing / client SDK only)
// rather than adding a second, redundant admin-SDK dependency here.
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  _getAccountLegalStatusHandler: getAccountLegalStatus,
  _acceptAccountLegalDocumentHandler: acceptAccountLegalDocument,
} = require('../functions/legal/legalConsent');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('platformConfig');
  await clearCollection('users');
});

afterAll(async () => {
  await admin.app().delete();
});

test('LC-1 fresh patient with no platformConfig/legal doc defaults every version to v1 and is not current', async () => {
  await db.collection('users').doc('uid_lc1').set({ role: 'patient' });

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc1' }, data: {} });

  expect(status.terms.version).toBe('v1');
  expect(status.privacy.version).toBe('v1');
  expect(status.terms.current).toBe(false);
  expect(status.privacy.current).toBe(false);
});

test('LC-2 accepting terms as a patient stamps patientTermsVersion, writes legalHistory, and getAccountLegalStatus reflects it as current', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v5',
    privacyVersion: 'v2',
  });
  await db.collection('users').doc('uid_lc2').set({ role: 'patient' });

  const result = await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc2' },
    data: { documentType: 'terms', locale: 'ar' },
  });
  expect(result.version).toBe('v3');

  const userSnap = await db.collection('users').doc('uid_lc2').get();
  const acceptance = userSnap.data().legalAcceptances.terms;
  expect(acceptance.accepted).toBe(true);
  expect(acceptance.version).toBe('v3');
  expect(acceptance.acceptedAt).toBeTruthy();

  const historySnap = await db.collection('users/uid_lc2/legalHistory').get();
  expect(historySnap.size).toBe(1);
  const historyDoc = historySnap.docs[0].data();
  expect(historyDoc.documentType).toBe('terms');
  expect(historyDoc.version).toBe('v3');
  expect(historyDoc.locale).toBe('ar');

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc2' }, data: {} });
  expect(status.terms.current).toBe(true);
  expect(status.terms.version).toBe('v3');
  // privacy still untouched/not current.
  expect(status.privacy.current).toBe(false);
});

test('LC-3 a doctor (non-patient) accepting "terms" is stamped with providerTermsVersion, not patientTermsVersion', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v5',
    privacyVersion: 'v2',
  });
  await db.collection('users').doc('uid_lc3').set({ role: 'doctor' });

  const result = await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc3' },
    data: { documentType: 'terms' },
  });
  expect(result.version).toBe('v5');

  const userSnap = await db.collection('users').doc('uid_lc3').get();
  expect(userSnap.data().legalAcceptances.terms.version).toBe('v5');
});

test('LC-4 accepting privacy does not clobber a prior terms acceptance (merge:true on nested key)', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v5',
    privacyVersion: 'v2',
  });
  await db.collection('users').doc('uid_lc4').set({ role: 'patient' });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc4' },
    data: { documentType: 'terms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc4' },
    data: { documentType: 'privacy' },
  });

  const userSnap = await db.collection('users').doc('uid_lc4').get();
  const acceptances = userSnap.data().legalAcceptances;
  expect(acceptances.terms.version).toBe('v3');
  expect(acceptances.privacy.version).toBe('v2');

  const historySnap = await db.collection('users/uid_lc4/legalHistory').get();
  expect(historySnap.size).toBe(2);
});

test('LC-5 a stale acceptance (old version) after a config bump is reported as not current', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });
  await db.collection('users').doc('uid_lc5').set({ role: 'patient' });
  await acceptAccountLegalDocument({ auth: { uid: 'uid_lc5' }, data: { documentType: 'terms' } });

  // Publish a version bump.
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v2',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc5' }, data: {} });
  expect(status.terms.current).toBe(false);
  expect(status.terms.version).toBe('v2');
});

test('LC-6 rejects an invalid documentType', async () => {
  await db.collection('users').doc('uid_lc6').set({ role: 'patient' });
  await expect(
    acceptAccountLegalDocument({
      auth: { uid: 'uid_lc6' },
      data: { documentType: 'merchant_agreement' },
    })
  ).rejects.toThrow();
});

test('LC-7 rejects an unauthenticated call', async () => {
  await expect(getAccountLegalStatus({ auth: null, data: {} })).rejects.toThrow();
  await expect(
    acceptAccountLegalDocument({ auth: null, data: { documentType: 'terms' } })
  ).rejects.toThrow();
});
