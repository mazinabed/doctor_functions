// TrustyDr Commerce Bridge — Shared Marketplace Category Engine (Admin CRUD).
//
// mydoctor_admin -> Healthcare -> Commerce, the same direction as
// getMarketplaceCatalog.js/getActiveMarketplaceStores.js (Healthcare is the
// one Firebase project every TrustyDr client actually authenticates
// against; Commerce has no client-facing Auth surface of its own). Admin
// identity here is verified against users/{uid}.role == "admin" in
// Firestore — the ONE canonical "admin" definition this project actually
// relies on (see firestore.rules' isAdmin(), which every existing
// mydoctor_admin write path is gated by). Deliberately NOT
// request.auth.token.role: no code in this repo calls
// setCustomUserClaims, so that claim is never populated on a real admin's
// ID token (the lifecycle/ callables that check it —
// adminForceDeletion.js, adminPlaceLegalHold.js, restoreAccount.js —
// inherited the same wrong assumption and are latent-broken the same way;
// out of scope for this fix, left untouched). Never re-derived on the
// Commerce side: Commerce's marketplaceCategoryEngine.ts trusts the
// actorUid this relay asserts, exactly the same trust boundary every
// existing Commerce<->Healthcare bridge already relies on
// (resolveAccessContext.js, startCommerceTrial.js).
//
// Commerce Firestore is the source of truth for the taxonomy — this file
// only relays; it holds no category logic of its own (key generation,
// duplicate/cycle checks all live in marketplaceCategoryEngine.ts).
//
// Security fix (Milestone 2/3, Variant & Attribute Foundation, 2026-07-18):
// Commerce's admin CRUD endpoints are now IAM-invoker-restricted to THIS
// project's own runtime service account (see Commerce's
// HEALTHCARE_SERVICE_ACCOUNT_EMAIL doc comment) — a plain unauthenticated
// fetch() would now be rejected by Cloud Run itself before Commerce's code
// even runs. Every call mints a real Google-signed OIDC identity token
// scoped to the exact target URL as audience, and attaches it as a Bearer
// token. This is what actually proves "this request came from Healthcare's
// backend," not the actorUid field, which remains only an audit-trail
// label. Healthcare<->Commerce Bridge Security Hardening, Stage 1
// (2026-08-11): the OIDC-minting implementation itself now lives in
// lib/commerceAuth.js (extracted, not changed) — this file was the
// original source of that pattern; other bridge callers (marketplaceCheckout.js,
// marketplaceProductReview.js, pharmacyOrderActions.js) now share it too
// instead of each re-deriving their own copy.
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
    console.error(`[adminMarketplaceCategories] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminMarketplaceCategories] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    // Commerce's own validation errors (duplicate sibling, circular move,
    // products still assigned, etc.) are real, actionable messages the
    // admin UI should show as-is, not a generic failure.
    throw new HttpsError("invalid-argument", data?.error || "Request rejected by Commerce.");
  }
  return data;
}

exports.adminListMarketplaceCategories = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listMarketplaceCategoriesForHealthcare", {
    actorUid: request.auth.uid,
  });
});

exports.adminCreateMarketplaceCategory = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  return callCommerce("createMarketplaceCategoryForHealthcare", {
    actorUid: request.auth.uid,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    descriptionEn: data.descriptionEn,
    descriptionAr: data.descriptionAr,
    descriptionKu: data.descriptionKu,
    parentCategoryKey: data.parentCategoryKey ?? null,
    iconKey: data.iconKey,
    sortOrder: data.sortOrder,
    featured: data.featured,
    isActive: data.isActive,
    storeTypes: data.storeTypes,
    // Admin Taxonomy Phase 3 (2026-08-29) — Commerce has accepted and
    // validated this since Phase 4B.1, but this relay dropped it, so no
    // path in the system could ever set a category's regulatory
    // classification and every category sat at the general_healthcare
    // default. That left the B2B pharmaceutical gate inert in production.
    // Passed straight through; the vocabulary is validated server-side by
    // isValidCategoryRegulatoryScope, not here.
    regulatoryScope: data.regulatoryScope,
  });
});

exports.adminUpdateMarketplaceCategory = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.categoryKey || typeof data.categoryKey !== "string") {
    throw new HttpsError("invalid-argument", "categoryKey is required.");
  }
  return callCommerce("updateMarketplaceCategoryForHealthcare", {
    actorUid: request.auth.uid,
    categoryKey: data.categoryKey,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    descriptionEn: data.descriptionEn,
    descriptionAr: data.descriptionAr,
    descriptionKu: data.descriptionKu,
    iconKey: data.iconKey,
    sortOrder: data.sortOrder,
    featured: data.featured,
    isActive: data.isActive,
    storeTypes: data.storeTypes,
    // See the create relay above. Commerce only applies this when the key
    // is present in the body, so an admin UI that omits it leaves the
    // existing classification untouched rather than resetting it.
    regulatoryScope: data.regulatoryScope,
  });
});

exports.adminMoveMarketplaceCategory = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.categoryKey || typeof data.categoryKey !== "string") {
    throw new HttpsError("invalid-argument", "categoryKey is required.");
  }
  return callCommerce("moveMarketplaceCategoryForHealthcare", {
    actorUid: request.auth.uid,
    categoryKey: data.categoryKey,
    newParentCategoryKey: data.newParentCategoryKey ?? null,
  });
});

exports.adminDeleteMarketplaceCategory = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.categoryKey || typeof data.categoryKey !== "string") {
    throw new HttpsError("invalid-argument", "categoryKey is required.");
  }
  return callCommerce("deleteMarketplaceCategoryForHealthcare", {
    actorUid: request.auth.uid,
    categoryKey: data.categoryKey,
  });
});

// Push-sync trigger — admin explicitly (or the admin UI automatically,
// right after a create/update/move) asks Commerce to push the current
// engine state to Odoo. Separate Commerce function
// (syncMarketplaceCategoriesToOdoo) because it's Odoo-connected (VPC +
// secret), deployed via the raw-gcloud path, unlike the plain-Firestore
// CRUD functions above.
exports.adminSyncMarketplaceCategoriesToOdoo = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("syncMarketplaceCategoriesToOdoo", {
    actorUid: request.auth.uid,
  });
});

// Bulk Taxonomy Importer relay — same admin gate, same server-to-server
// trust boundary as the other six. `rows`/`dryRun`/`importBatchId` pass
// through untouched; all real validation (categoryKey derivation, duplicate
// sibling, missing-parent, circular-hierarchy checks) happens in Commerce's
// bulkImportMarketplaceCategoriesForHealthcare, reusing the exact same
// helpers the single-row CRUD functions use — this relay adds no logic of
// its own beyond the admin check, same as every other function here.
exports.adminBulkImportMarketplaceCategories = onCall(
  { region: "us-central1", timeoutSeconds: 180 },
  async (request) => {
    await requireAdmin(request);
    const data = request.data || {};
    if (!Array.isArray(data.rows) || data.rows.length === 0) {
      throw new HttpsError("invalid-argument", "rows is required and must be a non-empty array.");
    }
    return callCommerce("bulkImportMarketplaceCategoriesForHealthcare", {
      actorUid: request.auth.uid,
      rows: data.rows,
      dryRun: data.dryRun === true,
      importBatchId: typeof data.importBatchId === "string" ? data.importBatchId : undefined,
    });
  },
);
