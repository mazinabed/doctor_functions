'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedDatabase(testEnv);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'pharmacy_providers', 'uid_pharmacy_owner'), {
      userId: 'uid_pharmacy_owner',
      status: 'active',
      isActive: true,
      isVerified: true,
      facilityName_en: 'Test Pharmacy',
    });
    await setDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner'), {
      userId: 'uid_lab_owner',
      status: 'active',
      isActive: true,
      isVerified: true,
      facilityName_en: 'Test Lab',
    });
  });
});
afterAll(async () => { await testEnv.cleanup(); });

describe('medical_centers/{centerId}.legalAcceptances — server-only in both directions', () => {
  test('doctor cannot create a center with legalAcceptances forged on the way in', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers', 'new_center'), {
        ownerId: 'uid_doctor1',
        isActive: true,
        legalAcceptances: { medicalCenterAgreement: { accepted: true, version: 'v999-forged' } },
      })
    );
  });

  test('center owner cannot update legalAcceptances directly', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        legalAcceptances: { medicalCenterAgreement: { accepted: true, version: 'v999-forged' } },
      })
    );
  });

  test('scoped center_admin member cannot update legalAcceptances directly', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        legalAcceptances: { medicalCenterAgreement: { accepted: true, version: 'v999-forged' } },
      })
    );
  });

  test('admin cannot write legalAcceptances either — no client path at all', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        legalAcceptances: { medicalCenterAgreement: { accepted: true, version: 'v1' } },
      })
    );
  });

  test('regression: center owner can still update an ordinary field (name_en)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(updateDoc(doc(db, 'medical_centers', 'center1'), { name_en: 'Renamed Center' }));
  });
});

describe('pharmacy_providers/{uid}.legalAcceptances — server-only in both directions', () => {
  test('owner cannot create with legalAcceptances forged on the way in', async () => {
    const db = testEnv.authenticatedContext('uid_newpharm').firestore();
    await assertFails(
      setDoc(doc(db, 'pharmacy_providers', 'uid_newpharm'), {
        userId: 'uid_newpharm',
        status: 'pending',
        isActive: false,
        isVerified: false,
        legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v999-forged' } },
      })
    );
  });

  test('owner cannot update legalAcceptances directly', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_owner').firestore();
    await assertFails(
      updateDoc(doc(db, 'pharmacy_providers', 'uid_pharmacy_owner'), {
        legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v999-forged' } },
      })
    );
  });

  test('admin cannot write legalAcceptances either', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'pharmacy_providers', 'uid_pharmacy_owner'), {
        legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v1' } },
      })
    );
  });

  test('regression: owner can still update an ordinary field (facilityName_en)', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_owner').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'pharmacy_providers', 'uid_pharmacy_owner'), { facilityName_en: 'Renamed Pharmacy' })
    );
  });
});

describe('diagnostic_providers/{uid}.legalAcceptances — server-only in both directions', () => {
  test('owner cannot update legalAcceptances directly', async () => {
    const db = testEnv.authenticatedContext('uid_lab_owner').firestore();
    await assertFails(
      updateDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner'), {
        legalAcceptances: { labAgreement: { accepted: true, version: 'v999-forged' } },
      })
    );
  });

  test('admin cannot write legalAcceptances either', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner'), {
        legalAcceptances: { labAgreement: { accepted: true, version: 'v1' } },
      })
    );
  });

  test('regression: owner can still update an ordinary field (facilityName_en)', async () => {
    const db = testEnv.authenticatedContext('uid_lab_owner').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner'), { facilityName_en: 'Renamed Lab' })
    );
  });
});

describe('facility legalHistory subcollections — append-only, server-only in both directions', () => {
  test('medical_centers/{centerId}/legalHistory: owner cannot read or write', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(getDoc(doc(db, 'medical_centers/center1/legalHistory', 'hist1')));
    await assertFails(
      setDoc(doc(db, 'medical_centers/center1/legalHistory', 'hist1'), { documentType: 'medicalCenterAgreement', version: 'v999' })
    );
  });

  test('pharmacy_providers/{uid}/legalHistory: owner cannot read or write', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_owner').firestore();
    await assertFails(getDoc(doc(db, 'pharmacy_providers/uid_pharmacy_owner/legalHistory', 'hist1')));
    await assertFails(
      setDoc(doc(db, 'pharmacy_providers/uid_pharmacy_owner/legalHistory', 'hist1'), { documentType: 'pharmacyAgreement', version: 'v999' })
    );
  });

  test('diagnostic_providers/{uid}/legalHistory: owner cannot read or write', async () => {
    const db = testEnv.authenticatedContext('uid_lab_owner').firestore();
    await assertFails(getDoc(doc(db, 'diagnostic_providers/uid_lab_owner/legalHistory', 'hist1')));
    await assertFails(
      setDoc(doc(db, 'diagnostic_providers/uid_lab_owner/legalHistory', 'hist1'), { documentType: 'labAgreement', version: 'v999' })
    );
  });
});
