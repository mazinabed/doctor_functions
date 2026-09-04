"use strict";

// ─── Provider operational-status mirror ───────────────────────────────────────
//
// WHY THIS EXISTS
//
// centerAccessProvider resolves "may this organization operate right now" from
// the organization's own subscription dates. For a medical centre that document
// is medical_centers/{centerId}, which an active member may read. For a pharmacy
// or a laboratory it is pharmacy_providers/{uid} / diagnostic_providers/{uid},
// which firestore.rules deliberately restricts to the OWNER and admins —
// because those documents carry the owner's national ID number, their ID and
// licence document URLs, and their personal phone and email.
//
// So an invited pharmacy/lab staff member was told to read a document they must
// never be allowed to read: the subscription stream failed with
// permission-denied and the whole organization workspace rendered
// "Access error".
//
// Widening the parent read rule to members would have fixed the symptom by
// handing every employee their employer's identity documents. This mirror is
// the alternative: the FIVE fields the access decision actually consumes,
// projected by an admin-SDK trigger into a subcollection that active members
// may read, leaving the parent document exactly as private as it was.
//
// ─── THE CONTRACT ─────────────────────────────────────────────────────────────
//
//   pharmacy_providers/{pharmacyId}/operational/status
//   diagnostic_providers/{labId}/operational/status
//
// Server-owned in both directions: `allow write: if false` for every client,
// written only by the admin SDK (syncPharmacyOperationalStatus /
// syncLabOperationalStatus, and the backfill script).
//
// Field names are byte-identical to the parent's, so
// SubscriptionAccessRules.fromDocument / .effectiveStatus interpret the mirror
// and the parent with the same code and can never drift apart.
//
// ─── NEVER ADD TO THIS PROJECTION ─────────────────────────────────────────────
//
// This is an access-control projection, not a profile. Adding any of the
// following re-creates exactly the exposure this mirror exists to prevent:
//
//   nationalIdNumber, idFrontUrl, idBackUrl, licenseDocUrl, licenseNumber,
//   phone, email, contactName_*, facilityName_*, facilityAddress,
//   province*, city*, userId, claimedByUserId, onboardingStep,
//   verificationStatus, isVerified, legalAcceptances,
//   currentPlan, billingCycle, lastPaymentAt, lastPaymentAmountIQD,
//   nextBillingDate, subscriptionStart, trialStart,
//   or anything from the pharmacy_members / lab_members subcollections.
//
// If a future access rule genuinely needs another field, add it here WITH the
// reason it is required for an access decision — never "while we are at it".

const OPERATIONAL_COLLECTION = "operational";
const OPERATIONAL_DOC_ID = "status";

// The exact fields SubscriptionAccessRules consumes, and nothing else:
//
//   status              -> administrative suspension outranks any billing state
//                          (effectiveStatus: 'suspended' | 'rejected')
//   subscriptionStatus  -> distinguishes a running trial from a paid
//                          subscription, and marks 'pending_activation'
//   trialEnds           -> resolve(): trial window
//   subscriptionEnd     -> resolve(): paid window
//   gracePeriodEnds     -> resolve(): grace window
const MIRRORED_FIELDS = [
  "status",
  "subscriptionStatus",
  "trialEnds",
  "subscriptionEnd",
  "gracePeriodEnds",
];

// Normalizes one parent document into the mirror payload.
//
// Pure: takes and returns plain values, so the projection is assertable without
// a Firebase app — the same discipline SubscriptionAccessRules.sourceFor uses
// on the client, and for the same reason (WHICH fields cross the boundary is
// the security property, so it must be testable in isolation).
//
// Missing fields are written as explicit nulls rather than omitted, so a value
// CLEARED on the parent is also cleared on the mirror instead of lingering
// there and keeping a lapsed organization operational.
function buildOperationalStatus(data) {
  const source = data || {};
  const out = {};
  for (const field of MIRRORED_FIELDS) {
    out[field] = source[field] === undefined ? null : source[field];
  }
  return out;
}

// True when the projection would actually change.
//
// The trigger fires on every parent write — a profile edit, a rename, a
// document upload — and almost none of those touch a subscription field.
// Skipping the unchanged writes keeps this from doubling the write cost of
// every provider profile save.
function operationalStatusChanged(previousData, nextData) {
  const before = buildOperationalStatus(previousData);
  const after = buildOperationalStatus(nextData);
  for (const field of MIRRORED_FIELDS) {
    if (!sameValue(before[field], after[field])) return true;
  }
  return false;
}

// Firestore Timestamps are objects, so === is never right here. isEqual() is
// the Timestamp API's own comparison; everything else compares by value.
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  if (typeof a.isEqual === "function" && typeof b.isEqual === "function") {
    return a.isEqual(b);
  }
  if (typeof a.toMillis === "function" && typeof b.toMillis === "function") {
    return a.toMillis() === b.toMillis();
  }
  return false;
}

module.exports = {
  OPERATIONAL_COLLECTION,
  OPERATIONAL_DOC_ID,
  MIRRORED_FIELDS,
  buildOperationalStatus,
  operationalStatusChanged,
};
