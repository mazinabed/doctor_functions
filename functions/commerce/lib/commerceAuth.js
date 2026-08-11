'use strict';

// TrustyDr Commerce Bridge — Shared Healthcare -> Commerce OIDC Auth Helper.
//
// Single source for how every Healthcare-side caller of a PRIVATE Commerce
// bridge endpoint proves its identity to Commerce: a real Google-signed
// OIDC identity token, minted from this Cloud Function's own ambient
// runtime service-account credentials (no key file, no shared secret),
// scoped to the exact target URL as audience, attached as a Bearer token.
// This is the SAME mechanism adminMarketplaceCategories.js has used since
// the Milestone 2/3 admin-bridge security fix (2026-07-18) — extracted here
// (2026-08-11, Healthcare<->Commerce Bridge Security Hardening Stage 1) so
// every bridge caller shares one implementation instead of re-deriving it
// per file. Commerce's own Cloud Run IAM (roles/run.invoker restricted to
// this function's runtime service account) is what actually enforces this
// boundary — the token proves identity, IAM is what refuses everyone else.
//
// PRIVATE_COMMERCE_ENDPOINTS / PUBLIC_COMMERCE_ENDPOINTS below are the
// canonical Healthcare-side classification of every Commerce bridge
// endpoint this repo calls directly over HTTPS (not Commerce's own
// request.auth-gated onCall functions — those use a different, already-
// correct trust boundary and are out of scope here). This is the
// Healthcare-side counterpart to trustydr-commerce/deploy/commerce-functions/
// commerce-functions.config.json's own odooConnectedFunctions split; the
// two must be kept in sync. tests/commerce_bridge_auth_coverage.test.js
// statically enforces that every caller of a PRIVATE endpoint in this repo
// uses getCommerceAuthHeaders (via callCommerceAuthenticated), and that no
// PUBLIC endpoint caller does.
const { GoogleAuth } = require("google-auth-library");

const googleAuth = new GoogleAuth();
// One IdTokenClient per target URL, reused across warm-instance calls —
// each Cloud Function endpoint is its own distinct OIDC audience, so a
// client authenticated for one endpoint's audience cannot be reused for
// another.
const idTokenClientsByUrl = new Map();

async function getCommerceAuthHeaders(targetUrl) {
  let client = idTokenClientsByUrl.get(targetUrl);
  if (!client) {
    client = await googleAuth.getIdTokenClient(targetUrl);
    idTokenClientsByUrl.set(targetUrl, client);
  }
  const headers = await client.getRequestHeaders(targetUrl);
  return { ...headers, "Content-Type": "application/json" };
}

// Confirmed (live Cloud Run IAM audit, 2026-08-11) to accept a trusted
// patient/staff/admin identity field or perform a privileged Odoo/Firestore
// mutation, with this Healthcare backend as the only legitimate caller.
// syncAttributeDefinitionsToOdoo has no wired-up caller today (deliberately
// left orphaned rather than given a new relay it doesn't yet need — see
// docs/architecture/HEALTHCARE_COMMERCE_BRIDGE_SECURITY.md) but is listed
// here so the coverage test enforces authenticated calling on it the moment
// a caller is ever added.
const PRIVATE_COMMERCE_ENDPOINTS = new Set([
  "placeMarketplaceOrderForHealthcare",
  "quoteMarketplaceCartForHealthcare",
  "cancelMarketplaceOrderForHealthcare",
  "getMarketplaceOrderStatusForHealthcare",
  "startOrderPreparationForHealthcare",
  "completeOrderFulfillmentForHealthcare",
  "processDeliveryFailureForHealthcare",
  "submitProductReviewForHealthcare",
  "withdrawProductReviewForHealthcare",
  "getMyProductReviewForHealthcare",
  "syncMarketplaceCategoriesToOdoo",
  "syncAttributeDefinitionsToOdoo",
]);

// Public-by-design (no trusted identity, no privileged mutation) — listed
// here only so the two sets together document every bridge endpoint this
// repo calls. Callers of these must NOT be converted to
// callCommerceAuthenticated: no security benefit, and the coverage test
// would flag it as an unexplained deviation from the established public
// posture.
const PUBLIC_COMMERCE_ENDPOINTS = new Set([
  "getMarketplaceProductDetailForHealthcare",
  "getMarketplaceDeliveryMethodsForHealthcare",
  "getProductReviewsForHealthcare",
  "getMarketplaceCatalogForHealthcare",
  "getActiveMarketplaceStoresForHealthcare",
  "getEligibleStandaloneStoresForHealthcare",
]);

module.exports = {
  getCommerceAuthHeaders,
  PRIVATE_COMMERCE_ENDPOINTS,
  PUBLIC_COMMERCE_ENDPOINTS,
};
