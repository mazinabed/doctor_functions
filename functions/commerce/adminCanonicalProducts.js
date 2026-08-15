// TrustyDr Commerce Bridge — Canonical Product Foundation, Admin CRUD/review
// (Marketplace Platform Phase 1 — see trustydr-commerce's
// docs/progress/MARKETPLACE_PLATFORM_ROADMAP_PROGRESS.md).
//
// mydoctor_admin -> Healthcare -> Commerce, the exact same direction and
// trust boundary as adminMarketplaceCategories.js — mydoctor_admin has no
// Commerce Firebase config of its own. Admin identity here is verified
// against users/{uid}.role == "admin" in Firestore, same as every other
// admin relay in this file's family. Never re-derived on the Commerce
// side: Commerce's canonicalProductEngine.ts / canonicalProductMatchingEngine.ts
// trust the actorUid this relay asserts, exactly the same trust boundary
// adminMarketplaceCategories.js already relies on — the real proof the
// call came from Healthcare's own backend is the OIDC identity token
// getCommerceAuthHeaders mints, checked by Commerce's IAM invoker
// restriction (HEALTHCARE_SERVICE_ACCOUNT_EMAIL), not the actorUid field.
//
// Commerce Firestore (canonical_products / canonical_product_links) is the
// source of truth — this file only relays; it holds no matching/review
// logic of its own.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { getCommerceAuthHeaders } = require("./lib/commerceAuth");

const COMMERCE_BASE_URL = "https://us-central1-trustydr-commerce.cloudfunctions.net";

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }
  const userSnap = await getFirestore().collection("users").doc(request.auth.uid).get();
  if (userSnap.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

async function callCommerce(endpoint, body) {
  const targetUrl = `${COMMERCE_BASE_URL}/${endpoint}`;
  let response;
  try {
    const headers = await getCommerceAuthHeaders(targetUrl);
    response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[adminCanonicalProducts] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminCanonicalProducts] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    // Commerce's own validation errors (already-pending link, invalid
    // status transition, unknown canonicalId, etc.) are real, actionable
    // messages the admin UI should show as-is, not a generic failure.
    throw new HttpsError("invalid-argument", data?.error || "Request rejected by Commerce.");
  }
  return data;
}

exports.adminCreateCanonicalProduct = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  return callCommerce("createCanonicalProductForHealthcare", {
    actorUid: request.auth.uid,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    brandName: data.brandName,
    manufacturerName: data.manufacturerName,
    categoryKey: data.categoryKey,
    matchingAttributes: data.matchingAttributes,
    referenceBarcode: data.referenceBarcode,
    representativeImageUrl: data.representativeImageUrl,
  });
});

exports.adminUpdateCanonicalProduct = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.canonicalId || typeof data.canonicalId !== "string") {
    throw new HttpsError("invalid-argument", "canonicalId is required.");
  }
  return callCommerce("updateCanonicalProductForHealthcare", {
    actorUid: request.auth.uid,
    canonicalId: data.canonicalId,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    brandName: data.brandName,
    manufacturerName: data.manufacturerName,
    categoryKey: data.categoryKey,
    matchingAttributes: data.matchingAttributes,
    referenceBarcode: data.referenceBarcode,
    representativeImageUrl: data.representativeImageUrl,
    status: data.status,
  });
});

exports.adminListCanonicalProducts = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listCanonicalProductsForHealthcare", { actorUid: request.auth.uid });
});

exports.adminGetCanonicalProduct = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.canonicalId || typeof data.canonicalId !== "string") {
    throw new HttpsError("invalid-argument", "canonicalId is required.");
  }
  return callCommerce("getCanonicalProductForHealthcare", {
    actorUid: request.auth.uid,
    canonicalId: data.canonicalId,
  });
});

exports.adminListCanonicalLinkSuggestions = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  return callCommerce("listCanonicalLinkSuggestionsForHealthcare", {
    actorUid: request.auth.uid,
    canonicalId: data.canonicalId,
  });
});

exports.adminReviewCanonicalLink = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.orgId || !data.engineId || !data.action) {
    throw new HttpsError("invalid-argument", "orgId, engineId, and action are required.");
  }
  return callCommerce("reviewCanonicalLinkForHealthcare", {
    actorUid: request.auth.uid,
    orgId: data.orgId,
    engineId: data.engineId,
    action: data.action,
  });
});

exports.adminProposeCanonicalLink = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.orgId || !data.engineId || !data.canonicalId) {
    throw new HttpsError("invalid-argument", "orgId, engineId, and canonicalId are required.");
  }
  return callCommerce("proposeCanonicalLinkForHealthcare", {
    actorUid: request.auth.uid,
    orgId: data.orgId,
    engineId: data.engineId,
    canonicalId: data.canonicalId,
  });
});

// Odoo-connected on Commerce's side (barcode resolution via
// resolveIdentifier) — longer timeout than the plain-CRUD relays above,
// matching adminSyncMarketplaceCategoriesToOdoo's own precedent for the
// one Odoo-touching admin action in its family.
exports.adminGenerateCanonicalLinkSuggestions = onCall(
  { region: "us-central1", timeoutSeconds: 120 },
  async (request) => {
    await requireAdmin(request);
    const data = request.data || {};
    if (!data.canonicalId || typeof data.canonicalId !== "string") {
      throw new HttpsError("invalid-argument", "canonicalId is required.");
    }
    return callCommerce("generateCanonicalLinkSuggestionsForHealthcare", {
      actorUid: request.auth.uid,
      canonicalId: data.canonicalId,
    });
  },
);
