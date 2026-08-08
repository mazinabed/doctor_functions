"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getLegalConfig } = require("./legalConfig");

// Legal Consent Modernization (Phase 1 — account level only).
//
// Account-level Terms + Privacy consent for EVERY Healthcare user
// (patient or provider), mirroring Commerce's own legalConsent.ts
// pattern exactly: server-authoritative version, append-only history,
// client never supplies accepted/version/timestamp — only WHICH document
// it is accepting. The server resolves the current version via
// getLegalConfig() and stamps FieldValue.serverTimestamp() itself.
//
// "terms" resolves to a DIFFERENT authoritative version depending on the
// caller's own users/{uid}.role: patientTermsVersion for role ===
// 'patient', providerTermsVersion for everyone else (doctor,
// pharmacy_provider, diagnostic_provider, staff under any facility, or an
// unset/unknown role — the same "default to the non-patient population"
// convention resolveAccessContext.js already uses for an unrecognized
// role). "privacy" is the SAME single document/version for every
// Healthcare user, per the approved architecture — there is deliberately
// no separate patient/provider Privacy version.
//
// Facility-level agreements (Medical Center / Pharmacy / Lab-Imaging) are
// a later phase, on each facility's own doc (medical_centers/{centerId},
// pharmacy_providers/{uid}, diagnostic_providers/{uid}) — not implemented
// by this file.
//
// Every write below goes exclusively through these callables (Admin SDK,
// bypasses firestore.rules). users/{uid}.legalAcceptances and its
// legalHistory subcollection both deny ALL direct client writes in
// firestore.rules (touchesLegalAcceptances()) — matching this codebase's
// existing convention for accountLifecycle.

const LEGAL_DOCUMENT_TYPES = ["terms", "privacy"];

function isValidDocumentType(value) {
  return typeof value === "string" && LEGAL_DOCUMENT_TYPES.includes(value);
}

async function resolveIsPatient(uid) {
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  return userSnap.exists && userSnap.data().role === "patient";
}

function versionForDocument(documentType, config, isPatient) {
  if (documentType === "privacy") return config.privacyVersion;
  return isPatient ? config.patientTermsVersion : config.providerTermsVersion;
}

// Handlers are exported separately from their onCall wrapper (same shape
// Firebase Functions v2 always uses internally) specifically so tests can
// invoke them directly against the Firestore emulator with a plain
// {auth, data} request object — mirroring this repo's own established
// integration-test convention (see expireCenters.js /
// phase1b_expire_centers_integration.test.js), rather than standing up the
// full Functions HTTPS emulator just for two callables.

async function getAccountLegalStatusHandler(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = request.auth.uid;
  const db = admin.firestore();

  const [config, userSnap] = await Promise.all([
    getLegalConfig(),
    db.collection("users").doc(uid).get(),
  ]);
  const isPatient = userSnap.exists && userSnap.data().role === "patient";
  const acceptances = (userSnap.exists && userSnap.data().legalAcceptances) || {};

  const status = {};
  for (const documentType of LEGAL_DOCUMENT_TYPES) {
    const currentVersion = versionForDocument(documentType, config, isPatient);
    const record = acceptances[documentType];
    status[documentType] = {
      current: !!record && record.accepted === true && record.version === currentVersion,
      version: currentVersion,
    };
  }
  return { status };
}

async function acceptAccountLegalDocumentHandler(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = request.auth.uid;
  const documentType = request.data && request.data.documentType;
  const locale =
    request.data && typeof request.data.locale === "string" && request.data.locale
      ? request.data.locale
      : "en";

  if (!isValidDocumentType(documentType)) {
    throw new HttpsError("invalid-argument", "documentType must be 'terms' or 'privacy'.");
  }

  const [config, isPatient] = await Promise.all([getLegalConfig(), resolveIsPatient(uid)]);
  const version = versionForDocument(documentType, config, isPatient);

  const db = admin.firestore();
  const userRef = db.collection("users").doc(uid);
  const historyRef = userRef.collection("legalHistory").doc();

  await db.runTransaction(async (tx) => {
    // merge:true on a single nested key ("legalAcceptances.terms") merges
    // into the existing legalAcceptances map rather than replacing it —
    // accepting "terms" never clobbers a prior "privacy" acceptance, and
    // vice versa. Same discipline as Commerce's own acceptAccountLegalDocument.
    tx.set(
      userRef,
      {
        legalAcceptances: {
          [documentType]: {
            accepted: true,
            version,
            acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(historyRef, {
      historyId: historyRef.id,
      documentType,
      version,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      locale,
    });
  });

  return { documentType, version };
}

exports.getAccountLegalStatus = onCall({ region: "us-central1" }, getAccountLegalStatusHandler);
exports.acceptAccountLegalDocument = onCall(
  { region: "us-central1" },
  acceptAccountLegalDocumentHandler,
);

// Exported for direct integration testing (bypasses the onCall/HTTPS
// wrapper entirely) — not part of the deployed callable surface.
exports._getAccountLegalStatusHandler = getAccountLegalStatusHandler;
exports._acceptAccountLegalDocumentHandler = acceptAccountLegalDocumentHandler;
