'use strict';

/**
 * Legal Consent Modernization — v2 rollout explicit scenario matrix
 * (2026-08-08), mapped one-to-one to the test list the v2 launch was
 * required to satisfy. Exercises the REAL handlers
 * (functions/legal/legalConsent.js, functions/legal/facilityLegalConsent.js)
 * against the Firestore emulator — same convention as every other
 * *_integration.test.js in this suite.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest legal_v2_rollout_scenarios --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  _getAccountLegalStatusHandler: getAccountLegalStatus,
  _acceptAccountLegalDocumentHandler: acceptAccountLegalDocument,
} = require('../functions/legal/legalConsent');
const {
  _getFacilityLegalStatusHandler: getFacilityLegalStatus,
  _acceptFacilityLegalAgreementHandler: acceptFacilityLegalAgreement,
} = require('../functions/legal/facilityLegalConsent');
const { DEFAULT_LEGAL_CONFIG } = require('../functions/legal/legalConfig');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('platformConfig');
  await clearCollection('users');
  await clearCollection('medical_centers');
  await clearCollection('pharmacy_providers');
  await clearCollection('diagnostic_providers');
});

afterAll(async () => {
  await admin.app().delete();
});

test('V2-0 the live default config is actually v2 for all six documents (sanity check the rollout config itself)', () => {
  expect(DEFAULT_LEGAL_CONFIG).toEqual({
    patientTermsVersion: 'v2',
    providerTermsVersion: 'v2',
    privacyVersion: 'v2',
    medicalCenterAgreementVersion: 'v2',
    pharmacyAgreementVersion: 'v2',
    labAgreementVersion: 'v2',
  });
});

test('V2-1 existing Patient with a legacy v1-era flat legalAccepted flag must still accept v2 (legacy field never satisfies it)', async () => {
  await db.collection('users').doc('uid_v2_existing_patient').set({
    role: 'patient',
    // The old flat single-flag system this replaces.
    legalAccepted: true,
    legalVersion: 'v1',
  });

  const { status } = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_existing_patient' },
    data: {},
  });

  expect(status.terms.current).toBe(false);
  expect(status.terms.version).toBe('v2');
  expect(status.privacy.current).toBe(false);
});

test('V2-2 new Patient (no user doc at all yet) must accept v2', async () => {
  const { status } = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_new_patient' },
    data: {},
  });

  expect(status.terms.current).toBe(false);
  expect(status.terms.version).toBe('v2');
});

test('V2-3 existing Provider (doctor) with a legacy v1-era flag must still accept v2', async () => {
  await db.collection('users').doc('uid_v2_existing_doctor').set({
    role: 'doctor',
    legalAccepted: true,
    legalVersion: 'v1',
  });

  const { status } = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_existing_doctor' },
    data: {},
  });

  expect(status.terms.current).toBe(false);
  expect(status.terms.version).toBe('v2');
});

test('V2-4 new Provider (no user doc at all yet) must accept v2', async () => {
  const { status } = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_new_doctor' },
    data: {},
  });

  expect(status.terms.current).toBe(false);
  expect(status.terms.version).toBe('v2');
});

test('V2-5 existing Medical Center — the authorized representative (owner) must accept the applicable v2 agreement', async () => {
  await db.collection('medical_centers').doc('center_v2_5').set({
    ownerId: 'uid_v2_center_owner',
    // Legacy flat flag some centers carry from the old system.
    legalAccepted: true,
  });

  const { status } = await getFacilityLegalStatus({
    auth: { uid: 'uid_v2_center_owner' },
    data: { facilityType: 'medical_center', facilityId: 'center_v2_5' },
  });

  expect(status.current).toBe(false);
  expect(status.version).toBe('v2');
});

test('V2-5b existing Pharmacy — the authorized representative (owner) must accept the applicable v2 agreement', async () => {
  await db.collection('pharmacy_providers').doc('uid_v2_pharm_owner').set({
    userId: 'uid_v2_pharm_owner',
    legalAccepted: true,
  });

  const { status } = await getFacilityLegalStatus({
    auth: { uid: 'uid_v2_pharm_owner' },
    data: { facilityType: 'pharmacy', facilityId: 'uid_v2_pharm_owner' },
  });

  expect(status.current).toBe(false);
  expect(status.version).toBe('v2');
});

test('V2-5c existing Lab/Imaging — the authorized representative (owner) must accept the applicable v2 agreement', async () => {
  await db.collection('diagnostic_providers').doc('uid_v2_lab_owner').set({
    userId: 'uid_v2_lab_owner',
    legalAccepted: true,
  });

  const { status } = await getFacilityLegalStatus({
    auth: { uid: 'uid_v2_lab_owner' },
    data: { facilityType: 'lab', facilityId: 'uid_v2_lab_owner' },
  });

  expect(status.current).toBe(false);
  expect(status.version).toBe('v2');
});

test('V2-6 acceptance survives logout/login: a fresh, independent status check after accepting still reports current (no session state involved at all)', async () => {
  await db.collection('users').doc('uid_v2_survive').set({ role: 'patient' });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_survive' },
    data: { documentType: 'terms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_survive' },
    data: { documentType: 'privacy' },
  });

  // Simulates a brand-new session (logout/login): a completely fresh call
  // with no client-side state carried over — the ONLY thing that can make
  // this pass is the Firestore-persisted acceptance record.
  const { status } = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_survive' },
    data: {},
  });

  expect(status.terms.current).toBe(true);
  expect(status.privacy.current).toBe(true);
});

test('V2-7 v2-current acceptance does not repeatedly prompt: repeated status checks after acceptance stay current without re-accepting', async () => {
  await db.collection('users').doc('uid_v2_noprompt').set({ role: 'doctor' });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_noprompt' },
    data: { documentType: 'terms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_noprompt' },
    data: { documentType: 'privacy' },
  });

  for (let i = 0; i < 3; i += 1) {
    const { status } = await getAccountLegalStatus({
      auth: { uid: 'uid_v2_noprompt' },
      data: {},
    });
    expect(status.terms.current).toBe(true);
    expect(status.privacy.current).toBe(true);
  }
});

test('V2-8 a simulated v3 bump of ONE document makes only that document stale, the other stays current', async () => {
  await db.collection('users').doc('uid_v2_partial_bump').set({ role: 'patient' });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_partial_bump' },
    data: { documentType: 'terms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_partial_bump' },
    data: { documentType: 'privacy' },
  });

  // Confirm both are v2-current before the bump.
  const before = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_partial_bump' },
    data: {},
  });
  expect(before.status.terms.current).toBe(true);
  expect(before.status.privacy.current).toBe(true);

  // Simulate publishing v3 of Patient Terms ONLY — Privacy stays at v2.
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v2',
    privacyVersion: 'v2',
    medicalCenterAgreementVersion: 'v2',
    pharmacyAgreementVersion: 'v2',
    labAgreementVersion: 'v2',
  });

  const after = await getAccountLegalStatus({
    auth: { uid: 'uid_v2_partial_bump' },
    data: {},
  });
  expect(after.status.terms.current).toBe(false);
  expect(after.status.terms.version).toBe('v3');
  expect(after.status.privacy.current).toBe(true);
  expect(after.status.privacy.version).toBe('v2');
});

test('V2-8b the same isolation holds for facility agreements: bumping only pharmacyAgreementVersion leaves medicalCenterAgreementVersion unaffected', async () => {
  await db.collection('medical_centers').doc('center_v2_8b').set({ ownerId: 'uid_v2_8b_center' });
  await db.collection('pharmacy_providers').doc('uid_v2_8b_pharm').set({ userId: 'uid_v2_8b_pharm' });

  await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_v2_8b_center' },
    data: { facilityType: 'medical_center', facilityId: 'center_v2_8b' },
  });
  await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_v2_8b_pharm' },
    data: { facilityType: 'pharmacy', facilityId: 'uid_v2_8b_pharm' },
  });

  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v2',
    providerTermsVersion: 'v2',
    privacyVersion: 'v2',
    medicalCenterAgreementVersion: 'v2',
    pharmacyAgreementVersion: 'v3',
    labAgreementVersion: 'v2',
  });

  const centerStatus = await getFacilityLegalStatus({
    auth: { uid: 'uid_v2_8b_center' },
    data: { facilityType: 'medical_center', facilityId: 'center_v2_8b' },
  });
  const pharmacyStatus = await getFacilityLegalStatus({
    auth: { uid: 'uid_v2_8b_pharm' },
    data: { facilityType: 'pharmacy', facilityId: 'uid_v2_8b_pharm' },
  });

  expect(centerStatus.status.current).toBe(true);
  expect(pharmacyStatus.status.current).toBe(false);
  expect(pharmacyStatus.status.version).toBe('v3');
});

test('V2-9 old acceptance remains in history after a version bump and re-acceptance — append-only, never overwritten', async () => {
  await db.collection('users').doc('uid_v2_history').set({ role: 'patient' });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_history' },
    data: { documentType: 'terms', locale: 'en' },
  });

  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v2',
    privacyVersion: 'v2',
    medicalCenterAgreementVersion: 'v2',
    pharmacyAgreementVersion: 'v2',
    labAgreementVersion: 'v2',
  });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_v2_history' },
    data: { documentType: 'terms', locale: 'ar' },
  });

  const historySnap = await db
    .collection('users/uid_v2_history/legalHistory')
    .get();
  const versions = historySnap.docs.map((d) => d.data().version).sort();

  expect(historySnap.size).toBe(2);
  expect(versions).toEqual(['v2', 'v3']);

  // The live field always reflects only the most recent acceptance.
  const userSnap = await db.collection('users').doc('uid_v2_history').get();
  expect(userSnap.data().legalAcceptances.terms.version).toBe('v3');
});

test('V2-9b old facility acceptance history is preserved the same way', async () => {
  await db.collection('pharmacy_providers').doc('uid_v2_9b_pharm').set({ userId: 'uid_v2_9b_pharm' });

  await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_v2_9b_pharm' },
    data: { facilityType: 'pharmacy', facilityId: 'uid_v2_9b_pharm' },
  });

  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v2',
    providerTermsVersion: 'v2',
    privacyVersion: 'v2',
    medicalCenterAgreementVersion: 'v2',
    pharmacyAgreementVersion: 'v3',
    labAgreementVersion: 'v2',
  });

  await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_v2_9b_pharm' },
    data: { facilityType: 'pharmacy', facilityId: 'uid_v2_9b_pharm' },
  });

  const historySnap = await db
    .collection('pharmacy_providers/uid_v2_9b_pharm/legalHistory')
    .get();
  const versions = historySnap.docs.map((d) => d.data().version).sort();

  expect(historySnap.size).toBe(2);
  expect(versions).toEqual(['v2', 'v3']);
});
