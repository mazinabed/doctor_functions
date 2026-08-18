// TrustyDr Commerce Bridge — B2B Marketplace Channels & Buyer Entitlement
// (Admin Control, Phase 4B.5, 2026-08-18).
//
// mydoctor_admin -> Healthcare -> Commerce, the exact same direction and
// trust boundary as adminSponsoredPlacements.js / adminB2BRegulatory.js (see
// either file's own header for the full reasoning): admin identity is
// verified here, against users/{uid}.role == "admin" in THIS project's own
// Firestore (the one canonical "admin" definition this ecosystem actually
// enforces — firestore.rules' isAdmin()), and every call to Commerce mints a
// real Google-signed OIDC identity token scoped to the target URL as
// audience. Commerce's endpoints are IAM-invoker-restricted to this
// project's own runtime service account (see Commerce's organizations.ts /
// HEALTHCARE_SERVICE_ACCOUNT_EMAIL) — a plain unauthenticated fetch,
// including one from a merchant's own authenticated session, is rejected by
// Cloud Run itself before Commerce's code ever runs. `actorUid` in the body
// is only ever an audit-trail label on the Commerce side, never the
// security boundary — THIS requireAdmin() call is the real gate.
//
// Security context: organizations/{orgId}.marketplaceChannels ("may this
// org sell in this channel at all") and .buyerScopes ("may this org
// purchase in this regulated category") are BOTH platform-controlled
// capabilities, deliberately never merchant-self-service — the exact same
// posture already established for sponsoredChannels. This relay is the only
// way an admin can grant either one, for the population neither is ever
// auto-granted for: a standalone (commerce_only-origin) Commerce
// organization wanting base B2B selling access or Healthcare Wholesale
// Marketplace buyer access without going through the Healthcare bridge.
// organization search reuses adminSearchOrganizations (adminSponsoredPlacements.js)
// verbatim — no second search endpoint.
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

// Same status-to-HttpsError mapping as adminSponsoredPlacements.js's own
// httpsErrorCodeForStatus.
function httpsErrorCodeForStatus(status) {
  if (status === 400) return "invalid-argument";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission-denied";
  if (status === 404) return "not-found";
  if (status === 409 || status === 422) return "failed-precondition";
  if (status >= 500) return "internal";
  return "invalid-argument";
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
    console.error(`[adminB2BMarketplaceAccess] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminB2BMarketplaceAccess] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    console.error(
      `[adminB2BMarketplaceAccess] ${endpoint} returned ${response.status}:`,
      JSON.stringify(data),
    );
    const code = httpsErrorCodeForStatus(response.status);
    const message =
      code === "internal"
        ? "Commerce Bridge reported an internal error. Check Commerce Cloud Function logs for details."
        : data?.error || data?.message || "Request rejected by Commerce.";
    throw new HttpsError(code, message);
  }
  return data;
}

// Grant/revoke organizations/{orgId}.marketplaceChannels ("b2c"/"b2b" base
// selling access). No document review required (unlike
// sellerRegulatoryScopes) — this is the plain "may this org sell here at
// all" gate; regulated-category selling still separately requires
// sellerRegulatoryScopes via the existing seller regulatory application
// flow (adminB2BRegulatory.js), unaffected by this grant.
exports.adminUpdateMarketplaceChannels = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, marketplaceChannels } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !Array.isArray(marketplaceChannels)) {
    throw new HttpsError("invalid-argument", "orgId and a marketplaceChannels array are required.");
  }
  return callCommerce("updateMarketplaceChannelsForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    marketplaceChannels,
  });
});

// Grant/revoke organizations/{orgId}.buyerScopes for a standalone Commerce
// org — the population the Healthcare-bridge auto-grant (activation.ts)
// never covers. Independent of marketplaceChannels/sellerRegulatoryScopes —
// an org can be a buyer, a seller, both, or neither.
exports.adminGrantBuyerScopes = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, buyerScopes } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !Array.isArray(buyerScopes)) {
    throw new HttpsError("invalid-argument", "orgId and a buyerScopes array are required.");
  }
  return callCommerce("grantBuyerScopesForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    buyerScopes,
  });
});
