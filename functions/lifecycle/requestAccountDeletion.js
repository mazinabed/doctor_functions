'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  THIRTY_DAYS_MS,
  getLifecycle,
  computeSubscriptionFreeze,
  writeAuditLog,
  writeAnalyticsRecord,
} = require('./helpers');

exports.requestAccountDeletion = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'User document not found.');
  const userData = userSnap.data();

  const lifecycle = getLifecycle(userData);

  if (lifecycle.status === 'deletionPending') {
    throw new HttpsError('already-exists', 'Account is already pending deletion.');
  }
  if (['deleted', 'archived'].includes(lifecycle.status)) {
    throw new HttpsError('failed-precondition', 'Account is not in an active state.');
  }
  if (lifecycle.legalHoldBy) {
    throw new HttpsError('failed-precondition', 'Account is under legal hold.');
  }

  const now = Date.now();
  const scheduledDeletionAt = Timestamp.fromMillis(now + THIRTY_DAYS_MS);
  const canRestoreUntil = Timestamp.fromMillis(now + THIRTY_DAYS_MS);

  const role = userData.role;
  if (role === 'doctor') {
    return _handleDoctorDeletion(db, uid, userData, scheduledDeletionAt, canRestoreUntil);
  }
  return _handlePatientDeletion(db, uid, userData, scheduledDeletionAt, canRestoreUntil);
});

async function _handlePatientDeletion(db, uid, userData, scheduledDeletionAt, canRestoreUntil) {
  const subscriptionFreeze = computeSubscriptionFreeze(userData);
  const userRef = db.collection('users').doc(uid);

  const lifecycleData = {
    status: 'deletionPending',
    deletionRequestedAt: FieldValue.serverTimestamp(),
    scheduledDeletionAt,
    canRestoreUntil,
    deletionInitiatedBy: 'user',
    deletionReason: null,
    restoredAt: null,
    restorationCount: userData.accountLifecycle?.restorationCount ?? 0,
    lastStatusChangedAt: FieldValue.serverTimestamp(),
    legalHoldBy: null,
    legalHoldAt: null,
    authDeletionFailed: false,
    deletionRetryCount: 0,
  };
  if (subscriptionFreeze) {
    lifecycleData.subscriptionFreeze = subscriptionFreeze;
  }

  await userRef.update({ accountLifecycle: lifecycleData });

  await writeAuditLog({
    uid,
    accountType: 'patient',
    event: 'deletion_requested',
    triggeredBy: 'user',
    triggeredByUid: uid,
    centerId: null,
    metadata: { scheduledDeletionAt, canRestoreUntil },
  });

  await writeAnalyticsRecord({
    userId: uid,
    accountType: 'patient',
    centerId: null,
    scheduledDeletionAt,
    status: 'pending',
    restorationCount: 0,
    appointmentsCancelledOnDeletion: 0,
    platform: null,
  });

  return { success: true, scheduledDeletionAt, canRestoreUntil };
}

async function _handleDoctorDeletion(db, uid, userData, scheduledDeletionAt, canRestoreUntil) {
  const doctorRef = db.collection('doctors').doc(uid);
  const doctorSnap = await doctorRef.get();
  const doctorData = doctorSnap.exists ? doctorSnap.data() : {};
  const doctorLifecycle = getLifecycle(doctorData);

  // Pre-flight: doctor must not own any centers
  const ownedCenters = doctorLifecycle.doctorState?.ownedCenters ?? [];
  if (ownedCenters.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      'Close or transfer all owned centers before requesting account deletion.',
      { code: 'owned-centers-must-close', ownedCenters },
    );
  }

  const appointmentsCancelled = await _cancelDoctorFutureAppointments(db, uid);
  await _deactivateDoctorSchedules(db, uid);

  const userRef = db.collection('users').doc(uid);
  const subscriptionFreeze = computeSubscriptionFreeze(doctorData);

  const batch = db.batch();

  const userLifecycleData = {
    status: 'deletionPending',
    deletionRequestedAt: FieldValue.serverTimestamp(),
    scheduledDeletionAt,
    canRestoreUntil,
    deletionInitiatedBy: 'user',
    deletionReason: null,
    restoredAt: null,
    restorationCount: userData.accountLifecycle?.restorationCount ?? 0,
    lastStatusChangedAt: FieldValue.serverTimestamp(),
    legalHoldBy: null,
    legalHoldAt: null,
    authDeletionFailed: false,
    deletionRetryCount: 0,
  };

  const doctorLifecycleData = {
    status: 'deletionPending',
    deletionRequestedAt: FieldValue.serverTimestamp(),
    scheduledDeletionAt,
    canRestoreUntil,
    deletionInitiatedBy: 'user',
    deletionReason: null,
    restoredAt: null,
    restorationCount: doctorLifecycle.restorationCount ?? 0,
    lastStatusChangedAt: FieldValue.serverTimestamp(),
    legalHoldBy: null,
    legalHoldAt: null,
    authDeletionFailed: false,
    deletionRetryCount: 0,
    doctorState: {
      schedulesDeactivated: true,
      publicProfileHidden: true,
      bookingDisabled: true,
      ownedCenters,
      pendingCenterResolution: false,
    },
  };
  if (subscriptionFreeze) {
    doctorLifecycleData.subscriptionFreeze = subscriptionFreeze;
  }

  batch.update(userRef, { accountLifecycle: userLifecycleData });
  batch.update(doctorRef, { accountLifecycle: doctorLifecycleData });
  await batch.commit();

  // syncPublicDoctor trigger fires on the doctors/{uid} write above.
  // isDoctorPubliclyEligible() will return false → public_doctors/{uid} removed automatically.

  await writeAuditLog({
    uid,
    accountType: 'doctor',
    event: 'deletion_requested',
    triggeredBy: 'user',
    triggeredByUid: uid,
    centerId: null,
    metadata: { scheduledDeletionAt, canRestoreUntil, appointmentsCancelledOnDeletion: appointmentsCancelled },
  });

  await writeAnalyticsRecord({
    userId: uid,
    accountType: 'doctor',
    centerId: null,
    scheduledDeletionAt,
    status: 'pending',
    restorationCount: 0,
    appointmentsCancelledOnDeletion: appointmentsCancelled,
    platform: null,
  });

  return { success: true, scheduledDeletionAt, canRestoreUntil };
}

async function _cancelDoctorFutureAppointments(db, doctorId) {
  const snap = await db
    .collection('appointments')
    .where('doctorId', '==', doctorId)
    .where('status', 'in', ['pending', 'confirmed'])
    .get();
  if (snap.empty) return 0;

  let batch = db.batch();
  let batchCount = 0;
  let total = 0;

  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      status: 'cancelled',
      cancellationReason: 'doctor_account_deletion',
      cancelledAt: FieldValue.serverTimestamp(),
    });
    batchCount++;
    total++;
    if (batchCount === 500) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();
  return total;
}

async function _deactivateDoctorSchedules(db, doctorId) {
  const snap = await db
    .collection('schedules')
    .where('doctorId', '==', doctorId)
    .where('isActive', '==', true)
    .get();
  if (snap.empty) return;

  let batch = db.batch();
  let batchCount = 0;

  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      isActive: false,
      archiveReason: 'doctor_account_deletion_pending',
    });
    batchCount++;
    if (batchCount === 500) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();
}
