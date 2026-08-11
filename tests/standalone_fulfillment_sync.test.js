'use strict';

/**
 * Standalone Commerce -> Healthcare Fulfillment Projection Bridge
 * (2026-08-10) — exercises the REAL receiving function
 * (functions/commerce/receiveStandaloneFulfillmentSync.js) against the
 * Firestore emulator via firebase-admin, not a duplicate re-implementation.
 * Mirrors pharmacy_order_actions_guards.test.js's own emulator-connection
 * pattern.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest standalone_fulfillment_sync --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  applyStandaloneFulfillmentSync,
  fromStatusesForTransition,
  whitelistExtraFields,
  RECEIVE_SYNC_OPTIONS,
  COMMERCE_SERVICE_ACCOUNT_EMAIL,
} = require('../functions/commerce/receiveStandaloneFulfillmentSync');

const ORG_ID = 'standalone_org_test1';
const ENGINE_ID = 'ENG-109';
const ORDER_DOC_ID = 'idem_key_test_order_1';

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

async function seedOrder(overrides = {}) {
  await db
    .collection('marketplace_orders')
    .doc(ORDER_DOC_ID)
    .set({
      orgId: ORG_ID,
      order: { engineId: ENGINE_ID, name: 'S00109' },
      patientId: 'uid_patient1',
      fulfillmentStatus: 'new',
      status: 'confirmed',
      ...overrides,
    });
}

function eventFor(toStatus, seq, extraFields) {
  return {
    orgId: ORG_ID,
    engineId: ENGINE_ID,
    eventId: `${ENGINE_ID}_seq${seq}`,
    toStatus,
    fromStatus: 'unused-informational-only',
    actorUid: 'uid_merchant1',
    extraFields,
  };
}

beforeEach(async () => {
  await clearCollection('marketplace_orders');
});

afterAll(async () => {
  await admin.app().delete();
});

describe('receiveStandaloneFulfillmentSync — happy-path transitions', () => {
  test('accepted sync applies and appends history', async () => {
    await seedOrder();
    const result = await applyStandaloneFulfillmentSync(db, eventFor('accepted', 1));
    expect(result.outcome).toBe('applied');
    const snap = await db.collection('marketplace_orders').doc(ORDER_DOC_ID).get();
    expect(snap.get('fulfillmentStatus')).toBe('accepted');
    expect(snap.get('fulfillmentStatusHistory')).toHaveLength(1);
  });

  test('preparing sync applies after accepted', async () => {
    await seedOrder({ fulfillmentStatus: 'accepted' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('preparing', 2));
    expect(result.outcome).toBe('applied');
  });

  test('readyForPickup sync applies after preparing', async () => {
    await seedOrder({ fulfillmentStatus: 'preparing' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('readyForPickup', 3));
    expect(result.outcome).toBe('applied');
  });

  test('readyForDelivery sync applies after preparing', async () => {
    await seedOrder({ fulfillmentStatus: 'preparing' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('readyForDelivery', 3));
    expect(result.outcome).toBe('applied');
  });

  test('outForDelivery sync applies after readyForDelivery', async () => {
    await seedOrder({ fulfillmentStatus: 'readyForDelivery' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('outForDelivery', 4));
    expect(result.outcome).toBe('applied');
  });

  test('completed sync applies after readyForPickup', async () => {
    await seedOrder({ fulfillmentStatus: 'readyForPickup' });
    const result = await applyStandaloneFulfillmentSync(
      db,
      eventFor('completed', 4, { paymentMethod: 'cash', amountPaid: 12.5 }),
    );
    expect(result.outcome).toBe('applied');
    const snap = await db.collection('marketplace_orders').doc(ORDER_DOC_ID).get();
    expect(snap.get('paymentMethod')).toBe('cash');
    expect(snap.get('amountPaid')).toBe(12.5);
  });

  test('completed sync applies after outForDelivery', async () => {
    await seedOrder({ fulfillmentStatus: 'outForDelivery' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('completed', 5, { paymentMethod: 'cash' }));
    expect(result.outcome).toBe('applied');
  });

  test('rejected sync applies from new', async () => {
    await seedOrder();
    const result = await applyStandaloneFulfillmentSync(db, eventFor('rejected', 1));
    expect(result.outcome).toBe('applied');
  });

  test('deliveryFailed sync applies after outForDelivery, whitelists the note', async () => {
    await seedOrder({ fulfillmentStatus: 'outForDelivery' });
    const result = await applyStandaloneFulfillmentSync(
      db,
      eventFor('deliveryFailed', 5, { deliveryFailureNote: 'No answer at door' }),
    );
    expect(result.outcome).toBe('applied');
    const snap = await db.collection('marketplace_orders').doc(ORDER_DOC_ID).get();
    expect(snap.get('deliveryFailureNote')).toBe('No answer at door');
  });
});

describe('receiveStandaloneFulfillmentSync — idempotency and ordering', () => {
  test('duplicate event (same eventId retried) does not duplicate history or re-apply', async () => {
    await seedOrder();
    const event = eventFor('accepted', 1);
    const first = await applyStandaloneFulfillmentSync(db, event);
    expect(first.outcome).toBe('applied');

    const retry = await applyStandaloneFulfillmentSync(db, event);
    expect(retry.outcome).toBe('already_processed');

    const snap = await db.collection('marketplace_orders').doc(ORDER_DOC_ID).get();
    // Exactly one history entry — the duplicate must not have appended a
    // second one, which is also what guarantees the update trigger (and
    // therefore the notification) never fires a second time for a retry.
    expect(snap.get('fulfillmentStatusHistory')).toHaveLength(1);
  });

  test('delayed/out-of-order event: completed already applied, a late preparing event must not regress it', async () => {
    await seedOrder({ fulfillmentStatus: 'completed' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('preparing', 2));
    expect(result.outcome).toBe('stale');
    const snap = await db.collection('marketplace_orders').doc(ORDER_DOC_ID).get();
    expect(snap.get('fulfillmentStatus')).toBe('completed');
  });

  test('a genuinely out-of-order accepted event after rejected is also rejected as stale, never applied', async () => {
    await seedOrder({ fulfillmentStatus: 'rejected' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('accepted', 1));
    expect(result.outcome).toBe('stale');
  });
});

describe('receiveStandaloneFulfillmentSync — correlation and unknown orders', () => {
  test('correlates strictly by orgId + order.engineId, not by engineId alone', async () => {
    await seedOrder({ orgId: 'a_different_org' });
    const result = await applyStandaloneFulfillmentSync(db, eventFor('accepted', 1));
    expect(result.outcome).toBe('not_found');
  });

  test('unknown org/order is rejected safely with not_found, no throw', async () => {
    const result = await applyStandaloneFulfillmentSync(
      db,
      eventFor('accepted', 1),
    );
    expect(result.outcome).toBe('not_found');
  });
});

describe('receiveStandaloneFulfillmentSync — request validation', () => {
  test('fromStatusesForTransition rejects an unrecognized status', () => {
    expect(fromStatusesForTransition('cancelled')).toBeNull();
    expect(fromStatusesForTransition('somethingMadeUp')).toBeNull();
  });

  test('whitelistExtraFields drops any non-whitelisted key', () => {
    const out = whitelistExtraFields({ paymentMethod: 'cash', maliciousField: 'dropTableUsers' });
    expect(out).toEqual({ paymentMethod: 'cash' });
  });
});

describe('receiveStandaloneFulfillmentSync — deployment-config security boundary', () => {
  // The actual security boundary is Cloud Run IAM invoker restriction,
  // enforced before this code ever runs — not something a unit test can
  // exercise directly. This asserts the deploy-time config that IS the
  // boundary is exactly what it must be: never --allow-unauthenticated,
  // restricted to Commerce's own runtime service account.
  test('invoker is restricted to Commerce\'s own runtime service account, never public', () => {
    expect(RECEIVE_SYNC_OPTIONS.invoker).toEqual([COMMERCE_SERVICE_ACCOUNT_EMAIL]);
    expect(RECEIVE_SYNC_OPTIONS.invoker).not.toBe('public');
  });

  test('the service account email is the real trustydr-commerce project number (749624058165), not a placeholder', () => {
    expect(COMMERCE_SERVICE_ACCOUNT_EMAIL).toBe('749624058165-compute@developer.gserviceaccount.com');
  });
});
