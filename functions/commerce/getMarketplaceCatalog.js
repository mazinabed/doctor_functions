// TrustyDr Commerce Bridge — Phase 1C (Patient Marketplace, browse-only).
//
// Patient-App-facing counterpart to the read-only bridge functions in this
// directory. Unlike resolveAccessContext/resolveStaffStoreAccess/
// startCommerceTrial (which run Commerce -> Healthcare), this one runs the
// OPPOSITE direction: Healthcare -> Commerce. It's the ONLY way the Patient
// App can ever see marketplace catalog data — patients never call Commerce,
// and never call Odoo, directly (ADR-C002, COMMERCE_DOMAIN_BOUNDARIES.md §5).
//
// Auth pattern matches this codebase's other Patient-App-facing callables
// (see lifecycle/requestAccountDeletion.js) — onCall + request.auth, NOT the
// onRequest + manual-idToken-verification shape the Commerce-facing bridge
// files use, since here the caller IS a Firebase-Auth'd client SDK, not a
// server-to-server call.
//
// This function itself does no Firestore reads of its own — it's a thin,
// authenticated relay to Commerce's getMarketplaceCatalogForHealthcare
// (trustydr-commerce/functions/src/marketplaceBridge.ts), which already
// returns only already-published, patient-visible fields (Minimum Data
// Exchange Principle, matching every other bridge function in this repo).

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const fetch = require("node-fetch");

const COMMERCE_MARKETPLACE_BRIDGE_URL =
  "https://us-central1-trustydr-commerce.cloudfunctions.net/getMarketplaceCatalogForHealthcare";

exports.getMarketplaceCatalog = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  const { orgId } = request.data || {};
  if (!orgId || typeof orgId !== "string") {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }

  let response;
  try {
    response = await fetch(COMMERCE_MARKETPLACE_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
  } catch (err) {
    console.error("[getMarketplaceCatalog] network error reaching Commerce Bridge:", err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }

  if (!response.ok) {
    console.error("[getMarketplaceCatalog] Commerce Bridge returned status:", response.status);
    throw new HttpsError("internal", "Marketplace data is temporarily unavailable.");
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error("[getMarketplaceCatalog] could not parse Commerce Bridge response:", err);
    throw new HttpsError("internal", "Marketplace data is temporarily unavailable.");
  }

  return {
    products: Array.isArray(data.products) ? data.products : [],
    categories: Array.isArray(data.categories) ? data.categories : [],
  };
});
