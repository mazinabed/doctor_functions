'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

describe('payments collection', () => {
  test('6.1 payment owner can read their own payment', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'payments', 'pay1')));
  });

  test('6.2 unrelated user cannot read another user payment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'payments', 'pay1')));
  });

  test('6.3 admin can read any payment', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'payments', 'pay1')));
  });

  test('6.4 payment owner cannot update their own payment status', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'payments', 'pay1'), { status: 'completed' })
    );
  });

  test('6.5 admin can update payment status to completed', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'payments', 'pay1'), {
        status:     'completed',
        approvedAt: new Date(),
        approvedBy: 'uid_admin',
      })
    );
  });

  // ── Center-scoped billing read tests ─────────────────────────────────────
  // pay_billing_center has centerId: 'billing_center'.
  // billing_center.ownerId == 'uid_billing_owner'.
  // uid_billing_admin is center_admin in members subcollection (NOT ownerId).
  // uid_billing_receptionist is receptionist in members subcollection.

  test('6.6 center owner can read a center payment', async () => {
    const db = testEnv.authenticatedContext('uid_billing_owner').firestore();
    await assertSucceeds(getDoc(doc(db, 'payments', 'pay_billing_center')));
  });

  test('6.7 center_admin member (non-owner) can read a center payment', async () => {
    // Regression test: doctor with role=center_admin in members subcollection
    // but who is NOT the ownerId must be allowed to read billing payments.
    const db = testEnv.authenticatedContext('uid_billing_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'payments', 'pay_billing_center')));
  });

  test('6.8 receptionist member cannot read a center payment', async () => {
    const db = testEnv.authenticatedContext('uid_billing_receptionist').firestore();
    await assertFails(getDoc(doc(db, 'payments', 'pay_billing_center')));
  });

  test('6.9 unrelated user cannot read a center payment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'payments', 'pay_billing_center')));
  });
});
