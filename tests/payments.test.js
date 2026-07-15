'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
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

  // ── Phase 1B (Commerce Billing) — confirms the EXISTING generic payment
  // rules already support a product-discriminated Commerce payment doc with
  // ZERO rules changes: create only checks uid==auth.uid, and the
  // awaiting_transfer→under_review "I Paid" transition only checks uid +
  // status + the affected-keys allowlist — none of that is payerType-specific.
  test('6.10 owner can create a Commerce-discriminated payment doc for their own center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        payerType: 'pharmacy',
        product: 'commerce',
        uid: 'uid_doctor1',
        userId: 'uid_doctor1',
        centerId: 'center1',
        commercePlanId: 'starter',
        commercePlanVersion: 1,
        billingCycle: 'monthly',
        amountIQD: 40000,
        expectedAmountIQD: 40000,
        currency: 'IQD',
        provider: 'zaincash_manual',
        status: 'awaiting_transfer',
        paymentCode: 'TD-1234',
      })
    );
  });

  test('6.11 unrelated user cannot create a Commerce payment doc for someone else\'s uid', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        payerType: 'pharmacy',
        product: 'commerce',
        uid: 'uid_doctor1',
        userId: 'uid_doctor1',
        centerId: 'center1',
        status: 'awaiting_transfer',
      })
    );
  });

  test('6.12 owner can confirm "I Paid" (awaiting_transfer -> under_review) on a Commerce payment', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        payerType: 'pharmacy',
        product: 'commerce',
        uid: 'uid_doctor1',
        userId: 'uid_doctor1',
        centerId: 'center1',
        status: 'awaiting_transfer',
      });
    });
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        status: 'under_review',
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
    );
  });

  test('6.12b owner can confirm "I Paid" WITH an optional referenceNumber', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        payerType: 'pharmacy',
        product: 'commerce',
        uid: 'uid_doctor1',
        userId: 'uid_doctor1',
        centerId: 'center1',
        status: 'awaiting_transfer',
      });
    });
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        status: 'under_review',
        submittedAt: new Date(),
        updatedAt: new Date(),
        referenceNumber: 'ZC-998877',
      })
    );
  });

  test('6.12c "I Paid" still rejects an unrelated extra field (hasOnly still enforced)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        payerType: 'pharmacy',
        product: 'commerce',
        uid: 'uid_doctor1',
        userId: 'uid_doctor1',
        centerId: 'center1',
        status: 'awaiting_transfer',
      });
    });
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        status: 'under_review',
        submittedAt: new Date(),
        updatedAt: new Date(),
        amountIQD: 999999999, // not in the allowlist — must still be rejected
      })
    );
  });

  test('6.13 admin can approve a Commerce payment (status -> completed)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        payerType: 'pharmacy',
        product: 'commerce',
        uid: 'uid_doctor1',
        userId: 'uid_doctor1',
        centerId: 'center1',
        status: 'under_review',
      });
    });
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'payments', 'open_pharmacy_commerce_uid_doctor1'), {
        status: 'completed',
        reviewedAt: new Date(),
        reviewedBy: 'uid_admin',
      })
    );
  });
});
