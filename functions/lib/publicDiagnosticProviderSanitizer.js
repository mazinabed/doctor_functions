"use strict";

const admin = require("firebase-admin");

// ─── Search token builder ─────────────────────────────────────────────────────
function buildSearchTokens(values) {
  const tokens = new Set();
  for (const val of values) {
    if (val && typeof val === "string") {
      const trimmed = val.trim().toLowerCase();
      if (trimmed) tokens.add(trimmed);
    }
  }
  return Array.from(tokens);
}

// ─── Eligibility ──────────────────────────────────────────────────────────────
// Fail-closed. Any ambiguity → do not publish.
// All three conditions must be explicitly true.
function isProviderPublicEligible(data) {
  if (!data) return false;
  if (data.status !== "active") return false;
  if (data.isActive !== true) return false;
  if (data.isVerified !== true) return false;
  return true;
}

// ─── Safe field mapper ────────────────────────────────────────────────────────
// Only safe, patient-visible fields are included.
//
// NEVER add to this function:
//   nationalIdNumber, idFrontUrl, idBackUrl,
//   licenseDocUrl, licenseNumber,
//   billingCycle, currentPlan, subscriptionStatus, subscriptionStart,
//   subscriptionEnd, trialStart, trialEnds, lastPaymentAt, nextBillingDate,
//   paymentProvider, pendingBillingCycle,
//   claimedByUserId, userId (only used as centerId fallback, never exposed),
//   verificationStatus, submittedAt, onboardingStep,
//   lab_members subcollection data, private owner/staff/permission data.
//
// resolvedCenterId — optional override supplied by the trigger after querying
//   the provider's published schedules. Bypasses the data.centerId / data.userId
//   fallback chain when a verified schedule centerId is available.
function buildPublicProviderDoc(providerId, data, existingPublicData, resolvedCenterId) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Resolve image: http URLs only, never Storage gs:// URLs
  let imageUrl = "";
  if (typeof data.imageUrl === "string" && data.imageUrl.startsWith("http")) {
    imageUrl = data.imageUrl;
  }

  // centerId: resolvedCenterId (from schedule lookup in the trigger) wins.
  // Falls back to data.centerId stored in the private doc (set by the
  // syncLabCenterId trigger on schedule publish), then to userId, then providerId.
  // The userId fallback is a last resort — for diagnostic providers, userId equals
  // the lab owner's UID which is the same as providerId/doctorId in schedules,
  // NOT the medical_centers centerId. The trigger should always populate the
  // resolved value before this fallback is needed.
  const centerId = (
    (typeof resolvedCenterId === "string" && resolvedCenterId.trim()) ||
    (typeof data.centerId    === "string" && data.centerId.trim())    ||
    (typeof data.userId      === "string" && data.userId.trim())      ||
    providerId
  );

  // providerKind: derive from serviceGroup (canonical field in diagnostic_providers).
  // serviceGroup == 'imaging' → providerKind = 'imaging'
  // everything else (including 'laboratory') → providerKind = 'laboratory'
  const serviceGroup = (data.serviceGroup || data.providerKind || "laboratory").toString();
  const providerKind = serviceGroup === "imaging" ? "imaging" : "laboratory";

  // specialty_key: matches serviceGroup so chip-bar filters in the patient app
  // can filter by matching specialty doc serviceGroup → provider providerKind.
  const specialty_key = serviceGroup;

  // serviceCount: explicit field wins; fall back to counting service arrays if
  // present; default 0 until service catalog is built.
  let serviceCount = 0;
  if (typeof data.serviceCount === "number" && data.serviceCount >= 0) {
    serviceCount = Math.floor(data.serviceCount);
  } else if (Array.isArray(data.serviceKeys) && data.serviceKeys.length > 0) {
    serviceCount = data.serviceKeys.length;
  } else if (Array.isArray(data.services) && data.services.length > 0) {
    serviceCount = data.services.length;
  }

  // yearsOfExperience: numeric, safe to expose, 0 when absent.
  const yearsOfExperience =
    typeof data.yearsOfExperience === "number" && data.yearsOfExperience >= 0
      ? Math.floor(data.yearsOfExperience)
      : null;

  // mapLink: plain URL string, safe to expose.
  const mapLink =
    typeof data.mapLink === "string" && data.mapLink.startsWith("http")
      ? data.mapLink.trim()
      : null;

  // languages: array of language code strings, safe to expose.
  const languages = Array.isArray(data.languages) ? data.languages : [];

  // phone: public contact field. No canCall gate at this stage —
  // patient profile/contact button needs it unconditionally when present.
  const phone =
    typeof data.phone === "string" && data.phone.trim().length > 0
      ? data.phone.trim()
      : null;

  return {
    // ── IDs / routing ─────────────────────────────────────────────────────────
    // centerId is required for patient booking: schedules and slot locks are
    // keyed by centerId. Guaranteed non-empty via the three-level fallback above.
    providerId,
    centerId,

    // ── Identity ──────────────────────────────────────────────────────────────
    facilityName_en:       (data.facilityName_en || "").trim(),
    facilityName_ar:       (data.facilityName_ar || "").trim(),
    facilityName_ku:       (data.facilityName_ku || "").trim(),
    facilityName_lower:    (data.facilityName_en || "").toLowerCase(),
    facilityName_ar_lower: (data.facilityName_ar || "").toLowerCase(),
    facilityName_ku_lower: (data.facilityName_ku || "").toLowerCase(),
    imageUrl,

    // ── Public profile ────────────────────────────────────────────────────────
    bio_en:             (data.bio_en || "").trim(),
    bio_ar:             (data.bio_ar || "").trim(),
    bio_ku:             (data.bio_ku || "").trim(),
    languages,
    yearsOfExperience,
    mapLink,

    // ── Provider type ─────────────────────────────────────────────────────────
    providerKind,
    serviceGroup,
    specialty_key,
    specialty_en: (data.specialty_en || data.facilityName_en || "").trim(),
    specialty_ar: (data.specialty_ar || data.facilityName_ar || "").trim(),
    specialty_ku: (data.specialty_ku || data.facilityName_ku || "").trim(),

    // ── Service summary ───────────────────────────────────────────────────────
    serviceCount,

    // ── Location ─────────────────────────────────────────────────────────────
    province_key: data.province_key || "",
    city_key:     data.city_key     || "",
    province_en:  data.province_en  || "",
    province_ar:  data.province_ar  || "",
    province_ku:  data.province_ku  || "",
    city_en:      data.city_en      || "",
    city_ar:      data.city_ar      || "",
    city_ku:      data.city_ku      || "",
    facilityAddress: (data.facilityAddress || data.address || "").trim(),
    latitude:  data.latitude  ?? null,
    longitude: data.longitude ?? null,

    // ── Public contact ────────────────────────────────────────────────────────
    phone,

    // ── Social links (forwarded only when the provider has opted in) ──────────
    showSocialLinks: data.showSocialLinks === true,
    socialLinks:
      data.showSocialLinks === true &&
      data.socialLinks != null &&
      typeof data.socialLinks === "object"
        ? { ...data.socialLinks }
        : {},

    // ── Status / visibility ───────────────────────────────────────────────────
    status:     "active",
    isActive:   true,
    isVerified: true,
    isPublic:   true,

    // ── Rating ────────────────────────────────────────────────────────────────
    ratingAverage: typeof data.ratingAverage === "number" ? data.ratingAverage : 0,
    ratingCount:   typeof data.ratingCount   === "number" ? data.ratingCount   : 0,

    // ── Search tokens ─────────────────────────────────────────────────────────
    searchTokens: buildSearchTokens([
      data.facilityName_en,
      data.facilityName_ar,
      data.facilityName_ku,
      data.specialty_en,
      data.specialty_ar,
      data.specialty_ku,
      data.city_en,
      data.city_ar,
      data.city_ku,
      data.province_en,
      data.province_ar,
      data.facilityAddress,
    ]),

    // ── Timestamps ────────────────────────────────────────────────────────────
    syncedAt:  now,
    createdAt: existingPublicData?.createdAt || now,
  };
}

module.exports = { isProviderPublicEligible, buildPublicProviderDoc };
