'use strict';

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getWorkflow } = require('./workflowRegistry');
const { sendPush } = require('./pushChannel');
const { CHANNEL } = require('./constants');

const STAGE_PREVIEW_LIMIT = 5;

/**
 * emitWorkflowEvent -- the ONE entry point every workflow's Cloud Function
 * calls when its entity's stage changes. This engine does not know what a
 * "marketplace order" or "prescription" is; it only knows the
 * WorkflowDefinition registered under `workflowType` (see
 * workflowRegistry.js) and the generic Timeline Notification shape (see
 * NOTIFICATION_PLATFORM_PROGRESS.md's Data Model section).
 *
 * One stable notification document per entity
 * (`wf_{workflowType}_{entityId}`), updated in place on every stage change --
 * never a new document per stage. `isRead` is reset to false on every
 * update: a stage change is new information even if the patient already
 * read the previous stage.
 */
async function emitWorkflowEvent(db, { workflowType, entityId, recipientUid, toStage, contentContext }) {
  if (!recipientUid) {
    console.log(`emitWorkflowEvent: no recipientUid for ${workflowType}/${entityId} -- skipping`);
    return;
  }

  const workflow = getWorkflow(workflowType);
  if (!workflow) {
    console.error(`emitWorkflowEvent: no WorkflowDefinition registered for "${workflowType}"`);
    return;
  }

  const stage = workflow.stages[toStage];
  if (!stage) {
    console.log(
      `emitWorkflowEvent: ${workflowType} has no stage definition for "${toStage}" (${entityId}) -- skipping`,
    );
    return;
  }

  const content = stage.buildContent(contentContext || {});
  const notifId = `wf_${workflowType}_${entityId}`;
  const notifRef = db.collection('users').doc(recipientUid).collection('notifications').doc(notifId);

  const existingSnap = await notifRef.get();
  const existing = existingSnap.exists ? existingSnap.data() : null;

  // Idempotent against re-delivery of the SAME transition (e.g. a retried
  // trigger) -- not against genuinely different stages, which always update.
  if (existing && existing.currentStage === toStage) {
    console.log(`emitWorkflowEvent: ${notifId} already at stage "${toStage}" -- skipping`);
    return;
  }

  const stagePreview = [
    ...(existing && Array.isArray(existing.stagePreview) ? existing.stagePreview : []),
    { stage: toStage, at: Timestamp.now() },
  ].slice(-STAGE_PREVIEW_LIMIT);

  const navigationTarget =
    typeof workflow.navigationTarget === 'function' ? workflow.navigationTarget(entityId) : null;

  const legacyFields =
    typeof workflow.legacyFields === 'function' ? workflow.legacyFields(entityId, contentContext || {}) : {};

  await notifRef.set({
    category: 'timeline',
    workflowType,
    entityType: workflow.entityCollection,
    entityId,
    currentStage: toStage,
    isCompleted: !!stage.isCompleted,
    isCancelled: !!stage.isCancelled,
    priority: stage.priority || 'normal',
    channels: stage.channels || [CHANNEL.PUSH],
    actions: stage.actions || [],
    navigationTarget,
    stagePreview,
    titleEn: content.titleEn,
    titleAr: content.titleAr,
    titleKu: content.titleKu,
    bodyEn: content.bodyEn,
    bodyAr: content.bodyAr,
    bodyKu: content.bodyKu,
    isRead: false,
    dismissed: false,
    createdAt: existing ? existing.createdAt : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...legacyFields,
  });

  console.log(
    `emitWorkflowEvent: ${existing ? 'updated' : 'created'} ${notifId} recipient=${recipientUid} stage=${toStage}`,
  );

  if ((stage.channels || [CHANNEL.PUSH]).includes(CHANNEL.PUSH)) {
    try {
      const fcm = await sendPush(db, recipientUid, {
        titleEn: content.titleEn,
        titleAr: content.titleAr,
        titleKu: content.titleKu,
        bodyEn: content.bodyEn,
        bodyAr: content.bodyAr,
        bodyKu: content.bodyKu,
        dataPayload: legacyFields,
      });
      console.log(`emitWorkflowEvent: fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`);
    } catch (e) {
      console.error(`emitWorkflowEvent: fcm non-fatal: ${e.message}`);
    }
  }
}

module.exports = { emitWorkflowEvent };
