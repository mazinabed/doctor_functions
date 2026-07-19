// TrustyDr Commerce Bridge — Patient Product Experience (Milestone 5,
// 2026-07-19).
//
// Patient-App-facing counterpart to getMarketplaceCatalog.js, same
// direction (Healthcare -> Commerce) and same public-browse posture
// (deliberately NOT auth-gated — see that file's own header for why: this
// function takes no action on request.auth.uid and never did, so removing
// a login gate changes nothing about what data is returned to whom).
//
// Unlike getMarketplaceCatalog (a thin relay over the ~15-minute-stale
// marketplace_products cache), this relays to a LIVE, single-product Odoo
// read on the Commerce side (getMarketplaceProductDetailForHealthcare,
// trustydr-commerce/functions/src/marketplaceProductDetail.ts) — see that
// file's own header for why a live read exists here specifically: current
// price/stock per variant, which a 15-minute cache cannot answer once
// products have real variants. This function itself does no Firestore
// reads and no Odoo access of its own — it's a thin relay, same as every
// other bridge function in this repo (Minimum Data Exchange Principle).

const { HttpsError, onCall } = require("firebase-functions/v2/https");
const fetch = require("node-fetch");

const COMMERCE_PRODUCT_DETAIL_BRIDGE_URL =
  "https://us-central1-trustydr-commerce.cloudfunctions.net/getMarketplaceProductDetailForHealthcare";

exports.getMarketplaceProductDetail = onCall({ region: "us-central1" }, async (request) => {
  const { orgId, engineId } = request.data || {};
  if (!orgId || typeof orgId !== "string") {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }
  if (!engineId || typeof engineId !== "string") {
    throw new HttpsError("invalid-argument", "engineId is required.");
  }

  let response;
  try {
    response = await fetch(COMMERCE_PRODUCT_DETAIL_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, engineId }),
    });
  } catch (err) {
    console.error("[getMarketplaceProductDetail] network error reaching Commerce Bridge:", err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }

  if (response.status === 404) {
    throw new HttpsError("not-found", "This product is no longer available.");
  }
  if (!response.ok) {
    console.error("[getMarketplaceProductDetail] Commerce Bridge returned status:", response.status);
    throw new HttpsError("internal", "Product details are temporarily unavailable.");
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error("[getMarketplaceProductDetail] could not parse Commerce Bridge response:", err);
    throw new HttpsError("internal", "Product details are temporarily unavailable.");
  }

  return data;
});
