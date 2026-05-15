'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

describe('medical_centers — reads', () => {
  test('5.1 any authenticated user can read a center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'medical_centers', 'center1')));
  });
});

describe('medical_centers — creates', () => {
  test('5.2 doctor can create a center they own', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers', 'center_new'), {
        ownerId:  'uid_doctor1',
        name_en:  'New Center',
        isActive: true,
      })
    );
  });

  test('5.3 patient (non-doctor) cannot create a center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers', 'center_fake'), {
        ownerId:  'uid_patient1',
        name_en:  'Fake Center',
      })
    );
  });
});

describe('medical_centers — updates (critical: billing fields)', () => {
  test('5.4 center owner can update non-billing fields (name)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), { name_en: 'Updated Name' })
    );
  });

  test('5.5 center owner cannot update subscriptionStatus (billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { subscriptionStatus: 'expired' })
    );
  });

  test('5.5b center owner cannot update currentPlan (billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { currentPlan: 'professional' })
    );
  });

  test('5.6 admin can update any billing field', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        subscriptionStatus: 'expired',
        currentPlan:        'solo',
      })
    );
  });
});

describe('medical_centers — members subcollection', () => {
  test('5.7 center member can read the members list', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      getDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'))
    );
  });

  test('5.8 center member (non-owner) cannot add new members', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_intruder'), {
        role: 'receptionist',
      })
    );
  });

  test('5.9 center owner can add new members', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_newstaff'), {
        role: 'receptionist',
      })
    );
  });
});
