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
    await setDoc(doc(db, 'marketplace_orders', 'order1'), {
      orderId: 'order1',
      patientId: 'uid_patient1',
      orgId: 'hc_pharmacy_uid_pharmacy1',
      pharmacyOwnerUid: 'uid_pharmacy_owner1',
      status: 'confirmed',
      fulfillmentStatus: 'new',
      order: { engineId: '42', status: 'confirmed', amountTotal: 5000 },
    });
    // Pharmacy Operations Dashboard (Phase 1) fixtures — owner + one active
    // staff member, matching the real pharmacy_providers/{uid} doc-id-is-
    // owner-uid convention isPharmacyOwner/isPharmacyMember rely on.
    await setDoc(doc(db, 'pharmacy_providers', 'uid_pharmacy_owner1'), {
      userId: 'uid_pharmacy_owner1',
    });
    await setDoc(
      doc(db, 'pharmacy_providers', 'uid_pharmacy_owner1', 'pharmacy_members', 'uid_pharmacy_staff1'),
      { uid: 'uid_pharmacy_staff1', role: 'pharmacist', isActive: true, permissions: ['orders', 'orders_fulfillment'] }
    );
    await setDoc(doc(db, 'pharmacy_providers', 'uid_pharmacy_owner2'), {
      userId: 'uid_pharmacy_owner2',
    });
  });
});
afterAll(async () => { await testEnv.cleanup(); });

describe('marketplace_orders collection', () => {
  test('order owner can read their own order', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  test('unrelated signed-in user cannot read another patient order', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  test('admin can read any order', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  test('unauthenticated user cannot read an order', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  // ── Pharmacy Operations Dashboard (Phase 1) read access ─────────────────
  test('the owning pharmacy owner can read the order', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_owner1').firestore();
    await assertSucceeds(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  test('an active staff member of the owning pharmacy can read the order', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_staff1').firestore();
    await assertSucceeds(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  test('a DIFFERENT pharmacy owner cannot read the order', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_owner2').firestore();
    await assertFails(getDoc(doc(db, 'marketplace_orders', 'order1')));
  });

  test('a pharmacy owner cannot write either', async () => {
    const db = testEnv.authenticatedContext('uid_pharmacy_owner1').firestore();
    await assertFails(
      updateDoc(doc(db, 'marketplace_orders', 'order1'), { fulfillmentStatus: 'accepted' })
    );
  });

  test('order owner cannot create their own order doc directly', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'marketplace_orders', 'order2'), {
        orderId: 'order2',
        patientId: 'uid_patient1',
        orgId: 'hc_pharmacy_uid_pharmacy1',
        status: 'pending',
      })
    );
  });

  test('order owner cannot update their own order status (e.g. fake-cancel or fake-confirm)', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'marketplace_orders', 'order1'), { status: 'cancelled' })
    );
  });

  test('admin cannot write either — write is Cloud-Function-only, not even for admins', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'marketplace_orders', 'order1'), { status: 'cancelled' })
    );
  });
});
