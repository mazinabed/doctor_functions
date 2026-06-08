'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  getLifecycle,
  thawSubscription,
  writeAuditLog,
  updateAnalyticsRecord,
} = require('./helpers');

exports.restoreAccount = onCall(async (request) => {
  const callerId = request.auth?.uid;
  if (!callerId) throw new HttpsError('unauthenticated', 'Authentication required.');

  const { uid: targetUid } = request.data ?? {};
  const uid = targetUid || callerId;

  // Admin override: caller must have admin custom claim to restore another user
  if (uid !== callerId) {
    const isAdmin = request.auth.token?.role === 'admin';
    if (!isAdmin) {
      throw new HttpsError('permission-denied', 'Cannot restore another user\'s account.');
    }
  }

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'User document not found.');
  const userData = userSnap.data();

  const lifecycle = getLifecycle(userData);

  if (lifecycle.status === 'active') {
    throw new HttpsError('failed-precondition', 'Account is already active.', { code: 'account-already-active' });
  }
  if (lifecycle.status === 'deleted') {
    throw new HttpsError('failed-precondition', 'Account deletion was already executed.', { code: 'account-already-deleted' });
  }
  if (lifecycle.status !== 'deletionPending') {
    throw new HttpsError('failed-precondition', 'Account is not in a restorable state.');
  }

  // Legal hold blocks restoration unless caller is admin
  const isAdminCaller = request.auth.token?.role === 'admin';
  if (lifecycle.legalHoldBy && !isAdminCaller) {
    throw new HttpsError('failed-precondition', 'Account is under legal hold.', { code: 'legal-hold-active' });
  }

  // Restoration window check
  const canRestoreUntil = lifecycle.canRestoreUntil;
  if (canRestoreUntil && canRestoreUntil.toMillis() < Date.now()) {
    throw new HttpsError('failed-precondition', 'Restoration window has expired.', { code: 'restoration-window-expired' });
  }

  const role = userData.role;
  const newRestorationCount = (lifecycle.restorationCount ?? 0) + 1;

  const userLifecycleUpdate = {
    'accountLifecycle.status': 'active',
    'accountLifecycle.restoredAt': FieldValue.serverTimestamp(),
    'accountLifecycle.restorationCount': newRestorationCount,
    'accountLifecycle.lastStatusChangedAt': FieldValue.serverTimestamp(),
    'accountLifecycle.deletionRequestedAt': null,
    'accountLifecycle.scheduledDeletionAt': null,
    'accountLifecycle.canRestoreUntil': null,
    'accountLifecycle.subscriptionFreeze': null,
    'accountLifecycle.authDeletionFailed': false,
    'accountLifecycle.deletionRetryCount': 0,
  };

  const batch = db.batch();
  batch.update(userRef, userLifecycleUpdate);

  let centersDetachedDuringPending = [];

  if (role === 'doctor') {
    const doctorRef = db.collection('doctors').doc(uid);
    const doctorSnap = await doctorRef.get();

    if (doctorSnap.exists) {
      const doctorData = doctorSnap.data();
      const doctorLifecycle = getLifecycle(doctorData);
      const newDoctorRestorationCount = (doctorLifecycle.restorationCount ?? 0) + 1;

      // Thaw subscription from doctors/{uid} freeze data
      const subscriptionFreeze = doctorLifecycle.subscriptionFreeze ?? null;
      const newExpiresAt = thawSubscription(subscriptionFreeze);

      const doctorUpdate = {
        'accountLifecycle.status': 'active',
        'accountLifecycle.restoredAt': FieldValue.serverTimestamp(),
        'accountLifecycle.restorationCount': newDoctorRestorationCount,
        'accountLifecycle.lastStatusChangedAt': FieldValue.serverTimestamp(),
        'accountLifecycle.deletionRequestedAt': null,
        'accountLifecycle.scheduledDeletionAt': null,
        'accountLifecycle.canRestoreUntil': null,
        'accountLifecycle.subscriptionFreeze': null,
        // Reset lifecycle-controlled booking flags.
        // schedulesDeactivated is reset to false so the doctor can re-enable
        // schedules manually — individual schedule isActive flags are not changed here.
        'accountLifecycle.doctorState.bookingDisabled': false,
        'accountLifecycle.doctorState.publicProfileHidden': false,
        'accountLifecycle.doctorState.schedulesDeactivated': false,
      };

      if (newExpiresAt && subscriptionFreeze?.sourceField) {
        doctorUpdate[subscriptionFreeze.sourceField] = newExpiresAt;
      }

      batch.update(doctorRef, doctorUpdate);

      // Find centers that closed during the pending window
      centersDetachedDuringPending = await _findCentersClosedDuringPending(db, uid);
    }
  }

  await batch.commit();

  // syncPublicDoctor trigger fires on the doctors/{uid} write.
  // isDoctorPubliclyEligible() will now return true → public_doctors/{uid} re-created.

  await writeAuditLog({
    uid,
    accountType: role,
    event: 'account_restored',
    triggeredBy: uid === callerId ? 'user' : 'admin',
    triggeredByUid: callerId,
    centerId: null,
    metadata: { newRestorationCount },
  });

  await updateAnalyticsRecord(uid, {
    restoredAt: FieldValue.serverTimestamp(),
    status: 'restored',
    restorationCount: newRestorationCount,
  });

  return {
    success: true,
    // Doctor's schedules remain deactivated — doctor must review and re-enable in portal.
    schedulesRequireReview: role === 'doctor',
    centersDetachedDuringPending,
  };
});

async function _findCentersClosedDuringPending(db, doctorId) {
  const snap = await db
    .collectionGroup('members')
    .where('uid', '==', doctorId)
    .where('status', '==', 'removed')
    .where('deactivationReason', '==', 'center_closed')
    .get();
  return snap.docs.map((d) => d.ref.parent.parent.id);
}
