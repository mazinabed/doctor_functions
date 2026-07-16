'use strict';

/**
 * Focused test for pharmacyOrderActions.js's authorizePharmacyStaff —
 * exercises the REAL function (functions/commerce/pharmacyOrderActions.js)
 * against the Firestore emulator via firebase-admin, not a duplicate
 * re-implementation of the auth logic. Mirrors
 * marketplace_checkout_guards.test.js's own emulator-connection pattern.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest pharmacy_order_actions_guards --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const { authorizePharmacyStaff } = require('../functions/commerce/pharmacyOrderActions');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('users');
  await clearCollection('pharmacy_providers');

  await db.collection('users').doc('uid_owner1').set({ role: 'pharmacy_provider', name: 'Owner One' });
  await db.collection('pharmacy_providers').doc('uid_owner1').set({ userId: 'uid_owner1' });

  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('pharmacy_members')
    .doc('uid_pharmacist1')
    .set({ role: 'pharmacist', isActive: true, name: 'Pharmacist One' });

  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('pharmacy_members')
    .doc('uid_receptionist1')
    .set({ role: 'receptionist', isActive: true, name: 'Reception One' });

  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('pharmacy_members')
    .doc('uid_inactive1')
    .set({ role: 'pharmacist', isActive: false, name: 'Inactive One' });

  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('pharmacy_members')
    .doc('uid_billing1')
    .set({ role: 'billing', isActive: true, name: 'Billing One' });

  // Explicit permissions array, deliberately WITHOUT orders_intake, to
  // verify a stored array always wins over defaultsForRole (even if the
  // stored array predates the orders_intake key existing at all).
  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('pharmacy_members')
    .doc('uid_custom1')
    .set({ role: 'manager', isActive: true, name: 'Custom Manager', permissions: ['orders'] });
});

afterAll(async () => {
  await admin.app().delete();
});

describe('authorizePharmacyStaff', () => {
  test('owner is always authorized regardless of requiredPermission', async () => {
    const result = await authorizePharmacyStaff(db, 'uid_owner1', 'uid_owner1', 'orders_fulfillment');
    expect(result.actorName).toBe('Owner One');
  });

  test('pharmacist (default permissions) is authorized for orders_fulfillment', async () => {
    const result = await authorizePharmacyStaff(db, 'uid_pharmacist1', 'uid_owner1', 'orders_fulfillment');
    expect(result.actorName).toBe('Pharmacist One');
  });

  test('pharmacist (default permissions) is NOT authorized for orders_intake', async () => {
    await expect(
      authorizePharmacyStaff(db, 'uid_pharmacist1', 'uid_owner1', 'orders_intake'),
    ).rejects.toThrow(/permission/i);
  });

  test('receptionist (default permissions) is authorized for orders (view) but not orders_fulfillment', async () => {
    await expect(
      authorizePharmacyStaff(db, 'uid_receptionist1', 'uid_owner1', 'orders_fulfillment'),
    ).rejects.toThrow(/permission/i);
  });

  test('billing (default permissions) has no order permissions at all', async () => {
    await expect(
      authorizePharmacyStaff(db, 'uid_billing1', 'uid_owner1', 'orders'),
    ).rejects.toThrow(/permission/i);
  });

  test('inactive staff member is rejected outright', async () => {
    await expect(
      authorizePharmacyStaff(db, 'uid_inactive1', 'uid_owner1', 'orders_fulfillment'),
    ).rejects.toThrow(/active member/i);
  });

  test('an explicit stored permissions array wins over defaultsForRole (manager without orders_intake)', async () => {
    await expect(
      authorizePharmacyStaff(db, 'uid_custom1', 'uid_owner1', 'orders_intake'),
    ).rejects.toThrow(/permission/i);
    const result = await authorizePharmacyStaff(db, 'uid_custom1', 'uid_owner1', 'orders');
    expect(result.actorName).toBe('Custom Manager');
  });

  test('a caller with no membership at all is rejected', async () => {
    await expect(
      authorizePharmacyStaff(db, 'uid_stranger1', 'uid_owner1', 'orders'),
    ).rejects.toThrow(/active member/i);
  });

  test('a null pharmacyOwnerUid (order with no pharmacy scope) is rejected', async () => {
    await expect(authorizePharmacyStaff(db, 'uid_owner1', null, 'orders')).rejects.toThrow(/pharmacy scope/i);
  });
});
