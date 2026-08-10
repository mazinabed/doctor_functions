// TrustyDr Commerce Bridge — Product Ratings & Reviews, Phase 3 (2026-08-10).
//
// Patient-App-facing relay to trustydr-commerce's Phase 2 review endpoints
// (functions/src/marketplaceProductReview.ts), same direction and same
// established shape as marketplaceCheckout.js's own placeMarketplaceOrder/
// quoteMarketplaceCart: Firebase authentication is authoritative HERE —
// patientId is always request.auth.uid, never a client-submitted value —
// and this function forwards that server-derived identity + the patient's
// own server-resolved profile fields (name/phone) to Commerce over a plain
// HTTPS POST, mirroring marketplaceCheckout.js's callCommerce() exactly
// (see that file's own header comment for the Healthcare<->Commerce
// direction/trust convention this repeats). getProductReviews is the one
// exception — public/unauthenticated, matching getMarketplaceProductDetail.js's
// own public-browse posture, since a product's review list is non-sensitive
// general content, not patient-identity-bound.
//
// Scope note: the Healthcare<->Commerce bridge's OWN caller-authentication
// mechanism (or lack of one) is a separate, already-flagged, explicitly
// out-of-scope question for this milestone (see docs/progress/
// PRODUCT_RATINGS_REVIEWS_PROGRESS.md's Phase 3 completion notes) — this
// file deliberately matches the EXISTING marketplaceCheckout.js pattern
// byte-for-byte in that respect, not a new or different one.

const { HttpsError, onCall } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const COMMERCE_BASE_URL = "https://us-central1-trustydr-commerce.cloudfunctions.net";

// TrustyDr app locale ('en'/'ar'/'ku') -> Odoo res.lang code. Same mapping,
// same "no Kurdish res.lang on this instance" convention as
// marketplaceCheckout.js's own resolveOdooLang — duplicated rather than
// imported, matching that file's own established precedent for this exact
// constant (isCommerceBillingOperational is duplicated the same way, for
// the same "separate concern, not worth a shared module yet" reasoning).
const ODOO_LANG_BY_LOCALE = { en: "en_US", ar: "ar_001", ku: "ar_001" };
function resolveOdooLang(locale) {
  return ODOO_LANG_BY_LOCALE[locale] || undefined;
}

// Structured failure logging (permanent) — same shape as
// marketplaceCheckout.js's own callCommerce/throwLogged (error.cause
// preserved, `where` tags the exact call site). Duplicated here rather
// than imported: marketplaceCheckout.js does not export these helpers, and
// this milestone's instructions are explicit — do not refactor/modify the
// existing Marketplace relay file to extract shared helpers out of it.
async function callCommerce(endpoint, body) {
  const url = `${COMMERCE_BASE_URL}/${endpoint}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error("marketplaceProductReview bridge call failed", {
      error: String(err),
      stack: err && err.stack,
      message: err && err.message,
      cause: err && err.cause,
      where: "callCommerce.fetch",
      endpoint,
      url,
    });
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    logger.error("marketplaceProductReview bridge call failed", {
      error: String(err),
      stack: err && err.stack,
      message: err && err.message,
      cause: err && err.cause,
      where: "callCommerce.json_parse",
      endpoint,
      status: response.status,
    });
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  return { ok: response.ok, status: response.status, data };
}

function throwLogged(where, code, message, details, err) {
  logger.error("marketplaceProductReview failed", {
    error: err ? String(err) : message,
    stack: err ? err.stack : new Error(message).stack,
    message,
    cause: err && err.cause ? String(err.cause) : null,
    where,
    code,
    details: details || null,
  });
  throw new HttpsError(code, message, details);
}

// Same server-side identity resolution as marketplaceCheckout.js's own
// placeMarketplaceOrder — never trusts a client-submitted name/phone.
// Reused by submit/withdraw below (both require a real patientName, same
// as Commerce's own submitProductReviewForHealthcare/
// withdrawProductReviewForHealthcare — see that file's header comment).
async function resolvePatientProfile(db, patientId) {
  const patientProfileSnap = await db.collection("users").doc(patientId).get();
  const patientProfile = patientProfileSnap.exists ? patientProfileSnap.data() : {};
  const resolvedName = typeof patientProfile.name === "string" ? patientProfile.name.trim() : "";
  if (!resolvedName) {
    throwLogged(
      "resolve_patient_name",
      "failed-precondition",
      "Please complete your profile name before writing a review.",
      { patientProfileExists: patientProfileSnap.exists },
    );
  }
  const resolvedPhone =
    typeof patientProfile.phoneNumber === "string" && patientProfile.phoneNumber
      ? patientProfile.phoneNumber
      : undefined;
  return { resolvedName, resolvedPhone };
}

// Maps a Commerce review-endpoint error response to an HttpsError, same
// "structured code passed through, never a raw 500 leaked as text" pattern
// placeMarketplaceOrder already uses for Commerce's 409/403/400 responses.
function throwForReviewFailure(where, result) {
  if (result.status === 403 && result.data.error === "NOT_VERIFIED_PURCHASE") {
    throwLogged(
      where,
      "failed-precondition",
      result.data.message || "Only patients who have purchased this product may review it.",
      { code: "not_verified_purchase" },
    );
  }
  if (result.status === 400 && result.data.error === "INVALID_RATING_VALUE") {
    throwLogged(
      where,
      "invalid-argument",
      result.data.message || "Rating must be an integer from 1 to 5.",
      { code: "invalid_rating_value" },
    );
  }
  if (result.status === 400) {
    throwLogged(
      where,
      "invalid-argument",
      result.data.message || result.data.error || "Invalid request.",
      { code: result.data.error || null },
    );
  }
  throwLogged(
    where,
    "internal",
    result.data.error || result.data.message || "Could not process this review request.",
    { status: result.status, dataError: result.data.error || null },
  );
}

exports.submitProductReview = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throwLogged("auth_check", "unauthenticated", "You must be signed in to write a review.");
  }
  const patientId = request.auth.uid;

  const { engineId, rating, feedback, locale } = request.data || {};
  if (!engineId || typeof engineId !== "string") {
    throwLogged("validate_request_shape", "invalid-argument", "engineId is required.", { engineId: engineId || null });
  }
  if (typeof rating !== "number") {
    throwLogged("validate_request_shape", "invalid-argument", "rating is required and must be a number.", { rating: rating ?? null });
  }

  const db = admin.firestore();
  const { resolvedName, resolvedPhone } = await resolvePatientProfile(db, patientId);

  const result = await callCommerce("submitProductReviewForHealthcare", {
    engineId,
    patientRef: patientId,
    patientName: resolvedName,
    patientPhone: resolvedPhone,
    lang: resolveOdooLang(locale),
    rating,
    feedback: typeof feedback === "string" ? feedback : undefined,
  });

  if (!result.ok) {
    throwForReviewFailure("commerce_submit_review_failed", result);
  }

  return result.data;
});

exports.withdrawProductReview = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throwLogged("auth_check", "unauthenticated", "You must be signed in to withdraw a review.");
  }
  const patientId = request.auth.uid;

  const { engineId, locale } = request.data || {};
  if (!engineId || typeof engineId !== "string") {
    throwLogged("validate_request_shape", "invalid-argument", "engineId is required.", { engineId: engineId || null });
  }

  const db = admin.firestore();
  const { resolvedName, resolvedPhone } = await resolvePatientProfile(db, patientId);

  const result = await callCommerce("withdrawProductReviewForHealthcare", {
    engineId,
    patientRef: patientId,
    patientName: resolvedName,
    patientPhone: resolvedPhone,
    lang: resolveOdooLang(locale),
  });

  if (!result.ok) {
    throwForReviewFailure("commerce_withdraw_review_failed", result);
  }

  return result.data;
});

// Read-only — no profile resolution needed (Commerce's own
// getMyProductReviewForHealthcare never creates a partner for a read, see
// that endpoint's own doc comment), just the verified patientId.
exports.getMyProductReview = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throwLogged("auth_check", "unauthenticated", "You must be signed in.");
  }
  const patientId = request.auth.uid;

  const { engineId } = request.data || {};
  if (!engineId || typeof engineId !== "string") {
    throwLogged("validate_request_shape", "invalid-argument", "engineId is required.", { engineId: engineId || null });
  }

  const result = await callCommerce("getMyProductReviewForHealthcare", {
    engineId,
    patientRef: patientId,
  });

  if (!result.ok) {
    throwForReviewFailure("commerce_get_my_review_failed", result);
  }

  return result.data;
});

// Public/unauthenticated — a product's review list is non-sensitive
// general content, same posture as getMarketplaceProductDetail.js/
// getMarketplaceCatalog.js (deliberately NOT auth-gated; this function
// takes no action on request.auth.uid, so there is no login gate to
// remove/weaken).
exports.getProductReviews = onCall({ region: "us-central1" }, async (request) => {
  const { engineId, limit, offset } = request.data || {};
  if (!engineId || typeof engineId !== "string") {
    throw new HttpsError("invalid-argument", "engineId is required.");
  }

  let response;
  try {
    response = await fetch(`${COMMERCE_BASE_URL}/getProductReviewsForHealthcare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engineId,
        limit: typeof limit === "number" ? limit : undefined,
        offset: typeof offset === "number" ? offset : undefined,
      }),
    });
  } catch (err) {
    logger.error("[getProductReviews] network error reaching Commerce Bridge:", err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }

  if (!response.ok) {
    logger.error("[getProductReviews] Commerce Bridge returned status:", response.status);
    throw new HttpsError("internal", "Reviews are temporarily unavailable.");
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    logger.error("[getProductReviews] could not parse Commerce Bridge response:", err);
    throw new HttpsError("internal", "Reviews are temporarily unavailable.");
  }

  return data;
});

// Exported for focused unit testing (tests/marketplace_product_review.test.js)
// — pure/near-pure helpers, independent of the onCall wrapper, same
// convention as marketplaceCheckout.js's own bottom-of-file exports.
exports.resolveOdooLang = resolveOdooLang;
exports.throwForReviewFailure = throwForReviewFailure;
