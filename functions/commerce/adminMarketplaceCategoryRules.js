// TrustyDr Commerce Bridge — Category <-> Attribute Rules (Admin CRUD).
//
// Admin Taxonomy phase (2026-08-29). Commerce has had
// setCategoryAttributeRuleForHealthcare /
// deleteCategoryAttributeRuleForHealthcare /
// listCategoryAttributeRulesForHealthcare deployed and IAM-restricted
// since Milestone 4 (2026-07-18), but no Healthcare relay was ever built
// for them — so the entire category-rules layer had no reachable admin
// path at all: mydoctor_admin has no Commerce Firebase config, and the
// Commerce endpoints reject any caller that is not this project's runtime
// service account. This file closes that gap and adds no logic of its
// own; every validation (unknown categoryKey, unknown attributeKey,
// status/override vocabulary, createdAt/createdBy preservation on
// re-save) stays in Commerce's marketplaceCategoryAttributeRules.ts.
//
// Same admin gate, same server-to-server trust boundary, and the same
// shared OIDC helper as adminMarketplaceCategories.js — deliberately
// importing lib/commerceAuth.js rather than re-deriving a private
// getAuthHeaders copy, which is what five of the seven existing relays
// did before this one (adminMarketplaceAttributes.js among them).
// actorUid remains an audit-trail label only; the Bearer OIDC token is
// what proves the request came from Healthcare's backend.
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
    console.error(`[adminMarketplaceCategoryRules] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminMarketplaceCategoryRules] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    // Commerce's own validation errors ("Unknown categoryKey(s): ...",
    // 'Attribute "x" does not exist.') are real, actionable messages the
    // admin UI should show as-is, not a generic failure.
    throw new HttpsError("invalid-argument", data?.error || "Request rejected by Commerce.");
  }
  return data;
}

exports.adminListCategoryAttributeRules = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.categoryKey || typeof data.categoryKey !== "string") {
    throw new HttpsError("invalid-argument", "categoryKey is required.");
  }
  return callCommerce("listCategoryAttributeRulesForHealthcare", {
    actorUid: request.auth.uid,
    categoryKey: data.categoryKey,
  });
});

// Upsert, keyed by (categoryKey, attributeKey) — Commerce stores the rule
// at attributeRules/{attributeKey} under the category, so re-sending the
// same pair edits in place rather than duplicating.
//
// Accepts EITHER `categoryKey` (single) or `categoryKeys` (array) and
// passes both straight through: Commerce's own parseCategoryKeys resolves
// the precedence and does the multi-category fan-out in one batch. That
// is what makes "assign this attribute to several categories at once" a
// single call from the admin UI rather than N sequential writes.
//
// The four *Override fields are pass-through nullables — null/absent
// means "inherit from the attribute definition", which is Commerce's own
// documented convention, not a sentinel invented here.
exports.adminSetCategoryAttributeRule = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.attributeKey || typeof data.attributeKey !== "string") {
    throw new HttpsError("invalid-argument", "attributeKey is required.");
  }
  const hasSingle = typeof data.categoryKey === "string" && data.categoryKey.trim().length > 0;
  const hasMany = Array.isArray(data.categoryKeys) && data.categoryKeys.length > 0;
  if (!hasSingle && !hasMany) {
    throw new HttpsError(
      "invalid-argument",
      "categoryKey or a non-empty categoryKeys array is required.",
    );
  }
  return callCommerce("setCategoryAttributeRuleForHealthcare", {
    actorUid: request.auth.uid,
    attributeKey: data.attributeKey,
    categoryKey: data.categoryKey,
    categoryKeys: data.categoryKeys,
    status: data.status,
    displayOrder: data.displayOrder,
    displayTypeOverride: data.displayTypeOverride,
    variantGeneratingOverride: data.variantGeneratingOverride,
    valuePolicyOverride: data.valuePolicyOverride,
    allowedUnitsOverride: data.allowedUnitsOverride,
  });
});

exports.adminDeleteCategoryAttributeRule = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.categoryKey || typeof data.categoryKey !== "string") {
    throw new HttpsError("invalid-argument", "categoryKey is required.");
  }
  if (!data.attributeKey || typeof data.attributeKey !== "string") {
    throw new HttpsError("invalid-argument", "attributeKey is required.");
  }
  return callCommerce("deleteCategoryAttributeRuleForHealthcare", {
    actorUid: request.auth.uid,
    categoryKey: data.categoryKey,
    attributeKey: data.attributeKey,
  });
});
