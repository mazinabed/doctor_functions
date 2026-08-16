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
 * (sponsored first, then featured, then lowest price ascending) —
 * intentionally NOT an ad engine and NOT external search infrastructure
 * (premature at current scale, per the program's own audit).
 *
 * Marketplace Platform Phase 5 (Sponsored/Promoted Monetization,
 * 2026-08-15): sponsored placement is now the top-priority sort key, ahead
 * of the existing isFeatured/lowestPrice ordering below it — but it is
 * ADDED as a new leading tiebreaker, never a replacement for the existing
 * organic order. Groups with no sponsored placement (isSponsored falsy or
 * absent — the case for every group whenever applySponsoredPlacements was
 * skipped or found nothing) sort exactly as before this phase.
 */
function rankGroupedProducts(groupedProducts) {
  return [...groupedProducts].sort((a, b) => {
    if (Boolean(a.isSponsored) !== Boolean(b.isSponsored)) return a.isSponsored ? -1 : 1;
    if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
    return a.lowestPrice - b.lowestPrice;
  });
}

/**
 * Marketplace Platform Phase 5 (Sponsored/Promoted Monetization,
 * 2026-08-15) — the monetization insertion point this file's own header
 * comment anticipated: called between computeGroupedProducts and
 * rankGroupedProducts, never inside either. Pure and I/O-free, same
 * convention as the rest of this file.
 *
 * Marks each offer AND its parent group with `isSponsored` wherever an
 * active sponsored placement matches. Two placement types:
 *   - "sponsored_offer": matches one specific offer by orgId+engineId.
 *   - "featured_store": matches ANY offer within a group belonging to that
 *     orgId (the org sponsors its own presence, not one specific listing).
 * A group's own `isSponsored` is true iff at least one of its offers is.
 * `sponsoredPlacementId` is attached per matched offer (not per group) so
 * the caller can record an impression/click event against the exact
 * placement responsible, even when a group has more than one seller.
 *
 * Deliberately scoped to the GROUPED discovery list only (not the flat
 * `products` list) — this is the Phase 2 ranking seam the roadmap calls
 * for reusing; sponsoring a listing that has no approved canonical link
 * yet is out of scope for this phase (see the Phase 5 architecture doc's
 * own "NOT IMPLEMENTED YET" section).
 *
 * @param {Array<object>} groupedProducts - output of computeGroupedProducts
 * @param {Array<{placementId:string, orgId:string, engineId:string|null, placementType:string}>} sponsoredPlacements
 * @returns {Array<object>} the SAME groups, with isSponsored/sponsoredPlacementId
 *   fields added where applicable — never mutates product/catalog truth
 *   fields (price, name, images, availability, seller identity all
 *   pass through completely unchanged).
 */
function applySponsoredPlacements(groupedProducts, sponsoredPlacements) {
  if (!Array.isArray(sponsoredPlacements) || sponsoredPlacements.length === 0) {
    return groupedProducts;
  }

  const offerPlacementByKey = new Map(); // `${orgId}_${engineId}` -> placementId
  const storePlacementByOrgId = new Map(); // orgId -> placementId
  for (const placement of sponsoredPlacements) {
    if (placement.placementType === "sponsored_offer" && placement.engineId) {
      offerPlacementByKey.set(`${placement.orgId}_${placement.engineId}`, placement.placementId);
    } else if (placement.placementType === "featured_store") {
      storePlacementByOrgId.set(placement.orgId, placement.placementId);
    }
  }
  if (offerPlacementByKey.size === 0 && storePlacementByOrgId.size === 0) {
    return groupedProducts;
  }

  return groupedProducts.map((group) => {
    let groupIsSponsored = false;
    const offers = group.offers.map((offer) => {
      const placementId =
        offerPlacementByKey.get(`${offer.orgId}_${offer.engineId}`) ?? storePlacementByOrgId.get(offer.orgId);
      if (!placementId) return offer;
      groupIsSponsored = true;
      return { ...offer, isSponsored: true, sponsoredPlacementId: placementId };
    });
    if (!groupIsSponsored) return group;
    return { ...group, isSponsored: true, offers };
  });
}

// Marketplace Platform Phase 5 — Patient-visibility gap correction
// (2026-08-16). A live smoke test found BOTH sponsored placement types
// approving successfully end to end (submit -> admin approve -> active,
// confirmed live) but never becoming visible/ranked anywhere a patient
// actually looks: applySponsoredPlacements above only ever touched
// groupedProducts — a canonical-linked-only, Compare-Sellers-specific
// data structure — never the flat, ordinary `products` list every product
// card outside Compare Sellers renders from, and never `stores` (Browse
// Stores) at all. A sponsored_offer for a listing with no approved
// canonical link (confirmed live: Demo Store's actual sponsored product)
// was therefore structurally invisible everywhere, and featured_store had
// no connection whatsoever to store discovery/ranking.
//
// These two functions close exactly that gap, at the SAME seam
// (getActiveMarketplaceStores.js, applied to `products`/`stores`
// alongside the existing `groups` marking) — never touching
// computeGroupedProducts/rankGroupedProducts/applySponsoredPlacements
// above, which stay exactly as they were for Compare Sellers.

/**
 * Marks each ordinary (flat, not-necessarily-canonical-linked) product
 * entry with `isSponsored`/`sponsoredPlacementId` for a matching
 * "sponsored_offer" placement — orgId+engineId match only, the same exact
 * matching discipline as applySponsoredPlacements' own offer-level
 * marking, so a different seller's identical/competing product (even one
 * in the very same canonical group) is never accidentally marked.
 * "featured_store" placements are deliberately NOT applied here — they
 * promote the store itself (see applySponsoredPlacementsToStores below),
 * not every product that store happens to sell.
 *
 * @param {Array<object>} products - mergedProducts, each carrying at least orgId/engineId
 * @param {Array<{placementId:string, orgId:string, engineId:string|null, placementType:string}>} sponsoredPlacements
 * @returns {Array<object>} the SAME products, additively marked — every
 *   other field (price, name, images, availability, seller identity)
 *   passes through completely unchanged.
 */
function applySponsoredPlacementsToProducts(products, sponsoredPlacements) {
  if (!Array.isArray(sponsoredPlacements) || sponsoredPlacements.length === 0) {
    return products;
  }
  const offerPlacementByKey = new Map();
  for (const placement of sponsoredPlacements) {
    if (placement.placementType === "sponsored_offer" && placement.engineId) {
      offerPlacementByKey.set(`${placement.orgId}_${placement.engineId}`, placement.placementId);
    }
  }
  if (offerPlacementByKey.size === 0) return products;

  return products.map((p) => {
    const placementId = offerPlacementByKey.get(`${p.orgId}_${p.engineId}`);
    if (!placementId) return p;
    return { ...p, isSponsored: true, sponsoredPlacementId: placementId };
  });
}

/**
 * Marks each store with `isSponsored`/`sponsoredPlacementId` for a
 * matching "featured_store" placement (orgId match). "sponsored_offer"
 * placements are deliberately NOT applied here — sponsoring one product
 * must never make the whole store read as sponsored.
 *
 * @param {Array<object>} stores - mergedStores, each carrying at least orgId
 * @param {Array<{placementId:string, orgId:string, engineId:string|null, placementType:string}>} sponsoredPlacements
 * @returns {Array<object>} the SAME stores, additively marked — every
 *   other field (name, branding, location, product count) passes through
 *   completely unchanged.
 */
function applySponsoredPlacementsToStores(stores, sponsoredPlacements) {
  if (!Array.isArray(sponsoredPlacements) || sponsoredPlacements.length === 0) {
    return stores;
  }
  const storePlacementByOrgId = new Map();
  for (const placement of sponsoredPlacements) {
    if (placement.placementType === "featured_store") {
      storePlacementByOrgId.set(placement.orgId, placement.placementId);
    }
  }
  if (storePlacementByOrgId.size === 0) return stores;

  return stores.map((s) => {
    const placementId = storePlacementByOrgId.get(s.orgId);
    if (!placementId) return s;
    return { ...s, isSponsored: true, sponsoredPlacementId: placementId };
  });
}

/**
 * Stores -> final display order for Browse Stores. Sponsored stores first
 * (stable sort — every other store, sponsored or not, keeps its existing
 * relative order beneath that split), matching rankGroupedProducts' own
 * "additive leading tier, never a replacement" contract. A no-op when no
 * store carries isSponsored — the exact pre-existing merge order (however
 * getActiveMarketplaceStores.js assembled `mergedStores`) is preserved
 * byte-for-byte.
 */
function rankStores(stores) {
  return [...stores].sort((a, b) => {
    if (Boolean(a.isSponsored) !== Boolean(b.isSponsored)) return a.isSponsored ? -1 : 1;
    return 0;
  });
}

module.exports = {
  computeGroupedProducts,
  rankGroupedProducts,
  applySponsoredPlacements,
  applySponsoredPlacementsToProducts,
  applySponsoredPlacementsToStores,
  rankStores,
};
