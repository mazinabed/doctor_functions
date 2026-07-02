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
// Fail-closed. status must be 'active' and isVerified must be explicitly true.
// Pharmacy providers do not require isActive (subscription field) for public
// discovery — admin verification (isVerified) is the gate.
function isPharmacyPublicEligible(data) {
  if (!data) return false;
  if (data.status !== "active") return false;
  if (data.isVerified !== true) return false;
  return true;
}

// ─── Safe field mapper ────────────────────────────────────────────────────────
// Only safe, patient-visible fields are included.
//
// NEVER add to this function:
//   idFrontUrl, idBackUrl, licenseDocUrl, licenseNumber,
//   billingCycle, subscriptionStatus, subscriptionStart, subscriptionEnd,
//   trialStart, trialEnds, lastPaymentAt, nextBillingDate,
//   userId, claimedByUserId, onboardingStep, verificationStatus,
//   pharmacy_members subcollection data, private owner/staff/permission data.
function buildPublicPharmacyDoc(pharmacyId, data, existingPublicData) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Image: http URLs only, never Storage gs:// URLs.
  let imageUrl = "";
  if (typeof data.imageUrl === "string" && data.imageUrl.startsWith("http")) {
    imageUrl = data.imageUrl;
  }

  // Name: prefer name_* fields (set by pharmacy profile page),
  // fall back to clinicName_* (legacy or alternative field).
  const facilityName_en = (data.name_en || data.clinicName_en || "").trim();
  const facilityName_ar = (data.name_ar || data.clinicName_ar || "").trim();
  const facilityName_ku = (data.name_ku || data.clinicName_ku || "").trim();

  // Phone: public contact field.
  const phone =
    typeof data.phone === "string" && data.phone.trim().length > 0
      ? data.phone.trim()
      : null;

  // mapLink: plain URL, safe to expose.
  const mapLink =
    typeof data.mapLink === "string" && data.mapLink.startsWith("http")
      ? data.mapLink.trim()
      : null;

  // centerId: populated when pharmacy creates/connects a medical_center.
  const centerId =
    typeof data.centerId === "string" && data.centerId.trim()
      ? data.centerId.trim()
      : null;

  // operationHours: { monday: { isOpen, open, close }, … }
  // Safe to expose — contains only business hours, no PII.
  let operationHours = null;
  if (data.operationHours && typeof data.operationHours === "object") {
    operationHours = { ...data.operationHours };
  }

  return {
    // ── IDs / routing ─────────────────────────────────────────────────────────
    providerId: pharmacyId,
    centerId,

    // ── Identity ──────────────────────────────────────────────────────────────
    facilityName_en,
    facilityName_ar,
    facilityName_ku,
    facilityName_lower:    facilityName_en.toLowerCase(),
    facilityName_ar_lower: facilityName_ar.toLowerCase(),
    facilityName_ku_lower: facilityName_ku.toLowerCase(),
    imageUrl,

    // ── Provider type ─────────────────────────────────────────────────────────
    providerKind: "pharmacy",
    serviceGroup: "pharmacy",
    specialty_key: "pharmacy",

    // ── Location ─────────────────────────────────────────────────────────────
    province_key: data.province_key || "",
    city_key:     data.city_key     || "",
    province_en:  data.province_en  || "",
    province_ar:  data.province_ar  || "",
    province_ku:  data.province_ku  || "",
    city_en:      data.city_en      || "",
    city_ar:      data.city_ar      || "",
    city_ku:      data.city_ku      || "",
    facilityAddress: (data.clinicAddress || data.facilityAddress || data.address || "").trim(),
    latitude:  data.latitude  ?? null,
    longitude: data.longitude ?? null,
    mapLink,

    // ── Public contact ────────────────────────────────────────────────────────
    phone,

    // ── Social links ──────────────────────────────────────────────────────────
    showSocialLinks: data.showSocialLinks === true,
    socialLinks:
      data.showSocialLinks === true &&
      data.socialLinks != null &&
      typeof data.socialLinks === "object"
        ? { ...data.socialLinks }
        : {},

    // ── Operation hours ───────────────────────────────────────────────────────
    operationHours,

    // ── Status / visibility ───────────────────────────────────────────────────
    status:     "active",
    isVerified: true,
    isPublic:   true,

    // ── Rating ────────────────────────────────────────────────────────────────
    ratingAverage: typeof data.ratingAverage === "number" ? data.ratingAverage : 0,
    ratingCount:   typeof data.ratingCount   === "number" ? data.ratingCount   : 0,

    // ── Search tokens ─────────────────────────────────────────────────────────
    searchTokens: buildSearchTokens([
      facilityName_en,
      facilityName_ar,
      facilityName_ku,
      data.city_en,
      data.city_ar,
      data.province_en,
      data.clinicAddress || data.facilityAddress,
    ]),

    // ── Timestamps ────────────────────────────────────────────────────────────
    syncedAt:  now,
    createdAt: existingPublicData?.createdAt || now,
  };
}

module.exports = { isPharmacyPublicEligible, buildPublicPharmacyDoc };
