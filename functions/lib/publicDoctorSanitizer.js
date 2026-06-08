"use strict";

const admin = require("firebase-admin");
const { isDoctorPubliclyEligible } = require("../lifecycle/lifecycleEligibility");

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
// Lifecycle check is delegated to lifecycleEligibility — that module owns the rule.

function isPublicEligible(data) {
  if (!data) return false;
  // Lifecycle gate: doctors in deletionPending/deleted/archived must not appear in public_doctors.
  if (!isDoctorPubliclyEligible(data)) return false;
  if (data.status !== "active") return false;
  // isActive absent = OK; explicitly false = not eligible
  if (data.isActive === false) return false;
  // Any verification path satisfies the gate
  const verified =
    data.isVerified === true ||
    data.verified === true ||
    data.verificationStatus === "verified";
  if (!verified) return false;
  return true;
}

// ─── Safe field mapper ────────────────────────────────────────────────────────
// Derived from patient DoctorProfile UI contract (doctor_profile.dart).
// existingPublicData: current public_doctors doc data, or null (first sync).
//
// NEVER add to this function: nationalIdNumber, idFrontUrl, idBackUrl,
// licenseUrl, licenseNumber, nationalIdUrl, email, phone, userId,
// claimedByUserId, billing/subscription/trial fields, onboarding/admin fields.

function buildPublicDoc(doctorId, data, existingPublicData) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Resolve image: imageUrl primary (photos is null in real docs)
  let imageUrl = "";
  if (typeof data.imageUrl === "string" && data.imageUrl.startsWith("http")) {
    imageUrl = data.imageUrl;
  } else if (Array.isArray(data.photos) && data.photos.length > 0) {
    const first = String(data.photos[0]);
    if (first.startsWith("http")) imageUrl = first;
  }

  return {
    // ── Identity ─────────────────────────────────────────────────────────────
    doctorId,
    name:       data.name       || "",
    name_en:    data.name_en    || data.name || "",
    name_ar:    data.name_ar    || data.name || "",
    name_ku:    data.name_ku    || data.name || "",
    name_lower:    data.name_lower || (data.name_en || data.name || "").toLowerCase(),
    name_ar_lower: (data.name_ar || "").toLowerCase(),
    name_ku_lower: (data.name_ku || "").toLowerCase(),
    imageUrl,
    photos: Array.isArray(data.photos)
      ? data.photos.filter((p) => String(p).startsWith("http"))
      : [],
    gender: data.gender || null,

    // ── Specialty ────────────────────────────────────────────────────────────
    specialtyKey:     data.specialtyKey  || data.specialty_key || "",
    specialty_key:    data.specialty_key || data.specialtyKey  || "",
    specialty:        data.specialty        || "",
    specialty_en:     data.specialty_en     || data.specialtyName_en || "",
    specialty_ar:     data.specialty_ar     || data.specialtyName_ar || "",
    specialty_ku:     data.specialty_ku     || data.specialtyName_ku || "",
    specialtyName_en: data.specialtyName_en || data.specialty_en     || "",
    specialtyName_ar: data.specialtyName_ar || data.specialty_ar     || "",
    specialtyName_ku: data.specialtyName_ku || data.specialty_ku     || "",
    specialty_lower:  data.specialty_lower  ||
      (data.specialty_en || data.specialtyName_en || data.specialty || "").toLowerCase(),

    // ── Bio / profile ────────────────────────────────────────────────────────
    about:           data.about    || data.bio_en || data.bio_ar || "",
    about_en:        data.about_en || data.bio_en || data.about  || "",
    about_ar:        data.about_ar || data.bio_ar || data.about  || "",
    about_ku:        data.about_ku || data.bio_ku || data.about  || "",
    experienceYears: typeof data.yearsOfExperience === "number"
      ? data.yearsOfExperience
      : typeof data.experienceYears === "number" ? data.experienceYears : null,
    languages: Array.isArray(data.languages) ? data.languages : [],

    // ── Location ─────────────────────────────────────────────────────────────
    province_key: data.province_key || data.provinceKey  || "",
    provinceKey:  data.provinceKey  || data.province_key || "",
    province:     data.province     || data.province_en  || "",
    province_en:  data.province_en  || data.province     || "",
    province_ar:  data.province_ar  || "",
    province_ku:  data.province_ku  || "",
    city_key:     data.city_key || data.cityKey  || "",
    cityKey:      data.cityKey  || data.city_key || "",
    city:         data.city     || data.city_en  || "",
    city_en:      data.city_en  || data.city     || "",
    city_ar:      data.city_ar  || "",
    city_ku:      data.city_ku  || "",
    latitude:     data.latitude  ?? null,
    longitude:    data.longitude ?? null,

    // ── Clinic / center ───────────────────────────────────────────────────────
    centerId:      data.centerId      || "",
    clinicName:    data.clinicName    || data.clinicName_en || "",
    clinicName_en: data.clinicName_en || data.clinicName    || "",
    clinicName_ar: data.clinicName_ar || "",
    clinicName_ku: data.clinicName_ku || "",

    // ── Booking flags ─────────────────────────────────────────────────────────
    canBook: data.canBook === true,
    canCall: data.canCall === true,

    // ── Social links ──────────────────────────────────────────────────────────
    // Only exposed when the doctor explicitly enables showSocialLinks.
    // Each value is validated: must be a non-empty http/https URL.
    // Non-http/https values (javascript:, tel:, etc.) are silently dropped.
    showSocialLinks: data.showSocialLinks === true,
    socialLinks: (data.showSocialLinks === true &&
                  data.socialLinks !== null &&
                  typeof data.socialLinks === 'object')
      ? Object.fromEntries(
          ['instagram', 'facebook', 'tiktok', 'youtube', 'website']
            .filter(k =>
              typeof data.socialLinks[k] === 'string' &&
              /^https?:\/\//i.test(data.socialLinks[k].trim())
            )
            .map(k => [k, data.socialLinks[k].trim()])
        )
      : null,

    // ── Public contact ────────────────────────────────────────────────────────
    // phone: only exposed when canCall is explicitly true (admin-controlled gate).
    //        Fail-closed: absent canCall → null, never leaked.
    // email: exposed when the doctor entered a public contact email during
    //        onboarding. accountEmail (auth/login) is a separate field and is
    //        never referenced here.
    phone: (data.canCall === true &&
            typeof data.phone === 'string' &&
            data.phone.trim().length > 0)
      ? data.phone.trim()
      : null,
    email: (typeof data.email === 'string' && data.email.trim().length > 0)
      ? data.email.trim()
      : null,

    // ── Status / visibility ───────────────────────────────────────────────────
    status:     "active",
    isActive:   true,
    isVerified: data.isVerified === true || data.verified === true,
    isPublic:   true,

    // ── Rating ───────────────────────────────────────────────────────────────
    ratingAverage: typeof data.ratingAverage === "number" ? data.ratingAverage : 0,
    ratingCount:   typeof data.ratingCount   === "number" ? data.ratingCount   : 0,

    // ── Search tokens ─────────────────────────────────────────────────────────
    searchTokens: buildSearchTokens([
      data.name_en,     data.name_ar,     data.name_ku,     data.name,
      data.specialty_en   || data.specialtyName_en,
      data.specialty_ar   || data.specialtyName_ar,
      data.specialty_ku   || data.specialtyName_ku,
      data.specialty,
      data.clinicName_en, data.clinicName_ar, data.clinicName_ku, data.clinicName,
      data.city_en,     data.city_ar,     data.city_ku,
      data.province_en, data.province_ar, data.province_ku,
    ]),

    // ── Timestamps ────────────────────────────────────────────────────────────
    syncedAt:  now,
    createdAt: existingPublicData?.createdAt || now,
  };
}

module.exports = { isPublicEligible, buildPublicDoc };
