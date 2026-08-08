'use strict';

/**
 * Legal Consent Modernization (Phase 3) — integration smoke test for
 * resolveHealthcareLegalCoverage, the Healthcare→Commerce bridge
 * entitlement function inside resolveAccessContext.js. Exercises the real
 * Firestore reads against the emulator via firebase-admin, same
 * direct-module-require convention as the other legal integration tests
 * in this suite.
 *
 * This test deliberately does NOT touch users/{uid}.centerId anywhere —
 * proving the medical_center resolution path is independent of that
 * field, which is the known-unreliable indirection this bridge was
 * explicitly built to avoid.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest healthcare_legal_coverage_bridge_integration --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const { resolveHealthcareLegalCoverage } = require('../functions/commerce/resolveAccessContext');

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

test('HB-1 pharmacy owner with a current Pharmacy Agreement acceptance resolves current:true', async () => {
  await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v2' });
  await db.collection('pharmacy_providers').doc('uid_hb_pharm1').set({
    userId: 'uid_hb_pharm1',
    legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v2' } },
  });

  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_pharm1',
    role: 'pharmacy_provider',
    isPharmacyStaff: false,
    pharmacyStaffPharmacyId: null,
  });

  expect(coverage).toEqual({ facilityType: 'pharmacy', current: true, version: 'v2' });
});

test('HB-2 pharmacy owner with a STALE acceptance (version bumped since) resolves current:false, fails closed', async () => {
  await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v3' });
  await db.collection('pharmacy_providers').doc('uid_hb_pharm2').set({
    userId: 'uid_hb_pharm2',
    legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v2' } },
  });

  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_pharm2',
    role: 'pharmacy_provider',
    isPharmacyStaff: false,
    pharmacyStaffPharmacyId: null,
  });

  expect(coverage.current).toBe(false);
  expect(coverage.version).toBe('v3');
});

test('HB-3 pharmacy staff caller resolves coverage against the OWNER pharmacy doc (pharmacyStaffPharmacyId), not their own uid', async () => {
  await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v1' });
  await db.collection('pharmacy_providers').doc('uid_hb_pharmowner3').set({
    userId: 'uid_hb_pharmowner3',
    legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v1' } },
  });

  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_staff3',
    role: 'doctor', // staff's own role is irrelevant; isPharmacyStaff drives this path
    isPharmacyStaff: true,
    pharmacyStaffPharmacyId: 'uid_hb_pharmowner3',
  });

  expect(coverage).toEqual({ facilityType: 'pharmacy', current: true, version: 'v1' });
});

test('HB-4 diagnostic_provider (lab) resolves against diagnostic_providers, never medical_centers', async () => {
  await db.collection('platformConfig').doc('legal').set({ labAgreementVersion: 'v6' });
  await db.collection('diagnostic_providers').doc('uid_hb_lab4').set({
    userId: 'uid_hb_lab4',
    legalAcceptances: { labAgreement: { accepted: true, version: 'v6' } },
  });

  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_lab4',
    role: 'diagnostic_provider',
    isPharmacyStaff: false,
    pharmacyStaffPharmacyId: null,
  });

  expect(coverage).toEqual({ facilityType: 'lab', current: true, version: 'v6' });
});

test('HB-5 a doctor who owns a medical center resolves via ownerId query, with NO users/{uid}.centerId field ever read or required', async () => {
  await db.collection('platformConfig').doc('legal').set({ medicalCenterAgreementVersion: 'v9' });
  await db.collection('medical_centers').doc('hb_center5').set({
    ownerId: 'uid_hb_doctor5',
    legalAcceptances: { medicalCenterAgreement: { accepted: true, version: 'v9' } },
  });
  // Deliberately no users/uid_hb_doctor5 doc at all, and no centerId anywhere.

  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_doctor5',
    role: 'doctor',
    isPharmacyStaff: false,
    pharmacyStaffPharmacyId: null,
  });

  expect(coverage).toEqual({ facilityType: 'medical_center', current: true, version: 'v9' });
});

test('HB-6 a doctor who owns no center resolves facilityType:null, current:false — Commerce falls back to its own Merchant Agreement flow', async () => {
  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_doctor6_no_center',
    role: 'doctor',
    isPharmacyStaff: false,
    pharmacyStaffPharmacyId: null,
  });

  expect(coverage).toEqual({ facilityType: null, current: false, version: null });
});

test('HB-7 a pharmacy facility doc that exists but has never accepted resolves current:false with the required version surfaced', async () => {
  await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v1' });
  await db.collection('pharmacy_providers').doc('uid_hb_pharm7').set({ userId: 'uid_hb_pharm7' });

  const coverage = await resolveHealthcareLegalCoverage({
    db,
    uid: 'uid_hb_pharm7',
    role: 'pharmacy_provider',
    isPharmacyStaff: false,
    pharmacyStaffPharmacyId: null,
  });

  expect(coverage).toEqual({ facilityType: 'pharmacy', current: false, version: 'v1' });
});
