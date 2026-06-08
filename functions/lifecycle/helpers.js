'use strict';

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 50;

// ─── Lifecycle state ─────────────────────────────────────────────────────────
// Null-safe read. Legacy documents without accountLifecycle default to active.
function getLifecycle(data) {
  return data?.accountLifecycle ?? { status: 'active' };
}

// ─── Subscription freeze ──────────────────────────────────────────────────────
// Reads the first subscription expiry field found on a document.
// Returns null when no active subscription is found (no-op on both sides).
//
// Field type matrix:
//   doctors:  trialEnds → ISO 8601 string (written by admin portal)
//   centers:  trialEnds / subscriptionEnd / gracePeriodEnds → Firestore Timestamp
function computeSubscriptionFreeze(data) {
  const expiresAt = data?.trialEnds ?? data?.subscriptionEnd ?? data?.gracePeriodEnds ?? null;
  if (!expiresAt) return null;

  let expiresMs;
  if (expiresAt.toMillis) {
    expiresMs = expiresAt.toMillis();    // Firestore Timestamp (centers)
  } else if (typeof expiresAt === 'string') {
    expiresMs = Date.parse(expiresAt);   // ISO string (doctors: trialEnds)
  } else {
    expiresMs = Number(expiresAt);
  }

  if (!isFinite(expiresMs)) return null; // unparseable — treat as no active subscription

  const remainingMs = Math.max(0, expiresMs - Date.now());
  if (remainingMs <= 0) return null;
  return {
    frozenAt: FieldValue.serverTimestamp(),
    frozenRemainingMs: remainingMs,
    sourceField: data?.trialEnds ? 'trialEnds' : data?.subscriptionEnd ? 'subscriptionEnd' : 'gracePeriodEnds',
  };
}

// Computes new expiry timestamp from frozen state.
function thawSubscription(subscriptionFreeze) {
  if (!subscriptionFreeze?.frozenRemainingMs) return null;
  return Timestamp.fromMillis(Date.now() + subscriptionFreeze.frozenRemainingMs);
}

// ─── Name normalization ───────────────────────────────────────────────────────
// Unicode NFC normalization before confirmation challenge comparison.
// Required for Arabic / Kurdish name inputs.
function normalizeNameChallenge(input) {
  if (typeof input !== 'string') return '';
  return input.normalize('NFC').trim();
}

// ─── Audit log ────────────────────────────────────────────────────────────────
// account_deletion_log — 7-year retention, admin SDK writes only, never deleted.
async function writeAuditLog(fields) {
  const db = getFirestore();
  await db.collection('account_deletion_log').add({
    ...fields,
    timestamp: FieldValue.serverTimestamp(),
  });
}

// account_deletion_requests — 3-year retention, analytics + support layer.
async function writeAnalyticsRecord(fields) {
  const db = getFirestore();
  await db.collection('account_deletion_requests').add({
    ...fields,
    requestedAt: FieldValue.serverTimestamp(),
  });
}

async function updateAnalyticsRecord(uid, updates) {
  const db = getFirestore();
  const snap = await db
    .collection('account_deletion_requests')
    .where('userId', '==', uid)
    .where('status', 'in', ['pending', 'restored'])
    .limit(1)
    .get();
  if (!snap.empty) {
    await snap.docs[0].ref.update(updates);
  }
}

// ─── Shared execution helpers ─────────────────────────────────────────────────
// Used by processScheduledDeletions and adminForceDeletion.

async function executeDoctorSpecificCleanup(db, uid) {
  // Remove from all center memberships across all centers.
  // NEVER writes to doctors/{uid} or users/{uid} global docs.
  const membersSnap = await db
    .collectionGroup('members')
    .where('uid', '==', uid)
    .get();

  if (!membersSnap.empty) {
    let batch = db.batch();
    let batchCount = 0;
    for (const doc of membersSnap.docs) {
      batch.update(doc.ref, {
        status: 'removed',
        removedAt: FieldValue.serverTimestamp(),
        deactivationReason: 'doctor_deleted',
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

  // Archive all schedules for this doctor across all centers.
  const schedulesSnap = await db
    .collection('schedules')
    .where('doctorId', '==', uid)
    .get();

  if (!schedulesSnap.empty) {
    let batch = db.batch();
    let batchCount = 0;
    for (const doc of schedulesSnap.docs) {
      batch.update(doc.ref, {
        isActive: false,
        archiveReason: 'doctor_account_deleted',
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

  // Anonymize doctors/{uid} document.
  await db.collection('doctors').doc(uid).update({
    name: '[deleted]',
    name_en: '[deleted]',
    name_ar: '[deleted]',
    name_ku: '[deleted]',
    phone: null,
    email: null,
    imageUrl: null,
    photos: [],
    about: null,
    about_en: null,
    about_ar: null,
    about_ku: null,
    'accountLifecycle.status': 'deleted',
    'accountLifecycle.executedAt': FieldValue.serverTimestamp(),
  });
}

async function deleteFamilyMembers(db, uid) {
  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('familyMembers')
    .get();
  if (snap.empty) return;

  let batch = db.batch();
  let batchCount = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    batchCount++;
    if (batchCount === 500) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();
}

// ─── Center-scoped helpers ────────────────────────────────────────────────────
// Used by requestCenterClosure and processScheduledCenterClosures.
// INVARIANT: these functions NEVER write to doctors/{uid} or users/{uid}.

async function detachCenterDoctors(db, centerId) {
  const snap = await db
    .collection('medical_centers')
    .doc(centerId)
    .collection('members')
    .where('role', 'in', ['doctor', 'center_admin'])
    .get();
  if (snap.empty) return;

  let batch = db.batch();
  let batchCount = 0;
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      status: 'removed',
      removedAt: FieldValue.serverTimestamp(),
      deactivationReason: 'center_closed',
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

async function deactivateCenterStaff(db, centerId) {
  const snap = await db
    .collection('medical_centers')
    .doc(centerId)
    .collection('members')
    .where('role', 'in', ['receptionist', 'staff'])
    .get();
  if (snap.empty) return;

  let batch = db.batch();
  let batchCount = 0;
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      status: 'deactivated',
      deactivatedAt: FieldValue.serverTimestamp(),
      deactivationReason: 'center_closed',
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

async function archiveCenterSchedules(db, centerId) {
  // Only archives schedules scoped to this center.
  // Doctor schedules at other centers are NOT affected.
  const snap = await db
    .collection('schedules')
    .where('centerId', '==', centerId)
    .get();
  if (snap.empty) return;

  let batch = db.batch();
  let batchCount = 0;
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      isActive: false,
      archiveReason: 'center_closed',
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

module.exports = {
  THIRTY_DAYS_MS,
  BATCH_LIMIT,
  getLifecycle,
  computeSubscriptionFreeze,
  thawSubscription,
  normalizeNameChallenge,
  writeAuditLog,
  writeAnalyticsRecord,
  updateAnalyticsRecord,
  executeDoctorSpecificCleanup,
  deleteFamilyMembers,
  detachCenterDoctors,
  deactivateCenterStaff,
  archiveCenterSchedules,
};
