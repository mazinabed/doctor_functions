'use strict';

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

function normalizeIraqi(input) {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("964")) return "+" + digits;
  if (digits.startsWith("0")) return "+964" + digits.slice(1);
  if (digits.startsWith("7")) return "+964" + digits;
  return "+" + digits;
}

// Callable: lookupPatientByPhone
// Input:  { centerId: string, phoneNumber: string }
// Returns: { uid: string, name: string|null, phoneNumber: string|null } | null
exports.lookupPatientByPhone = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const uid = request.auth.uid;
  const centerId = request.data?.centerId;
  const phoneNumber = request.data?.phoneNumber;

  if (!centerId || typeof centerId !== "string") {
    throw new HttpsError("invalid-argument", "centerId is required.");
  }
  if (!phoneNumber || typeof phoneNumber !== "string") {
    throw new HttpsError("invalid-argument", "phoneNumber is required.");
  }

  const db = admin.firestore();

  // Authorization path 1: medical center staff member
  const memberSnap = await db
    .collection("medical_centers")
    .doc(centerId)
    .collection("members")
    .doc(uid)
    .get();

  let isAuthorized = memberSnap.exists && memberSnap.data().isActive === true;

  // Authorization path 2: lab staff member (diagnostic_providers/{centerId}/lab_members/{uid})
  if (!isAuthorized) {
    const labMemberSnap = await db
      .collection("diagnostic_providers")
      .doc(centerId)
      .collection("lab_members")
      .doc(uid)
      .get();
    isAuthorized = labMemberSnap.exists && labMemberSnap.data().isActive === true;
  }

  // Authorization path 3: lab owner (diagnostic_providers/{centerId}.userId == uid)
  if (!isAuthorized) {
    const providerSnap = await db
      .collection("diagnostic_providers")
      .doc(centerId)
      .get();
    isAuthorized = providerSnap.exists && providerSnap.data().userId === uid;
  }

  if (!isAuthorized) {
    throw new HttpsError("permission-denied", "Not an active center or lab member.");
  }

  const normalized = normalizeIraqi(phoneNumber);

  const snap = await db
    .collection("users")
    .where("phoneNumber", "==", normalized)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();

  return {
    uid: doc.id,
    name: data.name ?? null,
    phoneNumber: data.phoneNumber ?? null,
  };
});
