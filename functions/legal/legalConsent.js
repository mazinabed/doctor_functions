"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getLegalConfig } = require("./legalConfig");

// Legal Consent Modernization (Phase 1 — account level only).
//
// Account-level legal consent for EVERY Healthcare user, mirroring
// Commerce's own legalConsent.ts pattern exactly: server-authoritative
// version, append-only history, client never supplies
// accepted/version/timestamp — only WHICH document it is accepting. The
// server resolves the current version via getLegalConfig() and stamps
// FieldValue.serverTimestamp() itself.
//
// Document-selection model (2026-08-08 redesign — see the
// patientTerms/providerTerms split below). Previously this file used a
// single "terms" document type and resolved patientTermsVersion vs.
// providerTermsVersion by reading the caller's OWN users/{uid}.role. That
// was proven unsafe: the same authenticated uid can legitimately be a
// Patient in TrustyDr-pwa AND a Provider (doctor/pharmacy_provider/
// diagnostic_provider/center staff) in doctor_portal at the same time,
// without users/{uid}.role ever changing — role represents the account's
// global/primary identity, not "which app is calling right now." Deriving
// the document from role meant a dual-context user's Patient Terms
// acceptance and Provider Terms acceptance collided in the same
// legalAcceptances.terms key, and would have silently used the wrong
// version the moment patientTermsVersion and providerTermsVersion ever
// diverged (they happen to both be "v2" today, which is exactly why this
// went undetected).
//
// The fix: the CLIENT declares which document it is accepting/checking —
// "patientTerms" or "providerTerms" — instead of the server inferring it
// from a mutable, account-global field. This is legal-record selection,
// not permission elevation: the authenticated uid always comes from
// request.auth (never client-supplied, exactly as before); declaring
// documentType only decides which of the caller's OWN legalAcceptances
// keys this call reads/writes. Nothing about role, membership, workspace,
// or facility access is granted or checked by this choice. TrustyDr-pwa
// always requests "patientTerms"; doctor_portal always requests
// "providerTerms"; neither app inspects users/{uid}.role to choose.
// "privacy" remains a single shared document/version for every Healthcare
// user, per the approved architecture — there is deliberately no separate
// patient/provider Privacy version.
//
// The old ambiguous legalAcceptances.terms field (and the pre-v2 flat
// legalAccepted/legalVersion fields) are NOT deleted or migrated — they
// are left in place as inert historical records and are never read by
// this handler. A user who only ever accepted the old "terms" key is
// correctly treated as not-current for BOTH patientTerms and
// providerTerms and must freshly accept under the new key.
//
// Facility-level agreements (Medical Center / Pharmacy / Lab-Imaging) are
// a later phase, on each facility's own doc (medical_centers/{centerId},
// pharmacy_providers/{uid}, diagnostic_providers/{uid}) — not implemented
// by this file, and entirely unaffected by this document-selection change
// (verified: the Commerce bridge's resolveHealthcareLegalCoverage /
// resolvePharmacyLegalCoverageCurrent only ever read facility-doc
// legalAcceptances, never users/{uid}.legalAcceptances).
//
// Every write below goes exclusively through these callables (Admin SDK,
// bypasses firestore.rules). users/{uid}.legalAcceptances and its
// legalHistory subcollection both deny ALL direct client writes in
// firestore.rules (touchesLegalAcceptances()) — matching this codebase's
// existing convention for accountLifecycle.

const LEGAL_DOCUMENT_TYPES = ["patientTerms", "providerTerms", "privacy"];

const VERSION_FIELD_BY_DOCUMENT_TYPE = {
  patientTerms: "patientTermsVersion",
  providerTerms: "providerTermsVersion",
  privacy: "privacyVersion",
};

function isValidDocumentType(value) {
  return typeof value === "string" && LEGAL_DOCUMENT_TYPES.includes(value);
}

function versionForDocument(documentType, config) {
  return config[VERSION_FIELD_BY_DOCUMENT_TYPE[documentType]];
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
  // Deliberately NOT reading userSnap.data().role — see this file's header
  // comment. Which document applies is determined entirely by which
  // documentType the caller asks about, never by the account's role.
  const acceptances = (userSnap.exists && userSnap.data().legalAcceptances) || {};

  const status = {};
  for (const documentType of LEGAL_DOCUMENT_TYPES) {
    const currentVersion = versionForDocument(documentType, config);
    // The old ambiguous "terms" key (pre-split) is never consulted here —
    // only the exact key matching this documentType. A record filed under
    // legalAcceptances.terms satisfies neither patientTerms nor
    // providerTerms, by construction (acceptances[documentType] simply
    // won't find it under either new key name).
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
    throw new HttpsError(
      "invalid-argument",
      "documentType must be 'patientTerms', 'providerTerms', or 'privacy'.",
    );
  }

  const config = await getLegalConfig();
  const version = versionForDocument(documentType, config);

  const db = admin.firestore();
  const userRef = db.collection("users").doc(uid);
  const historyRef = userRef.collection("legalHistory").doc();

  await db.runTransaction(async (tx) => {
    // merge:true on a single nested key merges into the existing
    // legalAcceptances map rather than replacing it — accepting
    // "patientTerms" never clobbers "providerTerms" or "privacy", and vice
    // versa, which is exactly what lets the same uid independently hold
    // both a current Patient Terms and a current Provider Terms
    // acceptance at once. Same discipline as Commerce's own
    // acceptAccountLegalDocument.
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
