'use strict';

/**
 * Focused test for pharmacyOrderActions.js's delivery workflow refinement —
 * the new 'readyForDelivery' stage, the Out-for-Delivery driver gate now
 * tied to that stage, and the payment-disposition completion gate.
 * Exercises the REAL exported functions (requireAssignedDeliveryPerson,
 * markReadyOrOutForDelivery, resolvePaymentDisposition) against the
 * Firestore emulator via firebase-admin, not a duplicate re-implementation
 * of the validation logic. Mirrors pharmacy_order_actions_guards.test.js's
 * own emulator-connection pattern.
 *
 * markReadyOrOutForDelivery calls Commerce (getMarketplaceOrderStatusForHealthcare)
 * over a real network fetch once past all the Firestore-only precondition
 * checks — exactly like authorizePharmacyStaff's sibling test file, this
 * suite only exercises the precondition checks that reject BEFORE that
 * network call is ever reached, which is also where every rejection this
 * task cares about happens (the driver gate and the fromStatus check are
 * both ordered before requireLinkedOdooOrder/callCommerce — see
 * pharmacyOrderActions.js). A "valid driver" success is proven at the level
 * of the actual gate function (requireAssignedDeliveryPerson resolving)
 * rather than the full onCall flow, for the same reason.
 * resolvePaymentDisposition is a pure function — no emulator/network
 * dependency at all.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest pharmacy_order_delivery_gate --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  requireAssignedDeliveryPerson,
  markReadyOrOutForDelivery,
  resolvePaymentDisposition,
} = require('../functions/commerce/pharmacyOrderActions');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('users');
  await clearCollection('pharmacy_providers');
  await clearCollection('marketplace_orders');

  await db.collection('users').doc('uid_owner1').set({ role: 'pharmacy_provider', name: 'Owner One' });
  await db.collection('pharmacy_providers').doc('uid_owner1').set({ userId: 'uid_owner1' });
  await db.collection('pharmacy_providers').doc('uid_owner2').set({ userId: 'uid_owner2' });

  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('delivery_personnel')
    .doc('driver_active1')
    .set({ name: 'Active Driver', status: 'active' });

  await db
    .collection('pharmacy_providers')
    .doc('uid_owner1')
    .collection('delivery_personnel')
    .doc('driver_inactive1')
    .set({ name: 'Inactive Driver', status: 'inactive' });

  // Belongs to a DIFFERENT pharmacy — proves a cross-org id never resolves
  // under owner1's own scope, even if it were somehow stored on one of
  // owner1's orders.
  await db
    .collection('pharmacy_providers')
    .doc('uid_owner2')
    .collection('delivery_personnel')
    .doc('driver_other_org1')
    .set({ name: 'Other Org Driver', status: 'active' });
});

afterAll(async () => {
  await admin.app().delete();
});

describe('requireAssignedDeliveryPerson', () => {
  test('rejects when no driver is assigned at all (null)', async () => {
    await expect(requireAssignedDeliveryPerson(db, 'uid_owner1', null)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_not_assigned' },
    });
  });

  test('rejects when the assigned id has no matching record', async () => {
    await expect(requireAssignedDeliveryPerson(db, 'uid_owner1', 'does_not_exist')).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_invalid' },
    });
  });

  test('rejects an inactive driver', async () => {
    await expect(requireAssignedDeliveryPerson(db, 'uid_owner1', 'driver_inactive1')).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_invalid' },
    });
  });

  test('rejects a driver id that only exists under a different pharmacy', async () => {
    await expect(requireAssignedDeliveryPerson(db, 'uid_owner1', 'driver_other_org1')).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_invalid' },
    });
  });

  test('resolves for a valid, active, same-organization driver', async () => {
    await expect(requireAssignedDeliveryPerson(db, 'uid_owner1', 'driver_active1')).resolves.toBeUndefined();
  });
});

describe('markReadyOrOutForDelivery — Ready for Delivery / Out for Delivery stages', () => {
  async function makeOrder(orderId, fulfillmentStatus, overrides) {
    await db
      .collection('marketplace_orders')
      .doc(orderId)
      .set({
        pharmacyOwnerUid: 'uid_owner1',
        fulfillmentStatus,
        deliveryCarrierEngineId: 42,
        fulfillmentStatusHistory: [],
        ...overrides,
      });
  }

  const readyForDeliveryArgs = {
    expectedIsDelivery: true,
    fromStatus: 'preparing',
    toStatus: 'readyForDelivery',
    wrongTypeMessage: 'This is a pickup order.',
    wrongStageMessage: 'This order is not in preparation.',
    requireDriver: false,
  };

  const outForDeliveryArgs = {
    expectedIsDelivery: true,
    fromStatus: 'readyForDelivery',
    toStatus: 'outForDelivery',
    wrongTypeMessage: 'This is a pickup order.',
    wrongStageMessage: 'This order is not ready for delivery yet.',
    requireDriver: true,
  };

  test('preparing -> readyForDelivery never requires a driver (advance assignment stays optional)', async () => {
    await makeOrder('order_ready_for_delivery1', 'preparing', {});
    const request = { auth: { uid: 'uid_owner1' }, data: { orderId: 'order_ready_for_delivery1' } };

    // No driver assigned and no linked Odoo order — if the driver gate ran
    // here it would reject with driver_not_assigned; instead it must reach
    // the pre-existing "no linked Odoo record" check, proving requireDriver:
    // false is honored for this leg.
    await expect(markReadyOrOutForDelivery(request, readyForDeliveryArgs)).rejects.toThrow(
      /no linked Odoo record/i,
    );
  });

  test('an unassigned delivery order cannot go Out for Delivery before any Odoo/Firestore mutation', async () => {
    await makeOrder('order_unassigned1', 'readyForDelivery', {});
    const request = { auth: { uid: 'uid_owner1' }, data: { orderId: 'order_unassigned1' } };

    await expect(markReadyOrOutForDelivery(request, outForDeliveryArgs)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_not_assigned' },
    });

    const snap = await db.collection('marketplace_orders').doc('order_unassigned1').get();
    expect(snap.data().fulfillmentStatus).toBe('readyForDelivery');
    expect(snap.data().fulfillmentStatusHistory).toEqual([]);
  });

  test('a delivery order with an inactive assigned driver is rejected with no partial mutation', async () => {
    await makeOrder('order_inactive_driver1', 'readyForDelivery', {
      assignedDeliveryPersonId: 'driver_inactive1',
      assignedDeliveryPersonName: 'Inactive Driver',
    });
    const request = { auth: { uid: 'uid_owner1' }, data: { orderId: 'order_inactive_driver1' } };

    await expect(markReadyOrOutForDelivery(request, outForDeliveryArgs)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_invalid' },
    });

    const snap = await db.collection('marketplace_orders').doc('order_inactive_driver1').get();
    expect(snap.data().fulfillmentStatus).toBe('readyForDelivery');
    expect(snap.data().fulfillmentStatusHistory).toEqual([]);
  });

  test('a cross-organization assigned driver id is rejected the same as an invalid one', async () => {
    await makeOrder('order_cross_org1', 'readyForDelivery', {
      assignedDeliveryPersonId: 'driver_other_org1',
      assignedDeliveryPersonName: 'Other Org Driver',
    });
    const request = { auth: { uid: 'uid_owner1' }, data: { orderId: 'order_cross_org1' } };

    await expect(markReadyOrOutForDelivery(request, outForDeliveryArgs)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'driver_invalid' },
    });

    const snap = await db.collection('marketplace_orders').doc('order_cross_org1').get();
    expect(snap.data().fulfillmentStatus).toBe('readyForDelivery');
  });

  test('Out for Delivery can no longer be reached directly from preparing (readyForDelivery is now mandatory)', async () => {
    // Even a fully-valid, active, same-org driver assigned — jumping
    // straight from 'preparing' must still fail on the stage check, before
    // the driver gate is ever consulted.
    await makeOrder('order_skip_stage1', 'preparing', {
      assignedDeliveryPersonId: 'driver_active1',
      assignedDeliveryPersonName: 'Active Driver',
    });
    const request = { auth: { uid: 'uid_owner1' }, data: { orderId: 'order_skip_stage1' } };

    await expect(markReadyOrOutForDelivery(request, outForDeliveryArgs)).rejects.toThrow(
      /not ready for delivery yet/i,
    );
  });

  test('pickup order path (expectedIsDelivery: false) is unaffected by the driver gate', async () => {
    // No deliveryCarrierEngineId (pickup) and no driver assigned at all — if
    // the driver gate applied here it would reject with driver_not_assigned;
    // instead it must reach the pre-existing "no linked Odoo record" check,
    // proving the driver gate is skipped entirely for the pickup path.
    await db.collection('marketplace_orders').doc('order_pickup1').set({
      pharmacyOwnerUid: 'uid_owner1',
      fulfillmentStatus: 'preparing',
      deliveryCarrierEngineId: null,
      fulfillmentStatusHistory: [],
    });
    const request = { auth: { uid: 'uid_owner1' }, data: { orderId: 'order_pickup1' } };

    await expect(
      markReadyOrOutForDelivery(request, {
        expectedIsDelivery: false,
        fromStatus: 'preparing',
        toStatus: 'readyForPickup',
        wrongTypeMessage: 'This is a delivery order.',
        wrongStageMessage: 'This order is not in preparation.',
        requireDriver: false,
      }),
    ).rejects.toThrow(/no linked Odoo record/i);
  });
});

describe('resolvePaymentDisposition — Completion payment gate', () => {
  test('rejects a missing/unknown payment method', () => {
    expect(() => resolvePaymentDisposition({})).toThrow(/payment disposition/i);
    expect(() => resolvePaymentDisposition({ paymentMethod: 'paid_online' })).toThrow(/payment disposition/i);
    expect(() => resolvePaymentDisposition({ paymentMethod: 'insurance' })).toThrow(/payment disposition/i);
  });

  test('rejects cash/card/zaincash/qi with a missing or non-positive amount', () => {
    for (const method of ['cash', 'card', 'zaincash', 'qi']) {
      expect(() => resolvePaymentDisposition({ paymentMethod: method })).toThrow(/valid amount/i);
      expect(() => resolvePaymentDisposition({ paymentMethod: method, amountPaid: 0 })).toThrow(/valid amount/i);
      expect(() => resolvePaymentDisposition({ paymentMethod: method, amountPaid: -5 })).toThrow(/valid amount/i);
    }
  });

  test('resolves cash/card/zaincash/qi with a positive amount, trimming receiptRef/paymentNotes', () => {
    const result = resolvePaymentDisposition({
      paymentMethod: 'cash',
      amountPaid: 15000,
      receiptRef: '  R-1029  ',
      paymentNotes: '  paid in full  ',
    });
    expect(result).toEqual({
      paymentMethod: 'cash',
      amountPaid: 15000,
      receiptRef: 'R-1029',
      paymentNotes: 'paid in full',
    });
  });

  test('no_charge never requires or returns an amount', () => {
    const result = resolvePaymentDisposition({ paymentMethod: 'no_charge', paymentNotes: 'goodwill replacement' });
    expect(result.paymentMethod).toBe('no_charge');
    expect(result.amountPaid).toBeUndefined();
    expect(result.paymentNotes).toBe('goodwill replacement');
  });
});
