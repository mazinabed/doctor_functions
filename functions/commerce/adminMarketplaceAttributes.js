// TrustyDr Commerce Bridge — Global Attribute Engine (Admin CRUD).
//
// mydoctor_admin -> Healthcare -> Commerce, identical shape to
// adminMarketplaceCategories.js (same direction, same admin gate, same
// OIDC-authenticated Commerce call pattern) — see that file's own header
// for the full rationale. Admin identity here is verified the exact same
// way: users/{uid}.role == "admin" in Healthcare's own Firestore, checked
// against this onCall's Firebase-verified request.auth.uid.
//
// Commerce Firestore is the source of truth for attribute/value
// definitions (TrustyDr-global, not store-owned) — this file only relays;
// all real logic (slug generation, enum validation, value-policy rules)
// lives in Commerce's marketplaceAttributeEngine.ts.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { GoogleAuth } = require("google-auth-library");
const fetch = require("node-fetch");

const COMMERCE_BASE_URL = "https://us-central1-trustydr-commerce.cloudfunctions.net";

const googleAuth = new GoogleAuth();
const idTokenClientsByUrl = new Map();

async function getAuthHeaders(targetUrl) {
  let client = idTokenClientsByUrl.get(targetUrl);
  if (!client) {
    client = await googleAuth.getIdTokenClient(targetUrl);
    idTokenClientsByUrl.set(targetUrl, client);
  }
  const headers = await client.getRequestHeaders(targetUrl);
  return { ...headers, "Content-Type": "application/json" };
}

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
    const headers = await getAuthHeaders(targetUrl);
    response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[adminMarketplaceAttributes] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminMarketplaceAttributes] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    throw new HttpsError("invalid-argument", data?.error || "Request rejected by Commerce.");
  }
  return data;
}

exports.adminListAttributeDefinitions = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listAttributeDefinitionsForHealthcare", {
    actorUid: request.auth.uid,
  });
});

exports.adminCreateAttributeDefinition = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  return callCommerce("createAttributeDefinitionForHealthcare", {
    actorUid: request.auth.uid,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    displayType: data.displayType,
    createVariant: data.createVariant,
    valuePolicy: data.valuePolicy,
    allowedUnits: data.allowedUnits,
    sortOrder: data.sortOrder,
    isActive: data.isActive,
    b2cApplicable: data.b2cApplicable,
    b2bApplicable: data.b2bApplicable,
  });
});

exports.adminUpdateAttributeDefinition = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.attributeKey || typeof data.attributeKey !== "string") {
    throw new HttpsError("invalid-argument", "attributeKey is required.");
  }
  return callCommerce("updateAttributeDefinitionForHealthcare", {
    actorUid: request.auth.uid,
    attributeKey: data.attributeKey,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    displayType: data.displayType,
    sortOrder: data.sortOrder,
    isActive: data.isActive,
    b2cApplicable: data.b2cApplicable,
    b2bApplicable: data.b2bApplicable,
    allowedUnits: data.allowedUnits,
  });
});

exports.adminDeleteAttributeDefinition = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.attributeKey || typeof data.attributeKey !== "string") {
    throw new HttpsError("invalid-argument", "attributeKey is required.");
  }
  return callCommerce("deleteAttributeDefinitionForHealthcare", {
    actorUid: request.auth.uid,
    attributeKey: data.attributeKey,
  });
});

exports.adminCreateAttributeValue = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.attributeKey || typeof data.attributeKey !== "string") {
    throw new HttpsError("invalid-argument", "attributeKey is required.");
  }
  return callCommerce("createAttributeValueForHealthcare", {
    actorUid: request.auth.uid,
    attributeKey: data.attributeKey,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    sortOrder: data.sortOrder,
    isActive: data.isActive,
    htmlColor: data.htmlColor,
  });
});

exports.adminUpdateAttributeValue = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.attributeKey || !data.valueKey) {
    throw new HttpsError("invalid-argument", "attributeKey and valueKey are required.");
  }
  return callCommerce("updateAttributeValueForHealthcare", {
    actorUid: request.auth.uid,
    attributeKey: data.attributeKey,
    valueKey: data.valueKey,
    nameEn: data.nameEn,
    nameAr: data.nameAr,
    nameKu: data.nameKu,
    sortOrder: data.sortOrder,
    isActive: data.isActive,
    htmlColor: data.htmlColor,
  });
});

exports.adminDeleteAttributeValue = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.attributeKey || !data.valueKey) {
    throw new HttpsError("invalid-argument", "attributeKey and valueKey are required.");
  }
  return callCommerce("deleteAttributeValueForHealthcare", {
    actorUid: request.auth.uid,
    attributeKey: data.attributeKey,
    valueKey: data.valueKey,
  });
});
