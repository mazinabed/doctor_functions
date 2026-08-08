'use strict';

/**
 * Legal Consent Modernization (Phase 2) — integration smoke test for the
 * ACTUAL getFacilityLegalStatus / acceptFacilityLegalAgreement handler
 * logic (not just the security-rules boundary, covered in
 * facility_legal_consent_rules.test.js). Same direct-handler-against-emulator
 * convention as legal_consent_integration.test.js.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest facility_legal_consent_integration --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  _getFacilityLegalStatusHandler: getFacilityLegalStatus,
  _acceptFacilityLegalAgreementHandler: acceptFacilityLegalAgreement,
} = require('../functions/legal/facilityLegalConsent');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('platformConfig');
  await clearCollection('medical_centers');
  await clearCollection('pharmacy_providers');
  await clearCollection('diagnostic_providers');
});

afterAll(async () => {
  await admin.app().delete();
});

test('FL-1 center owner accepts the Medical Center Agreement: stamps medicalCenterAgreementVersion and legalHistory', async () => {
  await db.collection('platformConfig').doc('legal').set({ medicalCenterAgreementVersion: 'v4' });
  await db.collection('medical_centers').doc('fl_center1').set({ ownerId: 'uid_fl_owner1' });

  const result = await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_fl_owner1' },
    data: { facilityType: 'medical_center', facilityId: 'fl_center1', locale: 'ku' },
  });
  expect(result.version).toBe('v4');

  const centerSnap = await db.collection('medical_centers').doc('fl_center1').get();
  const acceptance = centerSnap.data().legalAcceptances.medicalCenterAgreement;
  expect(acceptance.accepted).toBe(true);
  expect(acceptance.version).toBe('v4');
  expect(acceptance.acceptedBy).toBe('uid_fl_owner1');

  const historySnap = await db.collection('medical_centers/fl_center1/legalHistory').get();
  expect(historySnap.size).toBe(1);
  expect(historySnap.docs[0].data().locale).toBe('ku');

  const { status } = await getFacilityLegalStatus({
    auth: { uid: 'uid_fl_owner1' },
    data: { facilityType: 'medical_center', facilityId: 'fl_center1' },
  });
  expect(status.current).toBe(true);
  expect(status.version).toBe('v4');
});

test('FL-2 a scoped center_admin member (non-owner) may also accept the Medical Center Agreement', async () => {
  await db.collection('platformConfig').doc('legal').set({ medicalCenterAgreementVersion: 'v1' });
  await db.collection('medical_centers').doc('fl_center2').set({ ownerId: 'uid_fl_owner2' });
  await db
    .collection('medical_centers')
    .doc('fl_center2')
    .collection('members')
    .doc('uid_fl_admin2')
    .set({ uid: 'uid_fl_admin2', role: 'center_admin', isActive: true });

  const result = await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_fl_admin2' },
    data: { facilityType: 'medical_center', facilityId: 'fl_center2' },
  });
  expect(result.version).toBe('v1');
});

test('FL-3 a non-owner, non-admin center member is rejected', async () => {
  await db.collection('medical_centers').doc('fl_center3').set({ ownerId: 'uid_fl_owner3' });
  await db
    .collection('medical_centers')
    .doc('fl_center3')
    .collection('members')
    .doc('uid_fl_receptionist3')
    .set({ uid: 'uid_fl_receptionist3', role: 'receptionist', isActive: true });

  await expect(
    acceptFacilityLegalAgreement({
      auth: { uid: 'uid_fl_receptionist3' },
      data: { facilityType: 'medical_center', facilityId: 'fl_center3' },
    })
  ).rejects.toThrow();
});

test('FL-4 pharmacy owner accepts the Pharmacy Agreement, stamped with pharmacyAgreementVersion (not the center agreement version)', async () => {
  await db.collection('platformConfig').doc('legal').set({
    medicalCenterAgreementVersion: 'v4',
    pharmacyAgreementVersion: 'v2',
  });
  await db.collection('pharmacy_providers').doc('uid_fl_pharmowner').set({ userId: 'uid_fl_pharmowner' });

  const result = await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_fl_pharmowner' },
    data: { facilityType: 'pharmacy', facilityId: 'uid_fl_pharmowner' },
  });
  expect(result.version).toBe('v2');
  expect(result.documentType).toBe('pharmacyAgreement');
});

test('FL-5 a pharmacy staff member with pharmacy_admin role may accept on the owner\'s behalf', async () => {
  await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v3' });
  await db.collection('pharmacy_providers').doc('fl_pharm5').set({ userId: 'uid_fl_pharmowner5' });
  await db
    .collection('pharmacy_providers')
    .doc('fl_pharm5')
    .collection('pharmacy_members')
    .doc('uid_fl_pharmadmin5')
    .set({ uid: 'uid_fl_pharmadmin5', role: 'pharmacy_admin', isActive: true });

  const result = await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_fl_pharmadmin5' },
    data: { facilityType: 'pharmacy', facilityId: 'fl_pharm5' },
  });
  expect(result.version).toBe('v3');
});

test('FL-6 lab owner accepts the Lab/Imaging Agreement', async () => {
  await db.collection('platformConfig').doc('legal').set({ labAgreementVersion: 'v5' });
  await db.collection('diagnostic_providers').doc('uid_fl_labowner').set({ userId: 'uid_fl_labowner' });

  const result = await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_fl_labowner' },
    data: { facilityType: 'lab', facilityId: 'uid_fl_labowner' },
  });
  expect(result.version).toBe('v5');
  expect(result.documentType).toBe('labAgreement');
});

test('FL-7 a random uninvolved caller is rejected for any facility type', async () => {
  await db.collection('diagnostic_providers').doc('uid_fl_labowner7').set({ userId: 'uid_fl_labowner7' });

  await expect(
    acceptFacilityLegalAgreement({
      auth: { uid: 'uid_fl_stranger7' },
      data: { facilityType: 'lab', facilityId: 'uid_fl_labowner7' },
    })
  ).rejects.toThrow();
});

test('FL-8 rejects an invalid facilityType', async () => {
  await expect(
    acceptFacilityLegalAgreement({
      auth: { uid: 'uid_fl_anyone' },
      data: { facilityType: 'imaging_center', facilityId: 'whatever' },
    })
  ).rejects.toThrow();
});

test('FL-9 rejects an unauthenticated call', async () => {
  await expect(
    getFacilityLegalStatus({ auth: null, data: { facilityType: 'lab', facilityId: 'x' } })
  ).rejects.toThrow();
});

test('FL-10 a stale acceptance is reported as not current after a version bump, and facility types do not cross-contaminate', async () => {
  await db.collection('platformConfig').doc('legal').set({
    medicalCenterAgreementVersion: 'v1',
    pharmacyAgreementVersion: 'v1',
  });
  await db.collection('medical_centers').doc('fl_center10').set({ ownerId: 'uid_fl_owner10' });
  await acceptFacilityLegalAgreement({
    auth: { uid: 'uid_fl_owner10' },
    data: { facilityType: 'medical_center', facilityId: 'fl_center10' },
  });

  await db.collection('platformConfig').doc('legal').set({
    medicalCenterAgreementVersion: 'v2',
    pharmacyAgreementVersion: 'v1',
  });

  const { status } = await getFacilityLegalStatus({
    auth: { uid: 'uid_fl_owner10' },
    data: { facilityType: 'medical_center', facilityId: 'fl_center10' },
  });
  expect(status.current).toBe(false);
  expect(status.version).toBe('v2');
});
