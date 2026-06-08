'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const {
  getLifecycle,
  writeAuditLog,
  updateAnalyticsRecord,
  executeDoctorSpecificCleanup,
  deleteFamilyMembers,
} = require('./helpers');

exports.adminForceDeletion = onCall(async (request) => {
  if (request.auth?.token?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const { uid, deletionReason } = request.data ?? {};
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const auth = getAuth();
  const adminUid = request.auth.uid;

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'User not found.');
  const userData = userSnap.data();

  const lifecycle = getLifecycle(userData);
  if (lifecycle.status === 'deleted') {
    throw new HttpsError('failed-precondition', 'Account is already deleted.');
  }

  const role = userData.role;

  if (role === 'doctor') {
    await executeDoctorSpecificCleanup(db, uid);
  }

  await userRef.update({
    displayName: '[deleted]',
    phoneNumber: null,
    email: null,
    photoURL: null,
    address: null,
    dateOfBirth: null,
    'accountLifecycle.status': 'deleted',
    'accountLifecycle.executedAt': FieldValue.serverTimestamp(),
    'accountLifecycle.deletionInitiatedBy': 'admin',
    'accountLifecycle.deletionReason': deletionReason ?? 'admin_force',
    'accountLifecycle.deletionRetryCount': 0,
    'accountLifecycle.authDeletionFailed': false,
  });

  await deleteFamilyMembers(db, uid);

  await writeAuditLog({
    uid,
    accountType: role,
    event: 'account_force_deleted',
    triggeredBy: 'admin',
    triggeredByUid: adminUid,
    centerId: null,
    metadata: { deletionReason: deletionReason ?? null },
  });

  await updateAnalyticsRecord(uid, {
    executedAt: FieldValue.serverTimestamp(),
    status: 'force_deleted',
  });

  try {
    await auth.deleteUser(uid);
    console.log(`adminForceDeletion: deleted uid=${uid} by admin=${adminUid}`);
  } catch (authErr) {
    if (authErr.code !== 'auth/user-not-found') {
      await userRef.update({
        'accountLifecycle.authDeletionFailed': true,
        'accountLifecycle.authDeletionFailedAt': FieldValue.serverTimestamp(),
        'accountLifecycle.deletionRetryCount': 1,
      });
      console.error(`adminForceDeletion: Auth deletion failed uid=${uid}`, authErr.message);
    }
  }

  return { success: true };
});
