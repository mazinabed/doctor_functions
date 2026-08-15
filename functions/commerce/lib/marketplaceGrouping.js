'use strict';

// Marketplace Platform, Phase 2 — Multi-Seller Aggregated Discovery
// (trustydr-commerce's docs/progress/MARKETPLACE_PLATFORM_ROADMAP_PROGRESS.md).
//
// Pure, I/O-free logic (no Firestore/network access) — mirrors the
// separation-of-decision-logic-from-I/O convention already established on
// the Commerce side (canonicalProductMatching.ts). Lives here (not
// trustydr-commerce) because the inputs it needs — the fully store-name-
// enriched product list — only exist in THIS file's caller
// (getActiveMarketplaceStores.js), which already resolves Healthcare-owned
// pharmacy facility names Commerce has no equivalent for.
//
// Deliberately two separate exported steps, not one combined function:
// grouping (which products belong to which canonical product) and ranking
// (what order the resulting groups display in) are kept apart so a future
// sponsored-placement layer can insert between them — re-order
// computeGroupedProducts' output — without ever touching the grouping
// logic itself. This is the "clean ranking seam" Phase 2 calls for.

/**
 * @param {Array<object>} products - the ALREADY fully-enriched product list
 *   (mergedProducts in getActiveMarketplaceStores.js) — each item must carry
 *   at least: orgId, engineId, displayPrice, currencyName, imageUrl,
 *   isFeatured, storeName_en, storeName_ar, storeName_ku, availabilityBadge.
 * @param {Array<{orgId:string, engineId:string, canonicalId:string}>} links
 * @param {Array<object>} canonicalProducts - canonical product identity
 *   fields (name_en, name_ar, brandName, categoryKey, representativeImageUrl).
 * @returns {Array<object>} groupedProducts, UNRANKED — pass to
 *   rankGroupedProducts before returning to a client.
 */
function computeGroupedProducts(products, links, canonicalProducts) {
  const linkByKey = new Map(links.map((l) => [`${l.orgId}_${l.engineId}`, l.canonicalId]));
  const canonicalById = new Map(canonicalProducts.map((c) => [c.canonicalId, c]));

  const groups = new Map(); // canonicalId -> { canonical, offers: [] }
  for (const p of products) {
    const canonicalId = linkByKey.get(`${p.orgId}_${p.engineId}`);
    if (!canonicalId) continue; // no approved link — stays in the ordinary `products` list only
    const canonical = canonicalById.get(canonicalId);
    if (!canonical) continue; // defensive: link exists but canonical doc missing (e.g. archived)
    if (!groups.has(canonicalId)) groups.set(canonicalId, { canonical, offers: [] });
    groups.get(canonicalId).offers.push(p);
  }

  const groupedProducts = [];
  for (const [canonicalId, { canonical, offers }] of groups.entries()) {
    if (offers.length === 0) continue;
    const sortedOffers = [...offers].sort((a, b) => a.displayPrice - b.displayPrice);
    const cheapest = sortedOffers[0];
    groupedProducts.push({
      canonicalId,
      name_en: canonical.name_en,
      name_ar: canonical.name_ar,
      brandName: canonical.brandName ?? null,
      categoryKey: canonical.categoryKey ?? null,
      representativeImageUrl: canonical.representativeImageUrl || cheapest.imageUrl || null,
      lowestPrice: cheapest.displayPrice,
      currencyName: cheapest.currencyName ?? null,
      sellerCount: offers.length,
      isFeatured: offers.some((o) => o.isFeatured),
      offers: sortedOffers.map((o) => ({
        orgId: o.orgId,
        engineId: o.engineId,
        storeName_en: o.storeName_en ?? null,
        storeName_ar: o.storeName_ar ?? null,
        storeName_ku: o.storeName_ku ?? null,
        displayPrice: o.displayPrice,
        currencyName: o.currencyName ?? null,
        availabilityBadge: o.availabilityBadge ?? null,
        imageUrl: o.imageUrl ?? null,
      })),
    });
  }
  return groupedProducts;
}

/**
 * Candidate groups -> final display order. Simple and deterministic today
 * (featured first, then lowest price ascending) — intentionally NOT an ad
 * engine and NOT external search infrastructure (premature at current
 * scale, per the program's own audit). The seam is the point: a future
 * sponsored layer inserts here, not inside computeGroupedProducts.
 */
function rankGroupedProducts(groupedProducts) {
  return [...groupedProducts].sort((a, b) => {
    if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
    return a.lowestPrice - b.lowestPrice;
  });
}

module.exports = { computeGroupedProducts, rankGroupedProducts };
