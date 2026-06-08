'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  BATCH_LIMIT,
  getLifecycle,
  writeAuditLog,
} = require('./helpers');

// Doctor independence invariant — enforced at every step of this function:
// NEVER write to doctors/{uid} or users/{uid}.
// Center closure only affects: members subcollection, center-scoped schedules,
// and the medical_centers/{centerId} document itself.

exports.processScheduledCenterClosures = onSchedule(
  { schedule: '30 2 * * *', timeZone: 'UTC' },
  async (_event) => {
    const db = getFirestore();
    const now = new Date();

    const snap = await db
      .collection('medical_centers')
      .where('accountLifecycle.status', '==', 'closurePending')
      .where('accountLifecycle.scheduledClosureAt', '<=', now)
      .limit(BATCH_LIMIT)
      .get();

    console.log(`processScheduledCenterClosures: ${snap.size} center(s) due for archival`);

    for (const doc of snap.docs) {
      await _archiveCenter(db, doc.id, doc.data());
    }

    const batchLimitReached = snap.size === BATCH_LIMIT;
    console.log(
      `processScheduledCenterClosures: complete` +
      (batchLimitReached
        ? ' — batchLimitReached=true, remaining centers will process in next scheduled run.'
        : '.'),
    );
  },
);

async function _archiveCenter(db, centerId, centerData) {
  const lifecycle = getLifecycle(centerData);
  const centerRef = db.collection('medical_centers').doc(centerId);

  if (lifecycle.legalHoldBy) {
    console.log(`processScheduledCenterClosures: skipped ${centerId} — legal hold active`);
    return;
  }

  if ((lifecycle.futureAppointmentCount ?? 0) > 0) {
    console.warn(`processScheduledCenterClosures: skipped ${centerId} — futureAppointmentCount > 0`);
    return;
  }

  // archivalProgress is written after each step — idempotent per-step on retry.
  const progress = lifecycle.archivalProgress ?? {};

  try {
    // Step 1 and 2 are already true when requestCenterClosure ran (immediate detachments).
    // These checks exist only as a fallback if the function is used without
    // requestCenterClosure being called first (e.g., admin-triggered archival).

    if (!progress.doctorsDetached) {
      const { detachCenterDoctors } = require('./helpers');
      await detachCenterDoctors(db, centerId);
      await centerRef.update({ 'accountLifecycle.archivalProgress.doctorsDetached': true });
      console.log(`processScheduledCenterClosures: ${centerId} step1 doctorsDetached`);
    }

    if (!progress.staffDeactivated) {
      const { deactivateCenterStaff } = require('./helpers');
      await deactivateCenterStaff(db, centerId);
      await centerRef.update({ 'accountLifecycle.archivalProgress.staffDeactivated': true });
      console.log(`processScheduledCenterClosures: ${centerId} step2 staffDeactivated`);
    }

    if (!progress.schedulesArchived) {
      const { archiveCenterSchedules } = require('./helpers');
      await archiveCenterSchedules(db, centerId);
      await centerRef.update({ 'accountLifecycle.archivalProgress.schedulesArchived': true });
      console.log(`processScheduledCenterClosures: ${centerId} step3 schedulesArchived`);
    }

    // Step 4: Anonymize center document — set status to 'archived'
    if (!progress.centerAnonymized) {
      await centerRef.update({
        'accountLifecycle.status': 'archived',
        'accountLifecycle.archivedAt': FieldValue.serverTimestamp(),
        'accountLifecycle.archivalProgress.centerAnonymized': true,
      });
      console.log(`processScheduledCenterClosures: ${centerId} step4 centerAnonymized`);
    }

    // Step 5: Write audit log — written last so it confirms full completion
    if (!progress.logWritten) {
      await writeAuditLog({
        uid: null,
        accountType: 'center',
        event: 'center_archived',
        triggeredBy: 'system',
        triggeredByUid: null,
        centerId,
        metadata: {},
      });
      await centerRef.update({ 'accountLifecycle.archivalProgress.logWritten': true });
      console.log(`processScheduledCenterClosures: ${centerId} archived successfully`);
    }
  } catch (err) {
    console.error(`processScheduledCenterClosures: error archiving ${centerId}`, err.message);
  }
}
