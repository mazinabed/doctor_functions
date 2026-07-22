'use strict';

/**
 * Offline regression test for the Notification Engine (Phase 1 of the
 * TrustyDr Workflow & Notification Platform -- see
 * NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root).
 *
 * Unlike test_reminders.js / test_health_weather.js in this same directory
 * (which run against the LIVE database via a service account), this script
 * touches no real or emulated Firestore at all -- it uses a minimal
 * in-memory fake `db` implementing only the `.collection().doc().get()/
 * .set()` chain the engine actually calls, and asserts real behavior with
 * Node's built-in `assert`. Safe to run anywhere, any time; exits non-zero
 * on failure.
 *
 * Usage: node scripts/test_notification_engine.js
 */

const assert = require('assert');
const { emitWorkflowEvent } = require('../lib/notificationPlatform/notificationEngine');
require('../lib/notificationPlatform/workflows/marketplaceOrderWorkflow');

// ─── Minimal in-memory Firestore fake ──────────────────────────────────────
function makeFakeDb() {
  const store = new Map(); // "collection/doc/collection/doc" -> data

  function docRef(pathParts) {
    const key = pathParts.join('/');
    return {
      async get() {
        const data = store.get(key);
        return { exists: !!data, data: () => (data ? { ...data } : undefined) };
      },
      async set(data) {
        // FieldValue.serverTimestamp() sentinels are stored as-is (opaque
        // objects) -- this fake never resolves them to a real timestamp,
        // it only needs to prove they're threaded through/preserved
        // correctly, which reference equality already confirms.
        store.set(key, { ...data });
      },
      collection(name) {
        return collectionRef([...pathParts, name]);
      },
    };
  }

  function collectionRef(pathParts) {
    return {
      doc(id) {
        return docRef([...pathParts, id]);
      },
      async get() {
        // Only used by pushChannel.js for fcmTokens -- return empty so the
        // engine's push dispatch is a safe no-op in this offline test.
        return { empty: true, docs: [] };
      },
    };
  }

  return {
    collection(name) {
      return collectionRef([name]);
    },
    _dump() {
      return store;
    },
  };
}

async function main() {
  const db = makeFakeDb();
  const recipientUid = 'patient_1';
  const orderId = 'order_1';
  const notifKey = `users/${recipientUid}/notifications/wf_marketplace_order_${orderId}`;

  // 1) First transition: new -> accepted.
  await emitWorkflowEvent(db, {
    workflowType: 'marketplace_order',
    entityId: orderId,
    recipientUid,
    toStage: 'accepted',
    contentContext: { storeNameEn: 'Test Pharmacy', storeNameAr: 'صيدلية الاختبار', toStage: 'accepted' },
  });

  const afterFirst = db._dump().get(notifKey);
  assert.ok(afterFirst, 'notification document should exist after first stage');
  assert.strictEqual(afterFirst.currentStage, 'accepted');
  assert.strictEqual(afterFirst.category, 'timeline');
  assert.strictEqual(afterFirst.workflowType, 'marketplace_order');
  assert.strictEqual(afterFirst.type, 'marketplace_order', 'legacy `type` field must be present for the current app');
  assert.strictEqual(afterFirst.subtype, 'accepted', 'legacy `subtype` field must mirror the current stage');
  assert.strictEqual(afterFirst.marketplaceOrderId, orderId, 'legacy `marketplaceOrderId` field must be present');
  assert.strictEqual(afterFirst.isRead, false);
  const createdAt = afterFirst.createdAt;
  assert.ok(createdAt, 'createdAt should be set on first write');

  // 2) Simulate the patient reading it.
  const doc1 = db.collection('users').doc(recipientUid).collection('notifications').doc(`wf_marketplace_order_${orderId}`);
  await doc1.set({ ...afterFirst, isRead: true });

  // 3) Second transition: accepted -> preparing. Must UPDATE the SAME
  // document (the actual spam-fix claim), not create a second one.
  await emitWorkflowEvent(db, {
    workflowType: 'marketplace_order',
    entityId: orderId,
    recipientUid,
    toStage: 'preparing',
    contentContext: { storeNameEn: 'Test Pharmacy', storeNameAr: 'صيدلية الاختبار', toStage: 'preparing' },
  });

  const totalDocsForOrder = Array.from(db._dump().keys()).filter((k) => k.includes(orderId)).length;
  assert.strictEqual(totalDocsForOrder, 1, 'exactly ONE notification document should exist for this order across multiple stages');

  const afterSecond = db._dump().get(notifKey);
  assert.strictEqual(afterSecond.currentStage, 'preparing', 'stage should have advanced on the same document');
  assert.strictEqual(afterSecond.isRead, false, 'isRead must reset to false on a genuine stage change');
  assert.strictEqual(afterSecond.subtype, 'preparing', 'legacy `subtype` must track the new stage too');
  assert.deepStrictEqual(
    afterSecond.createdAt,
    createdAt,
    'createdAt must be preserved across updates (only updatedAt should change)',
  );
  assert.ok(Array.isArray(afterSecond.stagePreview) && afterSecond.stagePreview.length === 2, 'stagePreview should accumulate both transitions');

  // 4) Re-emitting the SAME stage again must be a true no-op (idempotency
  // against a retried trigger) -- isRead must NOT flip back to false if it
  // was already true and the stage didn't actually change.
  await doc1.set({ ...afterSecond, isRead: true });
  await emitWorkflowEvent(db, {
    workflowType: 'marketplace_order',
    entityId: orderId,
    recipientUid,
    toStage: 'preparing',
    contentContext: { storeNameEn: 'Test Pharmacy', storeNameAr: 'صيدلية الاختبار', toStage: 'preparing' },
  });
  const afterReplay = db._dump().get(notifKey);
  assert.strictEqual(afterReplay.isRead, true, 'a repeated same-stage call must be a no-op and must not disturb isRead');

  // 5) A terminal, previously-unhandled stage (deliveryFailed) must now
  // produce a real notification -- confirms the audit-found gap is fixed.
  await emitWorkflowEvent(db, {
    workflowType: 'marketplace_order',
    entityId: orderId,
    recipientUid,
    toStage: 'deliveryFailed',
    contentContext: { storeNameEn: 'Test Pharmacy', storeNameAr: 'صيدلية الاختبار', toStage: 'deliveryFailed' },
  });
  const afterFailure = db._dump().get(notifKey);
  assert.strictEqual(afterFailure.currentStage, 'deliveryFailed');
  assert.strictEqual(afterFailure.isCancelled, true);
  assert.strictEqual(afterFailure.priority, 'critical');
  assert.ok(afterFailure.titleEn && afterFailure.bodyEn, 'deliveryFailed must have real content, not the previous silent gap');

  console.log('All notification engine assertions passed.');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
