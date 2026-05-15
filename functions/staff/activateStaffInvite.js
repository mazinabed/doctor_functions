"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

// Iraqi phone normalizer — mirrors PhoneUtils.normalizeIraqi in doctor_portal
function normalizeIraqi(input) {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("964")) return "+" + digits;
  if (digits.startsWith("0")) return "+964" + digits.slice(1);
  if (digits.startsWith("7")) return "+964" + digits;
  return "+" + digits;
}

// Callable: activateStaffInvite
//
// Finds a pending invite doc in medical_centers/{centerId}/members/{autoId}
// (phoneNormalized == callerPhone, status == 'invited'), then in a single
// transaction:
//   1. Creates the uid-keyed member doc: members/{uid}
//   2. Archives the auto-ID invite doc (status: 'archived')
//   3. Writes/merges users/{uid} with center fields (never overwrites existing role)
//
// Returns: { activated: bool, centerId?: string, centerRole?: string }
//
// Requires Firestore composite indexes:
//   collectionGroup(members): phoneNormalized ASC, status ASC
//   collectionGroup(members): uid ASC, isActive ASC
exports.activateStaffInvite = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const uid = request.auth.uid;

  // Token phone is the trusted source (cannot be forged by client)
  const tokenPhone = request.auth.token.phone_number || null;
  const dataPhone = (request.data && request.data.phoneNumber) ? request.data.phoneNumber : null;
  const rawPhone = tokenPhone || dataPhone;

  if (!rawPhone) {
    throw new HttpsError("invalid-argument", "No phone number available for invite lookup.");
  }

  const normalizedPhone = normalizeIraqi(rawPhone);
  const db = admin.firestore();

  // CollectionGroup queries cannot run inside Firestore transactions — run first
  const inviteQuery = await db
    .collectionGroup("members")
    .where("phoneNormalized", "==", normalizedPhone)
    .where("status", "==", "invited")
    .limit(1)
    .get();

  if (inviteQuery.empty) {
    // No pending invite — check idempotency (caller already activated earlier)
    const existingQuery = await db
      .collectionGroup("members")
      .where("uid", "==", uid)
      .where("isActive", "==", true)
      .limit(1)
      .get();

    if (!existingQuery.empty) {
      const doc = existingQuery.docs[0];
      const parts = doc.ref.path.split("/");
      return {
        activated: true,
        centerId: parts[1],
        centerRole: doc.data().role || "staff",
      };
    }

    return { activated: false };
  }

  const inviteDoc = inviteQuery.docs[0];
  const inviteRef = inviteDoc.ref;
  const inviteData = inviteDoc.data();
  // Path: medical_centers/{centerId}/members/{autoId}
  const pathParts = inviteRef.path.split("/");
  const centerId = pathParts[1];
  const centerRole = inviteData.role || "staff";
  const displayName = inviteData.displayName || null;
  const phoneNumber = inviteData.phoneNumber || null;
  const photoUrl    = inviteData.photoUrl    || null;

  const memberRef = db
    .collection("medical_centers")
    .doc(centerId)
    .collection("members")
    .doc(uid);

  const userRef = db.collection("users").doc(uid);

  const txResult = await db.runTransaction(async (t) => {
    // TOCTOU guard: re-read invite inside transaction
    const freshInvite = await t.get(inviteRef);
    if (!freshInvite.exists || freshInvite.data().status !== "invited") {
      // Concurrent activation or already processed — check if members/{uid} is active
      const freshMember = await t.get(memberRef);
      if (freshMember.exists && freshMember.data().isActive === true) {
        return { concurrent: true, success: true };
      }
      return { concurrent: true, success: false };
    }

    // Idempotency: uid-keyed member doc already active?
    const memberSnap = await t.get(memberRef);
    if (memberSnap.exists && memberSnap.data().isActive === true) {
      return { concurrent: true, success: true };
    }

    const userSnap = await t.get(userRef);
    const userExists = userSnap.exists;

    const now = admin.firestore.FieldValue.serverTimestamp();

    // 1. Create uid-keyed member doc
    t.set(memberRef, {
      uid,
      role: centerRole,
      isActive: true,
      status: "active",
      phoneNormalized: normalizedPhone,
      ...(displayName && { displayName }),
      ...(phoneNumber && { phoneNumber }),
      ...(photoUrl    && { photoUrl }),
      joinedAt: now,
      activatedFrom: inviteRef.id,
    });

    // 2. Archive the auto-ID invite doc (preserve for audit trail)
    t.update(inviteRef, {
      status: "archived",
      activatedUid: uid,
      activatedAt: now,
    });

    // 3. Write users/{uid} — never overwrite existing role
    if (!userExists) {
      t.set(userRef, {
        role: "staff",
        centerId,
        centerRole,
        hasCenter: true,
        createdAt: now,
      });
    } else {
      t.update(userRef, {
        centerId,
        centerRole,
        hasCenter: true,
        roles: admin.firestore.FieldValue.arrayUnion("staff"),
      });
    }

    return { concurrent: false };
  });

  if (txResult.concurrent) {
    return txResult.success
      ? { activated: true, centerId, centerRole }
      : { activated: false };
  }

  return { activated: true, centerId, centerRole };
});
