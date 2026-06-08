'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const {
  BATCH_LIMIT,
  getLifecycle,
  writeAuditLog,
  updateAnalyticsRecord,
  executeDoctorSpecificCleanup,
  deleteFamilyMembers,
} = require('./helpers');

const AUTH_RETRY_ALERT_THRESHOLD = 5;

exports.processScheduledDeletions = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'UTC' },
  async (_event) => {
    const db = getFirestore();
    const auth = getAuth();
    const now = new Date();

    // Primary: accounts past their scheduledDeletionAt window
    const primarySnap = await db
      .collection('users')
      .where('accountLifecycle.status', '==', 'deletionPending')
      .where('accountLifecycle.scheduledDeletionAt', '<=', now)
      .limit(BATCH_LIMIT)
      .get();

    // Retry: accounts already anonymized but Auth deletion previously failed
    const retrySnap = await db
      .collection('users')
      .where('accountLifecycle.status', '==', 'deleted')
      .where('accountLifecycle.authDeletionFailed', '==', true)
      .limit(BATCH_LIMIT)
      .get();

    console.log(
      `processScheduledDeletions: dueForDeletion=${primarySnap.size} authRetryPending=${retrySnap.size}`,
    );

    // Auth retries first — simpler path, Firestore already clean
    for (const doc of retrySnap.docs) {
      await _retryAuthDeletion(auth, db, doc.id, doc.data());
    }

    // Primary deletions — sequential to avoid write contention
    for (const doc of primarySnap.docs) {
      await _executeAccountDeletion(auth, db, doc.id, doc.data());
    }

    const batchLimitReached = primarySnap.size === BATCH_LIMIT;
    console.log(
      `processScheduledDeletions: processed=${primarySnap.size}` +
      (batchLimitReached
        ? ' batchLimitReached=true — remaining accounts will process in next scheduled run.'
        : ' complete.'),
    );
  },
);

async function _executeAccountDeletion(auth, db, uid, userData) {
  const lifecycle = getLifecycle(userData);

  if (lifecycle.legalHoldBy) {
    console.log(`processScheduledDeletions: skipped uid=${uid} — legal hold active`);
    return;
  }

  const role = userData.role;

  try {
    // Doctor-specific cleanup: remove from all center memberships, archive all schedules,
    // anonymize doctors/{uid}. NEVER writes to other users' documents.
    if (role === 'doctor') {
      await executeDoctorSpecificCleanup(db, uid);
    }

    // Anonymize users/{uid} — PII cleared, status set to 'deleted'
    await db.collection('users').doc(uid).update({
      displayName: '[deleted]',
      phoneNumber: null,
      email: null,
      photoURL: null,
      address: null,
      dateOfBirth: null,
      'accountLifecycle.status': 'deleted',
      'accountLifecycle.executedAt': FieldValue.serverTimestamp(),
      'accountLifecycle.deletionRetryCount': 0,
      'accountLifecycle.authDeletionFailed': false,
    });

    // Delete family member profiles
    await deleteFamilyMembers(db, uid);

    // Audit log — 7-year retention
    await writeAuditLog({
      uid,
      accountType: role,
      event: 'account_deleted',
      triggeredBy: 'system',
      triggeredByUid: null,
      centerId: null,
      metadata: { role },
    });

    // Analytics update — 3-year retention
    await updateAnalyticsRecord(uid, {
      executedAt: FieldValue.serverTimestamp(),
      status: 'executed',
    });

    // Firebase Auth deletion — LAST step
    // Firestore PII is already cleared above. If Auth deletion fails here,
    // the account is privacy-safe but the phone number remains reserved.
    // authDeletionFailed flag triggers retry in the next scheduled run.
    try {
      await auth.deleteUser(uid);
      console.log(`processScheduledDeletions: deleted uid=${uid} role=${role}`);
    } catch (authErr) {
      if (authErr.code === 'auth/user-not-found') {
        console.log(`processScheduledDeletions: uid=${uid} Auth record already gone — success`);
        return;
      }
      const retryCount = (lifecycle.deletionRetryCount ?? 0) + 1;
      await db.collection('users').doc(uid).update({
        'accountLifecycle.authDeletionFailed': true,
        'accountLifecycle.authDeletionFailedAt': FieldValue.serverTimestamp(),
        'accountLifecycle.deletionRetryCount': retryCount,
      });
      const alertFlag = retryCount >= AUTH_RETRY_ALERT_THRESHOLD
        ? ' ADMIN_ALERT: persistent Auth deletion failure — manual cleanup required.'
        : '';
      console.error(
        `processScheduledDeletions: Auth deletion failed uid=${uid} retryCount=${retryCount}.${alertFlag}`,
        authErr.message,
      );
    }
  } catch (err) {
    console.error(`processScheduledDeletions: error processing uid=${uid}`, err.message);
  }
}

async function _retryAuthDeletion(auth, db, uid, userData) {
  const lifecycle = getLifecycle(userData);
  const retryCount = (lifecycle.deletionRetryCount ?? 0) + 1;

  try {
    await auth.deleteUser(uid);
    await db.collection('users').doc(uid).update({
      'accountLifecycle.authDeletionFailed': false,
      'accountLifecycle.authDeletionFailedAt': null,
    });
    console.log(`processScheduledDeletions: Auth retry succeeded uid=${uid}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await db.collection('users').doc(uid).update({
        'accountLifecycle.authDeletionFailed': false,
        'accountLifecycle.authDeletionFailedAt': null,
      });
      console.log(`processScheduledDeletions: Auth retry — uid=${uid} already gone, flag cleared`);
      return;
    }
    await db.collection('users').doc(uid).update({
      'accountLifecycle.deletionRetryCount': retryCount,
    });
    const alertFlag = retryCount >= AUTH_RETRY_ALERT_THRESHOLD
      ? ' ADMIN_ALERT: persistent Auth deletion failure — manual cleanup required.'
      : '';
    console.error(
      `processScheduledDeletions: Auth retry failed uid=${uid} retryCount=${retryCount}.${alertFlag}`,
      err.message,
    );
  }
}
