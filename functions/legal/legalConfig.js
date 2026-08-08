"use strict";

const admin = require("firebase-admin");

// Legal Consent Modernization — mirrors Commerce's own
// functions/src/lib/legalConfig.ts exactly: the single authoritative
// source for "current" legal-document versions, read fresh by every
// legal-consent callable before it resolves or records an acceptance.
// One place a version bump is ever published: platformConfig/legal.
//
// Document CONTENT (the actual Patient Terms / Provider Terms / Privacy
// Policy / facility-agreement legal language) is out of scope for this
// module and lives entirely client-side, in each app's own legal asset
// bundle — this module only resolves version numbers; the backend never
// stores or serves document text.

const DEFAULT_LEGAL_CONFIG = {
  patientTermsVersion: "v1",
  providerTermsVersion: "v1",
  privacyVersion: "v1",
  medicalCenterAgreementVersion: "v1",
  pharmacyAgreementVersion: "v1",
  labAgreementVersion: "v1",
};

// Firestore-absent default — lets every environment (a fresh emulator, a
// project where platformConfig/legal hasn't been published yet) function
// correctly with "v1" for all six documents rather than throwing, while
// still letting a real deploy publish a genuine version bump simply by
// writing platformConfig/legal (Admin SDK / deploy script only —
// firestore.rules denies all client access to this collection, read
// included).
async function getLegalConfig() {
  const snap = await admin.firestore().collection("platformConfig").doc("legal").get();
  if (!snap.exists) return DEFAULT_LEGAL_CONFIG;
  const data = snap.data() || {};
  return {
    patientTermsVersion: data.patientTermsVersion || DEFAULT_LEGAL_CONFIG.patientTermsVersion,
    providerTermsVersion: data.providerTermsVersion || DEFAULT_LEGAL_CONFIG.providerTermsVersion,
    privacyVersion: data.privacyVersion || DEFAULT_LEGAL_CONFIG.privacyVersion,
    medicalCenterAgreementVersion:
      data.medicalCenterAgreementVersion || DEFAULT_LEGAL_CONFIG.medicalCenterAgreementVersion,
    pharmacyAgreementVersion:
      data.pharmacyAgreementVersion || DEFAULT_LEGAL_CONFIG.pharmacyAgreementVersion,
    labAgreementVersion: data.labAgreementVersion || DEFAULT_LEGAL_CONFIG.labAgreementVersion,
  };
}

module.exports = { getLegalConfig, DEFAULT_LEGAL_CONFIG };
