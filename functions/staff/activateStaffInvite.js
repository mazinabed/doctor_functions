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
// Searches three invitation paths in order:
//   1. medical_centers/{centerId}/members/{autoId}        — clinic staff
//   2. diagnostic_providers/{labId}/lab_members/{autoId}  — lab/imaging staff
//   3. pharmacy_providers/{pharmacyId}/pharmacy_members/{autoId} — pharmacy staff
//
// For whichever invite is found, runs a single Firestore transaction that:
//   a. Creates the uid-keyed member doc (members/{uid}, lab_members/{uid},
//      or pharmacy_members/{uid})
//   b. Archives the auto-ID invite doc (status: 'archived')
//   c. Writes/merges users/{uid} (never overwrites existing role)
//
// Returns: { activated: bool,
//            centerId?, centerRole?,
//            isLabMember?, labId?, labRole?,
//            isPharmacyMember?, pharmacyId?, pharmacyRole? }
//
// Requires Firestore composite indexes:
//   collectionGroup(members):          phoneNormalized ASC, status ASC
//   collectionGroup(members):          uid ASC, isActive ASC
//   collectionGroup(lab_members):      phoneNormalized ASC, status ASC
//   collectionGroup(lab_members):      uid ASC, isActive ASC
//   collectionGroup(pharmacy_members): phoneNormalized ASC, status ASC
//   collectionGroup(pharmacy_members): uid ASC, isActive ASC
exports.activateStaffInvite = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const uid = request.auth.uid;

  // Token phone is the trusted source (cannot be forged by client)
  const tokenPhone = request.auth.token.phone_number || null;
  const dataPhone = (request.data && request.data.phoneNumber) ? request.data.phoneNumber : null;
  const rawPhone = tokenPhone || dataPhone;

  console.log(`[activateStaffInvite] uid=${uid} tokenPhone=${tokenPhone} rawPhone=${rawPhone}`);

  if (!rawPhone) {
    console.warn(`[activateStaffInvite] No phone number for uid=${uid} — rejecting`);
    throw new HttpsError("invalid-argument", "No phone number available for invite lookup.");
  }

  const normalizedPhone = normalizeIraqi(rawPhone);
  console.log(`[activateStaffInvite] normalizedPhone=${normalizedPhone}`);
  const db = admin.firestore();

  // ─── PATH 1: CLINIC STAFF (medical_centers/*/members) ────────────────────
  // CollectionGroup queries cannot run inside Firestore transactions — run first.

  const inviteQuery = await db
    .collectionGroup("members")
    .where("phoneNormalized", "==", normalizedPhone)
    .where("status", "==", "invited")
    .limit(1)
    .get();

  console.log(`[activateStaffInvite] PATH1 clinic members query: ${inviteQuery.size} result(s)`);

  if (!inviteQuery.empty) {
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
    const permissions = inviteData.permissions || null;

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

      // 1. Create uid-keyed member doc — copy permissions from invite so any
      //    custom permissions set by the admin at invite time are preserved.
      //    Falls back to defaultsForRole on the Flutter side if permissions is null.
      t.set(memberRef, {
        uid,
        role: centerRole,
        isActive: true,
        status: "active",
        phoneNormalized: normalizedPhone,
        ...(displayName && { displayName }),
        ...(phoneNumber && { phoneNumber }),
        ...(photoUrl    && { photoUrl }),
        ...(permissions && { permissions }),
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
  }

  // ─── PATH 2: LAB / IMAGING STAFF (diagnostic_providers/*/lab_members) ─────

  const labInviteQuery = await db
    .collectionGroup("lab_members")
    .where("phoneNormalized", "==", normalizedPhone)
    .where("status", "==", "invited")
    .limit(1)
    .get();

  console.log(`[activateStaffInvite] PATH2 lab_members query: ${labInviteQuery.size} result(s)`);

  if (!labInviteQuery.empty) {
    const labInviteDoc = labInviteQuery.docs[0];
    const labInviteRef = labInviteDoc.ref;
    const labInviteData = labInviteDoc.data();
    // Path: diagnostic_providers/{labId}/lab_members/{autoId}
    const labPathParts = labInviteRef.path.split("/");
    const labId = labPathParts[1];
    const labRole = labInviteData.role || "staff";
    console.log(`[activateStaffInvite] Found lab invite: labId=${labId} role=${labRole} inviteRef=${labInviteRef.path}`);
    const displayName = labInviteData.displayName || null;
    const phoneNumber = labInviteData.phoneNumber || null;
    const permissions = labInviteData.permissions || null;

    const labMemberRef = db
      .collection("diagnostic_providers")
      .doc(labId)
      .collection("lab_members")
      .doc(uid);

    const userRef = db.collection("users").doc(uid);

    const txResult = await db.runTransaction(async (t) => {
      // TOCTOU guard
      const freshInvite = await t.get(labInviteRef);
      if (!freshInvite.exists || freshInvite.data().status !== "invited") {
        const freshMember = await t.get(labMemberRef);
        if (freshMember.exists && freshMember.data().isActive === true) {
          return { concurrent: true, success: true };
        }
        return { concurrent: true, success: false };
      }

      // Idempotency: uid-keyed lab_members doc already active?
      const memberSnap = await t.get(labMemberRef);
      if (memberSnap.exists && memberSnap.data().isActive === true) {
        return { concurrent: true, success: true };
      }

      const userSnap = await t.get(userRef);
      const userExists = userSnap.exists;
      const now = admin.firestore.FieldValue.serverTimestamp();

      // 1. Create uid-keyed lab_members doc — preserve role and permissions
      //    from the invitation (written by the lab admin at invite time).
      t.set(labMemberRef, {
        uid,
        role: labRole,
        isActive: true,
        status: "active",
        phoneNormalized: normalizedPhone,
        ...(displayName && { displayName }),
        ...(phoneNumber && { phoneNumber }),
        ...(permissions && { permissions }),
        joinedAt: now,
        activatedFrom: labInviteRef.id,
      });

      // 2. Archive the auto-ID invite doc (preserve for audit trail)
      t.update(labInviteRef, {
        status: "archived",
        activatedUid: uid,
        activatedAt: now,
      });

      // 3. Write users/{uid}.
      //    Do NOT set centerId — centerScopeProvider resolves labId via
      //    collectionGroup('lab_members') when centerId is null, which is
      //    the correct path for lab staff.
      if (!userExists) {
        t.set(userRef, {
          role: "staff",
          hasCenter: true,
          createdAt: now,
        });
      } else {
        t.update(userRef, {
          hasCenter: true,
          roles: admin.firestore.FieldValue.arrayUnion("staff"),
        });
      }

      return { concurrent: false };
    });

    if (txResult.concurrent) {
      const r = txResult.success
        ? { activated: true, isLabMember: true, labId, labRole }
        : { activated: false };
      console.log(`[activateStaffInvite] PATH2 concurrent result:`, JSON.stringify(r));
      return r;
    }

    console.log(`[activateStaffInvite] PATH2 success: labId=${labId} labRole=${labRole}`);
    return { activated: true, isLabMember: true, labId, labRole };
  }

  // ─── PATH 3: PHARMACY STAFF (pharmacy_providers/*/pharmacy_members) ──────

  const pharmacyInviteQuery = await db
    .collectionGroup("pharmacy_members")
    .where("phoneNormalized", "==", normalizedPhone)
    .where("status", "==", "invited")
    .limit(1)
    .get();

  console.log(`[activateStaffInvite] PATH3 pharmacy_members query: ${pharmacyInviteQuery.size} result(s)`);

  if (!pharmacyInviteQuery.empty) {
    const pharmacyInviteDoc = pharmacyInviteQuery.docs[0];
    const pharmacyInviteRef = pharmacyInviteDoc.ref;
    const pharmacyInviteData = pharmacyInviteDoc.data();
    // Path: pharmacy_providers/{pharmacyId}/pharmacy_members/{autoId}
    const pharmacyPathParts = pharmacyInviteRef.path.split("/");
    const pharmacyId = pharmacyPathParts[1];
    const pharmacyRole = pharmacyInviteData.role || "staff";
    console.log(`[activateStaffInvite] Found pharmacy invite: pharmacyId=${pharmacyId} role=${pharmacyRole} inviteRef=${pharmacyInviteRef.path}`);
    const displayName = pharmacyInviteData.displayName || null;
    const phoneNumber = pharmacyInviteData.phoneNumber || null;
    const permissions = pharmacyInviteData.permissions || null;

    const pharmacyMemberRef = db
      .collection("pharmacy_providers")
      .doc(pharmacyId)
      .collection("pharmacy_members")
      .doc(uid);

    const userRef = db.collection("users").doc(uid);

    const txResult = await db.runTransaction(async (t) => {
      // TOCTOU guard
      const freshInvite = await t.get(pharmacyInviteRef);
      if (!freshInvite.exists || freshInvite.data().status !== "invited") {
        const freshMember = await t.get(pharmacyMemberRef);
        if (freshMember.exists && freshMember.data().isActive === true) {
          return { concurrent: true, success: true };
        }
        return { concurrent: true, success: false };
      }

      // Idempotency: uid-keyed pharmacy_members doc already active?
      const memberSnap = await t.get(pharmacyMemberRef);
      if (memberSnap.exists && memberSnap.data().isActive === true) {
        return { concurrent: true, success: true };
      }

      const userSnap = await t.get(userRef);
      const userExists = userSnap.exists;
      const now = admin.firestore.FieldValue.serverTimestamp();

      // 1. Create uid-keyed pharmacy_members doc — preserve role and permissions
      //    from the invitation (written by the pharmacy admin at invite time).
      t.set(pharmacyMemberRef, {
        uid,
        role: pharmacyRole,
        isActive: true,
        status: "active",
        phoneNormalized: normalizedPhone,
        ...(displayName && { displayName }),
        ...(phoneNumber && { phoneNumber }),
        ...(permissions && { permissions }),
        joinedAt: now,
        activatedFrom: pharmacyInviteRef.id,
      });

      // 2. Archive the auto-ID invite doc (preserve for audit trail)
      t.update(pharmacyInviteRef, {
        status: "archived",
        activatedUid: uid,
        activatedAt: now,
      });

      // 3. Write users/{uid}.
      //    Do NOT set centerId — pharmacyScopeProvider resolves pharmacyId via
      //    collectionGroup('pharmacy_members') when centerId is null, which is
      //    the correct path for pharmacy staff (mirrors lab staff handling).
      if (!userExists) {
        t.set(userRef, {
          role: "staff",
          hasCenter: true,
          createdAt: now,
        });
      } else {
        t.update(userRef, {
          hasCenter: true,
          roles: admin.firestore.FieldValue.arrayUnion("staff"),
        });
      }

      return { concurrent: false };
    });

    if (txResult.concurrent) {
      const r = txResult.success
        ? { activated: true, isPharmacyMember: true, pharmacyId, pharmacyRole }
        : { activated: false };
      console.log(`[activateStaffInvite] PATH3 concurrent result:`, JSON.stringify(r));
      return r;
    }

    console.log(`[activateStaffInvite] PATH3 success: pharmacyId=${pharmacyId} pharmacyRole=${pharmacyRole}`);
    return { activated: true, isPharmacyMember: true, pharmacyId, pharmacyRole };
  }

  // ─── NO INVITE FOUND — idempotency check ─────────────────────────────────

  console.log(`[activateStaffInvite] No pending invite found for ${normalizedPhone} — checking existing active memberships for uid=${uid}`);

  // Check if this uid already has an active clinic membership.
  const existingClinicQuery = await db
    .collectionGroup("members")
    .where("uid", "==", uid)
    .where("isActive", "==", true)
    .limit(1)
    .get();

  if (!existingClinicQuery.empty) {
    const doc = existingClinicQuery.docs[0];
    const parts = doc.ref.path.split("/");
    const result = {
      activated: true,
      centerId: parts[1],
      centerRole: doc.data().role || "staff",
    };
    console.log(`[activateStaffInvite] Idempotency: existing clinic member`, JSON.stringify(result));
    return result;
  }

  // Check if this uid already has an active lab membership.
  const existingLabQuery = await db
    .collectionGroup("lab_members")
    .where("uid", "==", uid)
    .where("isActive", "==", true)
    .limit(1)
    .get();

  if (!existingLabQuery.empty) {
    const doc = existingLabQuery.docs[0];
    const labId = doc.ref.parent.parent.id;
    const result = {
      activated: true,
      isLabMember: true,
      labId,
      labRole: doc.data().role || "staff",
    };
    console.log(`[activateStaffInvite] Idempotency: existing lab member`, JSON.stringify(result));
    return result;
  }

  // Check if this uid already has an active pharmacy membership.
  const existingPharmacyQuery = await db
    .collectionGroup("pharmacy_members")
    .where("uid", "==", uid)
    .where("isActive", "==", true)
    .limit(1)
    .get();

  if (!existingPharmacyQuery.empty) {
    const doc = existingPharmacyQuery.docs[0];
    const pharmacyId = doc.ref.parent.parent.id;
    const result = {
      activated: true,
      isPharmacyMember: true,
      pharmacyId,
      pharmacyRole: doc.data().role || "staff",
    };
    console.log(`[activateStaffInvite] Idempotency: existing pharmacy member`, JSON.stringify(result));
    return result;
  }

  console.log(`[activateStaffInvite] No invite and no existing membership for uid=${uid} — returning activated:false`);
  return { activated: false };
});
