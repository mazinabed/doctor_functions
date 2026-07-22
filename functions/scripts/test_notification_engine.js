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
require('../lib/notificationPlatform/workflows/prescriptionWorkflow');
require('../lib/notificationPlatform/workflows/labOrderWorkflow');
require('../lib/notificationPlatform/workflows/appointmentWorkflow');
const { _deriveToStage } = require('../notifications/onAppointmentStatusUpdated');

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

  // 6) Prescription workflow (Phase 3 migration) -- three transitions that
  // previously each wrote their OWN document (rx_received_/rx_ready_/
  // rx_dispensed_<id>) must now collapse into ONE stable document.
  const rxRequestId = 'rx_request_1';
  const rxNotifKey = `users/${recipientUid}/notifications/wf_prescription_${rxRequestId}`;
  for (const stage of ['received', 'ready', 'dispensed']) {
    await emitWorkflowEvent(db, {
      workflowType: 'prescription',
      entityId: rxRequestId,
      recipientUid,
      toStage: stage,
      contentContext: { partnerNameEn: 'Test Pharmacy', partnerNameAr: 'صيدلية الاختبار', toStage: stage },
    });
  }
  const totalRxDocs = Array.from(db._dump().keys()).filter((k) => k.includes(rxRequestId)).length;
  assert.strictEqual(totalRxDocs, 1, 'exactly ONE notification document should exist across all 3 prescription stages');
  const rxFinal = db._dump().get(rxNotifKey);
  assert.strictEqual(rxFinal.currentStage, 'dispensed');
  assert.strictEqual(rxFinal.type, 'rx_status', 'legacy `type` field must be present for the current app');
  assert.strictEqual(rxFinal.subtype, 'dispensed');
  assert.strictEqual(rxFinal.clinicalRequestId, rxRequestId, 'legacy `clinicalRequestId` field must be present for existing tap-to-navigate routing');
  assert.strictEqual(rxFinal.isCompleted, true);

  // 7) Lab workflow (Phase 3 migration) -- 'cancelled' and 'rejected' are
  // distinct stage keys sharing the same content builder; both must be
  // marked isCancelled and produce real content.
  const labRequestId = 'lab_request_1';
  const labNotifKey = `users/${recipientUid}/notifications/wf_lab_order_${labRequestId}`;
  await emitWorkflowEvent(db, {
    workflowType: 'lab_order',
    entityId: labRequestId,
    recipientUid,
    toStage: 'scheduled',
    contentContext: { providerNameEn: 'Test Lab', providerNameAr: 'مختبر الاختبار', toStage: 'scheduled' },
  });
  const labConfirmed = db._dump().get(labNotifKey);
  assert.strictEqual(labConfirmed.subtype, 'confirmed', 'legacy `subtype` must map scheduled -> confirmed');

  await emitWorkflowEvent(db, {
    workflowType: 'lab_order',
    entityId: labRequestId,
    recipientUid,
    toStage: 'rejected',
    contentContext: { providerNameEn: 'Test Lab', providerNameAr: 'مختبر الاختبار', reason: 'Fully booked', toStage: 'rejected' },
  });
  const labRejected = db._dump().get(labNotifKey);
  assert.strictEqual(labRejected.currentStage, 'rejected');
  assert.strictEqual(labRejected.isCancelled, true);
  assert.strictEqual(labRejected.subtype, 'cancelled', 'legacy `subtype` must map both cancelled and rejected -> cancelled');
  assert.ok(labRejected.bodyEn.includes('Fully booked'), 'the per-instance reason must be threaded into the content');
  const totalLabDocs = Array.from(db._dump().keys()).filter((k) => k.includes(labRequestId)).length;
  assert.strictEqual(totalLabDocs, 1, 'exactly ONE notification document should exist across both lab stages');

  // 8) Appointment workflow (Phase 4) -- genuinely NEW notification-emitting
  // capability (no equivalent existed before), but must follow the exact
  // same collapse-to-one-document/legacy-field/terminal-flag behavior as
  // the other three workflows.
  const apptId = 'appt_1';
  const apptNotifKey = `users/${recipientUid}/notifications/wf_appointment_${apptId}`;
  await emitWorkflowEvent(db, {
    workflowType: 'appointment',
    entityId: apptId,
    recipientUid,
    toStage: 'confirmed',
    contentContext: { doctorNameEn: 'Dr. Test', doctorNameAr: 'د. اختبار', toStage: 'confirmed' },
  });
  const apptConfirmed = db._dump().get(apptNotifKey);
  assert.strictEqual(apptConfirmed.type, 'appointment_status', 'legacy `type` field must be present');
  assert.strictEqual(apptConfirmed.appointmentId, apptId, 'legacy `appointmentId` field must be present for existing routing conventions');
  assert.strictEqual(apptConfirmed.isCancelled, false);

  await emitWorkflowEvent(db, {
    workflowType: 'appointment',
    entityId: apptId,
    recipientUid,
    toStage: 'done',
    contentContext: { doctorNameEn: 'Dr. Test', doctorNameAr: 'د. اختبار', toStage: 'done' },
  });
  const apptDone = db._dump().get(apptNotifKey);
  assert.strictEqual(apptDone.currentStage, 'done');
  assert.strictEqual(apptDone.isCompleted, true);
  const totalApptDocs = Array.from(db._dump().keys()).filter((k) => k.includes(apptId)).length;
  assert.strictEqual(totalApptDocs, 1, 'exactly ONE notification document should exist across both appointment stages');

  // 9) onAppointmentStatusUpdated's deriveToStage -- the adapter-level logic
  // that must emit exactly ONE stage even when a single write changes BOTH
  // status and visitStatus at once (visitStatus 'done' also flips status to
  // 'completed' -- appointment_lifecycle_controller.dart's updateVisitStatus).
  assert.strictEqual(
    _deriveToStage({ status: 'confirmed', visitStatus: 'in_service' }, { status: 'completed', visitStatus: 'done' }),
    'done',
    'a combined status+visitStatus write (visit completion) must resolve to exactly one stage: done',
  );
  assert.strictEqual(
    _deriveToStage({ status: 'pending', visitStatus: undefined }, { status: 'confirmed', visitStatus: undefined }),
    'confirmed',
  );
  assert.strictEqual(
    _deriveToStage({ status: 'confirmed', visitStatus: 'waiting' }, { status: 'confirmed', visitStatus: 'in_service' }),
    'in_service',
  );
  assert.strictEqual(
    _deriveToStage({ status: 'confirmed', visitStatus: 'waiting' }, { status: 'cancelled', visitStatus: 'waiting' }),
    'cancelled',
  );
  assert.strictEqual(
    _deriveToStage({ status: 'confirmed', visitStatus: 'waiting' }, { status: 'confirmed', visitStatus: 'no_show' }),
    'no_show',
  );
  assert.strictEqual(
    _deriveToStage({ status: 'confirmed', visitStatus: 'waiting' }, { status: 'confirmed', visitStatus: 'waiting' }),
    null,
    'no change in either field must derive no stage at all',
  );

  console.log('All notification engine assertions passed.');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
