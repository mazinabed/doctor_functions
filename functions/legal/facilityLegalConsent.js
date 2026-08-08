"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getLegalConfig } = require("./legalConfig");

// Legal Consent Modernization (Phase 2 — facility-level agreements).
//
// One callable pair, parameterized by facilityType, covers all three
// organization architectures confirmed by the dedicated org-architecture
// audit: medical_centers/{centerId} (separate org doc, ownerId field),
// pharmacy_providers/{uid} and diagnostic_providers/{uid} (identity ==
// facility, userId field). Same server-authoritative version /
// append-only history / server-only write discipline as the account-level
// callables in legalConsent.js.
//
// Authorization mirrors this repo's own existing write-authority model for
// each facility doc (isCenterOwner/isCenterAdminMember,
// isPharmacyOwner/isPharmacyAdminMember, isLabOwner/isLabAdminMember in
// firestore.rules) rather than inventing a new permission — owner OR the
// facility's own admin-role member may accept. This deliberately avoids
// repeating the OLD system's bug (doctor_legal_consent_page.dart gating
// solely on users/{uid}.role == center_admin, a spoofable/stale field
// unrelated to the actual member-doc authority).

const FACILITY_TYPES = {
  medical_center: {
    collection: "medical_centers",
    versionField: "medicalCenterAgreementVersion",
    acceptanceKey: "medicalCenterAgreement",
  },
  pharmacy: {
    collection: "pharmacy_providers",
    versionField: "pharmacyAgreementVersion",
    acceptanceKey: "pharmacyAgreement",
  },
  lab: {
    collection: "diagnostic_providers",
    versionField: "labAgreementVersion",
    acceptanceKey: "labAgreement",
  },
};

// Shared "is this facility's agreement current" resolver — the exact same
// computation getFacilityLegalStatusHandler returns to a facility owner in
// the Provider dashboard, reused verbatim (not recomputed differently) by
// the Commerce marketplace-checkout bridge (marketplaceCheckout.js) so a
// Healthcare-origin pharmacy's checkout gate reads the SAME facility
// doc/version comparison as the facility's own status page — one
// definition, never two independently-drifting ones. Read-only; never
// writes legalAcceptances or legalHistory (those are exclusively written by
// acceptFacilityLegalAgreementHandler above, via its own transaction).
async function isFacilityLegalCurrent(db, facilityType, facilityId) {
  const config = FACILITY_TYPES[facilityType];
  const [legalConfig, facilitySnap] = await Promise.all([
    getLegalConfig(),
    db.collection(config.collection).doc(facilityId).get(),
  ]);
  if (!facilitySnap.exists) return false;
  const acceptances = facilitySnap.data().legalAcceptances || {};
  const record = acceptances[config.acceptanceKey];
  return !!record && record.accepted === true && record.version === legalConfig[config.versionField];
}
exports.isFacilityLegalCurrent = isFacilityLegalCurrent;

function isValidFacilityType(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FACILITY_TYPES, value);
}

async function isCenterAuthorized(db, centerId, uid) {
  const centerSnap = await db.collection("medical_centers").doc(centerId).get();
  if (!centerSnap.exists) return false;
  if (centerSnap.data().ownerId === uid) return true;

  const memberSnap = await db
    .collection("medical_centers")
    .doc(centerId)
    .collection("members")
    .doc(uid)
    .get();
  return (
    memberSnap.exists &&
    memberSnap.data().role === "center_admin" &&
    memberSnap.data().isActive === true
  );
}

async function isPharmacyAuthorized(db, pharmacyId, uid) {
  const providerSnap = await db.collection("pharmacy_providers").doc(pharmacyId).get();
  if (!providerSnap.exists) return false;
  if (providerSnap.data().userId === uid) return true;

  const memberSnap = await db
    .collection("pharmacy_providers")
    .doc(pharmacyId)
    .collection("pharmacy_members")
    .doc(uid)
    .get();
  return (
    memberSnap.exists &&
    memberSnap.data().role === "pharmacy_admin" &&
    memberSnap.data().isActive === true
  );
}

async function isLabAuthorized(db, labId, uid) {
  const providerSnap = await db.collection("diagnostic_providers").doc(labId).get();
  if (!providerSnap.exists) return false;
  if (providerSnap.data().userId === uid) return true;

  const memberSnap = await db
    .collection("diagnostic_providers")
    .doc(labId)
    .collection("lab_members")
    .doc(uid)
    .get();
  return (
    memberSnap.exists &&
    memberSnap.data().role === "lab_admin" &&
    memberSnap.data().isActive === true
  );
}

async function assertFacilityAuthorized(db, facilityType, facilityId, uid) {
  let authorized;
  if (facilityType === "medical_center") {
    authorized = await isCenterAuthorized(db, facilityId, uid);
  } else if (facilityType === "pharmacy") {
    authorized = await isPharmacyAuthorized(db, facilityId, uid);
  } else {
    authorized = await isLabAuthorized(db, facilityId, uid);
  }
  if (!authorized) {
    throw new HttpsError(
      "permission-denied",
      "Only the facility owner or an active admin member may act on this agreement.",
    );
  }
}

function validateInput(facilityType, facilityId) {
  if (!isValidFacilityType(facilityType)) {
    throw new HttpsError(
      "invalid-argument",
      "facilityType must be one of: medical_center, pharmacy, lab.",
    );
  }
  if (typeof facilityId !== "string" || !facilityId) {
    throw new HttpsError("invalid-argument", "facilityId is required.");
  }
}

async function getFacilityLegalStatusHandler(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = request.auth.uid;
  const facilityType = request.data && request.data.facilityType;
  const facilityId = request.data && request.data.facilityId;
  validateInput(facilityType, facilityId);

  const db = admin.firestore();
  await assertFacilityAuthorized(db, facilityType, facilityId, uid);

  const config = FACILITY_TYPES[facilityType];
  const [legalConfig, facilitySnap] = await Promise.all([
    getLegalConfig(),
    db.collection(config.collection).doc(facilityId).get(),
  ]);
  const currentVersion = legalConfig[config.versionField];
  const acceptances = (facilitySnap.exists && facilitySnap.data().legalAcceptances) || {};
  const record = acceptances[config.acceptanceKey];

  return {
    status: {
      current: !!record && record.accepted === true && record.version === currentVersion,
      version: currentVersion,
    },
  };
}

async function acceptFacilityLegalAgreementHandler(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = request.auth.uid;
  const facilityType = request.data && request.data.facilityType;
  const facilityId = request.data && request.data.facilityId;
  const locale =
    request.data && typeof request.data.locale === "string" && request.data.locale
      ? request.data.locale
      : "en";
  validateInput(facilityType, facilityId);

  const db = admin.firestore();
  await assertFacilityAuthorized(db, facilityType, facilityId, uid);

  const config = FACILITY_TYPES[facilityType];
  const legalConfig = await getLegalConfig();
  const version = legalConfig[config.versionField];

  const facilityRef = db.collection(config.collection).doc(facilityId);
  const historyRef = facilityRef.collection("legalHistory").doc();

  await db.runTransaction(async (tx) => {
    // merge:true on the single nested acceptanceKey — a pharmacy accepting
    // its Pharmacy Agreement must never touch a lab's labAgreement, etc.
    // (each facility type only ever writes its own key, but merge:true is
    // the same defensive discipline used throughout this codebase's legal
    // writes regardless).
    tx.set(
      facilityRef,
      {
        legalAcceptances: {
          [config.acceptanceKey]: {
            accepted: true,
            version,
            acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
            acceptedBy: uid,
          },
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(historyRef, {
      historyId: historyRef.id,
      facilityType,
      documentType: config.acceptanceKey,
      version,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      acceptedBy: uid,
      locale,
    });
  });

  return { facilityType, documentType: config.acceptanceKey, version };
}

exports.getFacilityLegalStatus = onCall({ region: "us-central1" }, getFacilityLegalStatusHandler);
exports.acceptFacilityLegalAgreement = onCall(
  { region: "us-central1" },
  acceptFacilityLegalAgreementHandler,
);

// Exported for direct integration testing — bypasses the onCall/HTTPS
// wrapper entirely, same convention as legalConsent.js.
exports._getFacilityLegalStatusHandler = getFacilityLegalStatusHandler;
exports._acceptFacilityLegalAgreementHandler = acceptFacilityLegalAgreementHandler;
