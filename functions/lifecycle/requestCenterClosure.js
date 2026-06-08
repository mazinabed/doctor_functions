'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  THIRTY_DAYS_MS,
  getLifecycle,
  writeAuditLog,
  detachCenterDoctors,
  deactivateCenterStaff,
  archiveCenterSchedules,
} = require('./helpers');

exports.requestCenterClosure = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');

  const { centerId, closureReason } = request.data ?? {};
  if (!centerId) throw new HttpsError('invalid-argument', 'centerId is required.');

  const db = getFirestore();
  const centerRef = db.collection('medical_centers').doc(centerId);
  const centerSnap = await centerRef.get();
  if (!centerSnap.exists) throw new HttpsError('not-found', 'Center not found.');
  const centerData = centerSnap.data();

  // Ownership check
  if (centerData.ownerId !== uid) {
    throw new HttpsError('permission-denied', 'Only the center owner can request closure.');
  }

  const lifecycle = getLifecycle(centerData);

  if (lifecycle.status === 'closurePending') {
    throw new HttpsError('already-exists', 'Center closure is already pending.');
  }
  if (['closed', 'archived'].includes(lifecycle.status)) {
    throw new HttpsError('failed-precondition', 'Center is already closed or archived.');
  }
  if (lifecycle.legalHoldBy) {
    throw new HttpsError('failed-precondition', 'Center is under legal hold.');
  }

  // ── Hard blockers ──────────────────────────────────────────────────────────
  const futureApptCount = await _countFutureAppointments(db, centerId);
  if (futureApptCount > 0) {
    throw new HttpsError(
      'failed-precondition',
      `Center has ${futureApptCount} future appointment(s). Cancel or reschedule before closing.`,
      { code: 'future-appointments-exist', futureAppointmentCount: futureApptCount },
    );
  }

  if (centerData.hasUnresolvedBilling === true) {
    throw new HttpsError(
      'failed-precondition',
      'Center has unresolved billing. Resolve before closing.',
      { code: 'unresolved-billing' },
    );
  }

  // ── Count members (informational only — not blockers) ─────────────────────
  const { doctorCount, staffCount } = await _countActiveMembers(db, centerId);

  // ── Execute immediate detachments ─────────────────────────────────────────
  // Doctors and staff are detached now, not at Day 30.
  // INVARIANT: detachCenterDoctors and deactivateCenterStaff NEVER write to
  // doctors/{uid} or users/{uid} — only to members subcollection documents.
  await detachCenterDoctors(db, centerId);
  await deactivateCenterStaff(db, centerId);
  await archiveCenterSchedules(db, centerId);

  // ── Set closurePending with immediate steps already marked complete ────────
  const scheduledClosureAt = Timestamp.fromMillis(Date.now() + THIRTY_DAYS_MS);

  await centerRef.update({
    isActive: false,
    accountLifecycle: {
      status: 'closurePending',
      closureRequestedAt: FieldValue.serverTimestamp(),
      scheduledClosureAt,
      closureInitiatedBy: 'owner',
      closureReason: closureReason ?? null,
      futureAppointmentCount: 0,
      hasUnresolvedBilling: false,
      closureBlockedReason: null,
      doctorMemberCount: doctorCount,
      staffMemberCount: staffCount,
      adminApprovalRequired: false,
      legalHoldBy: null,
      legalHoldAt: null,
      adminApprovedBy: null,
      adminApprovedAt: null,
      // Detachments and schedule archival executed synchronously above.
      // processScheduledCenterClosures only needs to handle anonymization + log.
      archivalProgress: {
        doctorsDetached: true,
        staffDeactivated: true,
        schedulesArchived: true,
        centerAnonymized: false,
        logWritten: false,
      },
    },
  });

  await writeAuditLog({
    uid,
    accountType: 'center',
    event: 'closure_requested',
    triggeredBy: 'owner',
    triggeredByUid: uid,
    centerId,
    metadata: { scheduledClosureAt, doctorCount, staffCount },
  });

  console.log(
    `requestCenterClosure: centerId=${centerId} closurePending — ` +
    `doctorCount=${doctorCount} staffCount=${staffCount} scheduledClosureAt=${scheduledClosureAt.toDate().toISOString()}`,
  );

  return { success: true, scheduledClosureAt, doctorCount, staffCount };
});

async function _countFutureAppointments(db, centerId) {
  const snap = await db
    .collection('appointments')
    .where('centerId', '==', centerId)
    .where('status', 'in', ['pending', 'confirmed'])
    .get();
  return snap.size;
}

async function _countActiveMembers(db, centerId) {
  const snap = await db
    .collection('medical_centers')
    .doc(centerId)
    .collection('members')
    .get();
  let doctorCount = 0;
  let staffCount = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (['doctor', 'center_admin'].includes(data.role)) doctorCount++;
    else staffCount++;
  }
  return { doctorCount, staffCount };
}
