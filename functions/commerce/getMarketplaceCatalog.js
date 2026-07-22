// TrustyDr Commerce Bridge — Phase 1C (Patient Marketplace, browse-only).
//
// Patient-App-facing counterpart to the read-only bridge functions in this
// directory. Unlike resolveAccessContext/resolveStaffStoreAccess/
// startCommerceTrial (which run Commerce -> Healthcare), this one runs the
// OPPOSITE direction: Healthcare -> Commerce. It's the ONLY way the Patient
// App can ever see marketplace catalog data — patients never call Commerce,
// and never call Odoo, directly (ADR-C002, COMMERCE_DOMAIN_BOUNDARIES.md §5).
//
// PUBLIC BROWSE (2026-07-15): deliberately NOT auth-gated. Guests must be
// able to browse the full public Marketplace without logging in, matching
// TrustyDr's existing healthcare discovery model (doctor/center browse is
// also unauthenticated; auth is required only for protected actions —
// booking, cart, checkout, prescriptions, order history). This function
// takes no action on request.auth.uid and never did — the auth check
// removed here was a pure access gate, not used for scoping/personalization,
// so removing it changes nothing about what data is returned to whom.
// Still onCall (not onRequest) — the caller is a Firebase client SDK either
// way, authenticated or not; onCall handles both without any code change on
// this function's part, so the transport shape didn't need to change, only
// the gate.
//
// This function itself does no Firestore reads of its own — it's a thin
// relay to Commerce's getMarketplaceCatalogForHealthcare
// (trustydr-commerce/functions/src/marketplaceBridge.ts), which already
// returns only already-published, patient-visible fields (Minimum Data
// Exchange Principle, matching every other bridge function in this repo) —
// that field-level guarantee is what actually keeps this safe to expose
// publicly, not the (now-removed) login check.

const { HttpsError, onCall } = require("firebase-functions/v2/https");
const fetch = require("node-fetch");

const COMMERCE_MARKETPLACE_BRIDGE_URL =
  "https://us-central1-trustydr-commerce.cloudfunctions.net/getMarketplaceCatalogForHealthcare";

exports.getMarketplaceCatalog = onCall({ region: "us-central1" }, async (request) => {
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
    // Store Branding V1 (2026-07-22) — real, merchant-controlled storefront
    // identity for this one orgId, sourced the same way products/categories
    // are (a thin relay of Commerce's own response — see
    // marketplaceBridge.ts's brandingFromOrgDoc). Null fields mean "not
    // uploaded yet", not an error; the Patient App's existing
    // gradient/icon fallback already handles that.
    store: data.store && typeof data.store === "object" ? data.store : null,
  };
});
