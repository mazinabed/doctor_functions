// TrustyDr Commerce Bridge — Marketplace Platform Phase 5 (Sponsored/
// Promoted Monetization, 2026-08-15).
//
// Patient-App-facing relay for the impression/click measurement
// foundation. Same posture as marketplaceProductReview.js's own
// getProductReviews: plain, unauthenticated fetch to Commerce's public
// recordSponsoredEventForHealthcare — Marketplace browsing (and therefore
// impressions/clicks) works identically for guests and signed-in patients
// (see marketplace_providers.dart's own "Loads identically for guests and
// logged-in patients" convention), and an event carries no patient
// identity at all, so there is nothing here for Firebase auth to gate.
//
// Fire-and-forget by design: never throws back a hard failure a Patient UI
// card-render or tap handler would need to handle — a missed beacon is an
// acceptable measurement-foundation tradeoff (see the Phase 5 architecture
// doc's own "Known limitations"), not a broken feature.

const { onCall } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const fetch = require("node-fetch");

const COMMERCE_SPONSORED_EVENT_BRIDGE_URL =
  "https://us-central1-trustydr-commerce.cloudfunctions.net/recordSponsoredEventForHealthcare";

exports.recordSponsoredEvent = onCall({ region: "us-central1" }, async (request) => {
  const { placementId, eventType } = request.data || {};
  if (typeof placementId !== "string" || !placementId || (eventType !== "impression" && eventType !== "click")) {
    // Deliberately still a soft failure, not an HttpsError — same
    // fire-and-forget posture as the rest of this file; a malformed
    // client-side call should never surface as a visible error to a
    // patient browsing the Marketplace.
    return { recorded: false };
  }

  try {
    const response = await fetch(COMMERCE_SPONSORED_EVENT_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placementId, eventType }),
    });
    if (!response.ok) {
      logger.error("[recordSponsoredEvent] Commerce Bridge returned status:", response.status);
      return { recorded: false };
    }
    const data = await response.json();
    return { recorded: data.recorded === true };
  } catch (err) {
    logger.error("[recordSponsoredEvent] network error reaching Commerce Bridge:", err);
    return { recorded: false };
  }
});
