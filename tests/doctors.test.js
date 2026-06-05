'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

describe('doctors — reads', () => {
  test('2.1 doctor can read own doctor profile', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'doctors', 'uid_doctor1')));
  });

  test('2.1b patient cannot directly read a doctor profile (uses public_doctors instead)', async () => {
    // Rules were tightened from isSignedIn() to block patient-side direct reads.
    // Patients read safe projections from public_doctors/{uid} only.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'doctors', 'uid_doctor1')));
  });
});

describe('doctors — self-update (critical: subscription fields)', () => {
  test('2.2 doctor can update their own non-protected field (name)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { name_en: 'Dr Ali Updated' })
    );
  });

  test('2.3 doctor cannot self-set isPaidUser', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { isPaidUser: true })
    );
  });

  test('2.4 doctor cannot self-set subscriptionStatus', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { subscriptionStatus: 'active' })
    );
  });

  test('2.4b doctor cannot self-set verificationStatus', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { verificationStatus: 'verified' })
    );
  });

  test('2.4c doctor cannot self-set isActive', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { isActive: false })
    );
  });

  test('2.4d doctor cannot self-set canBook', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { canBook: true })
    );
  });
});

describe('doctors — admin updates', () => {
  test('2.5 admin can update doctor subscription fields', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), {
        isPaidUser: true,
        subscriptionStatus: 'active',
        isActive: true,
        canBook: true,
      })
    );
  });

  test('2.6 doctor cannot update another doctor profile', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor2'), { name_en: 'Hacked' })
    );
  });
});
