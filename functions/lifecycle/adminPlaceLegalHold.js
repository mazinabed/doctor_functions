'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { writeAuditLog } = require('./helpers');

exports.adminPlaceLegalHold = onCall(async (request) => {
  if (request.auth?.token?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const { uid, centerId, holdReason } = request.data ?? {};
  if (!uid && !centerId) {
    throw new HttpsError('invalid-argument', 'Either uid or centerId is required.');
  }

  const db = getFirestore();
  const adminUid = request.auth.uid;
  const holdFields = {
    'accountLifecycle.legalHoldBy': adminUid,
    'accountLifecycle.legalHoldAt': FieldValue.serverTimestamp(),
    'accountLifecycle.lastStatusChangedAt': FieldValue.serverTimestamp(),
  };

  if (uid) {
    await db.collection('users').doc(uid).update(holdFields);

    // Apply hold to doctors/{uid} if the account is a doctor
    const doctorSnap = await db.collection('doctors').doc(uid).get();
    if (doctorSnap.exists) {
      await db.collection('doctors').doc(uid).update({
        'accountLifecycle.legalHoldBy': adminUid,
        'accountLifecycle.legalHoldAt': FieldValue.serverTimestamp(),
      });
    }

    await writeAuditLog({
      uid,
      accountType: 'user',
      event: 'legal_hold_placed',
      triggeredBy: 'admin',
      triggeredByUid: adminUid,
      centerId: null,
      metadata: { holdReason: holdReason ?? null },
    });

    console.log(`adminPlaceLegalHold: hold placed on uid=${uid} by admin=${adminUid}`);
    return { success: true, uid };
  }

  await db.collection('medical_centers').doc(centerId).update({
    'accountLifecycle.legalHoldBy': adminUid,
    'accountLifecycle.legalHoldAt': FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    uid: null,
    accountType: 'center',
    event: 'legal_hold_placed',
    triggeredBy: 'admin',
    triggeredByUid: adminUid,
    centerId,
    metadata: { holdReason: holdReason ?? null },
  });

  console.log(`adminPlaceLegalHold: hold placed on centerId=${centerId} by admin=${adminUid}`);
  return { success: true, centerId };
});
