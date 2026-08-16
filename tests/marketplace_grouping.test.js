'use strict';

/**
 * Marketplace Platform, Phase 2 — Multi-Seller Aggregated Discovery.
 * Pure-function tests, no Firestore/emulator needed — exercises the REAL
 * computeGroupedProducts/rankGroupedProducts functions
 * (functions/commerce/lib/marketplaceGrouping.js) directly.
 *
 * Run with: cd tests && npx jest marketplace_grouping
 */

const {
  computeGroupedProducts,
  rankGroupedProducts,
  applySponsoredPlacements,
} = require('../functions/commerce/lib/marketplaceGrouping');

const CANONICAL_PANADOL = {
  canonicalId: 'canonical_panadol',
  name_en: 'Panadol Extra 24 Tablets',
  name_ar: 'بانادول اكسترا',
  brandName: 'GSK',
  categoryKey: 'medicines_analgesics',
  representativeImageUrl: null,
};

function product(overrides) {
  return {
    orgId: 'org_a',
    engineId: 'engine_1',
    name_en: 'Panadol Extra 24 Tablets',
    name_ar: 'بانادول اكسترا',
    displayPrice: 5000,
    currencyName: 'IQD',
    imageUrl: null,
    isFeatured: false,
    storeName_en: 'Al Noor Pharmacy',
    storeName_ar: null,
    storeName_ku: null,
    availabilityBadge: 'in_stock',
    ...overrides,
  };
}

describe('computeGroupedProducts', () => {
  it('groups two sellers of the same canonical product, sorted by price with the cheapest first', () => {
    const products = [
      product({ orgId: 'org_a', engineId: 'engine_a', displayPrice: 5000, storeName_en: 'Al Noor Pharmacy' }),
      product({ orgId: 'org_b', engineId: 'engine_b', displayPrice: 4750, storeName_en: 'Baghdad Central Pharmacy' }),
      product({ orgId: 'org_c', engineId: 'engine_c', displayPrice: 5250, storeName_en: 'Kut Pharmacy' }),
    ];
    const links = [
      { orgId: 'org_a', engineId: 'engine_a', canonicalId: 'canonical_panadol' },
      { orgId: 'org_b', engineId: 'engine_b', canonicalId: 'canonical_panadol' },
      { orgId: 'org_c', engineId: 'engine_c', canonicalId: 'canonical_panadol' },
    ];
    const groups = computeGroupedProducts(products, links, [CANONICAL_PANADOL]);

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe('canonical_panadol');
    expect(groups[0].sellerCount).toBe(3);
    expect(groups[0].lowestPrice).toBe(4750);
    expect(groups[0].offers.map((o) => o.storeName_en)).toEqual([
      'Baghdad Central Pharmacy', // cheapest first
      'Al Noor Pharmacy',
      'Kut Pharmacy',
    ]);
  });

  it('aggregates a Healthcare-linked pharmacy offer together with a standalone Commerce offer for the same canonical product (live retest #3 — the two seller identity schemes are not treated differently anywhere in this function)', () => {
    // Mirrors the real live topology found while investigating a reported
    // "second seller missing" bug: a Healthcare pharmacy org (orgId always
    // `hc_pharmacy_{providerId}`, per getActiveMarketplaceStores.js) and a
    // standalone Commerce org (orgId is Commerce's own raw doc id, per
    // getEligibleStandaloneStoresForHealthcare) both selling the same
    // canonical Digital Blood Pressure Monitor. Both origins arrive here
    // already merged into one flat `products` array by the caller
    // (Healthcare's mergedProducts) — this function has no origin-specific
    // branching at all, so there is nothing for it to get wrong between the
    // two schemes. The real bug (found via live Firestore data, not this
    // test) was an approved canonical_product_links doc pointing at a THIRD
    // orgId with no organizations document under either identity scheme —
    // a Phase 1 admin mis-link, not a Phase 2 join defect.
    const products = [
      product({
        orgId: 'hc_pharmacy_ORp58HddudZRepouJEbY8irGyvM2',
        engineId: '65',
        name_en: 'Digital Blood Pressure Monitor (Upper-arm) — Unit',
        displayPrice: 35000,
        storeName_en: 'Demp Pharmacy',
      }),
      product({
        orgId: 'OIH67W4vZjLPV7SVa3bd',
        engineId: '74',
        name_en: 'Digital Blood Pressure Monitor (Upper-arm) — Unit',
        displayPrice: 30000,
        storeName_en: 'Demo Store',
      }),
    ];
    const links = [
      {
        orgId: 'hc_pharmacy_ORp58HddudZRepouJEbY8irGyvM2',
        engineId: '65',
        canonicalId: 'canonical_bp_monitor',
      },
      { orgId: 'OIH67W4vZjLPV7SVa3bd', engineId: '74', canonicalId: 'canonical_bp_monitor' },
    ];
    const canonicalBpMonitor = {
      canonicalId: 'canonical_bp_monitor',
      name_en: 'Digital Blood Pressure Monitor (Upper-arm) — Unit',
      name_ar: 'جهاز قياس ضغط الدم الرقمي (للعضد) — وحدة واحدة',
      brandName: null,
      categoryKey: 'medical_devices_monitoring_blood_pressure_monitors',
      representativeImageUrl: null,
    };
    const groups = computeGroupedProducts(products, links, [canonicalBpMonitor]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sellerCount).toBe(2);
    expect(groups[0].lowestPrice).toBe(30000);
    expect(groups[0].offers.map((o) => o.storeName_en)).toEqual([
      'Demo Store', // cheapest first, regardless of seller identity scheme
      'Demp Pharmacy',
    ]);
    expect(groups[0].offers.map((o) => o.orgId)).toEqual([
      'OIH67W4vZjLPV7SVa3bd',
      'hc_pharmacy_ORp58HddudZRepouJEbY8irGyvM2',
    ]);
  });

  it('leaves an unlinked product out of every group entirely (it stays in the ordinary product list, handled by the caller)', () => {
    const products = [
      product({ orgId: 'org_a', engineId: 'engine_a' }),
      product({ orgId: 'org_z', engineId: 'engine_z', name_en: 'Ibuprofen 200mg' }),
    ];
    const links = [{ orgId: 'org_a', engineId: 'engine_a', canonicalId: 'canonical_panadol' }];
    const groups = computeGroupedProducts(products, links, [CANONICAL_PANADOL]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sellerCount).toBe(1);
    // org_z/engine_z (Ibuprofen) never appears in any group.
    const allOfferKeys = groups.flatMap((g) => g.offers.map((o) => `${o.orgId}_${o.engineId}`));
    expect(allOfferKeys).not.toContain('org_z_engine_z');
  });

  it('does not create a group for a link whose canonical product is missing (e.g. archived)', () => {
    const products = [product({ orgId: 'org_a', engineId: 'engine_a' })];
    const links = [{ orgId: 'org_a', engineId: 'engine_a', canonicalId: 'canonical_missing' }];
    const groups = computeGroupedProducts(products, links, []); // canonicalProducts empty
    expect(groups).toEqual([]);
  });

  it('marks a group featured if ANY offer in it is featured', () => {
    const products = [
      product({ orgId: 'org_a', engineId: 'engine_a', isFeatured: false }),
      product({ orgId: 'org_b', engineId: 'engine_b', isFeatured: true }),
    ];
    const links = [
      { orgId: 'org_a', engineId: 'engine_a', canonicalId: 'canonical_panadol' },
      { orgId: 'org_b', engineId: 'engine_b', canonicalId: 'canonical_panadol' },
    ];
    const groups = computeGroupedProducts(products, links, [CANONICAL_PANADOL]);
    expect(groups[0].isFeatured).toBe(true);
  });

  it('returns an empty array when there are no approved links at all', () => {
    const products = [product({})];
    expect(computeGroupedProducts(products, [], [])).toEqual([]);
  });
});

describe('rankGroupedProducts', () => {
  function group(overrides) {
    return { canonicalId: 'x', isFeatured: false, lowestPrice: 5000, offers: [], ...overrides };
  }

  it('ranks featured groups before non-featured groups regardless of price', () => {
    const cheap = group({ canonicalId: 'cheap', isFeatured: false, lowestPrice: 1000 });
    const featured = group({ canonicalId: 'featured', isFeatured: true, lowestPrice: 9000 });
    const ranked = rankGroupedProducts([cheap, featured]);
    expect(ranked.map((g) => g.canonicalId)).toEqual(['featured', 'cheap']);
  });

  it('within the same featured tier, ranks lowest price first', () => {
    const expensive = group({ canonicalId: 'expensive', isFeatured: false, lowestPrice: 9000 });
    const cheap = group({ canonicalId: 'cheap', isFeatured: false, lowestPrice: 1000 });
    const ranked = rankGroupedProducts([expensive, cheap]);
    expect(ranked.map((g) => g.canonicalId)).toEqual(['cheap', 'expensive']);
  });

  it('does not mutate the input array', () => {
    const input = [group({ canonicalId: 'a', lowestPrice: 9000 }), group({ canonicalId: 'b', lowestPrice: 1000 })];
    const inputCopy = [...input];
    rankGroupedProducts(input);
    expect(input).toEqual(inputCopy);
  });

  // Marketplace Platform Phase 5 (Sponsored/Promoted Monetization,
  // 2026-08-15).
  it('ranks a sponsored group ahead of a featured (but non-sponsored) group, regardless of price', () => {
    const featured = group({ canonicalId: 'featured', isFeatured: true, lowestPrice: 1000 });
    const sponsored = group({ canonicalId: 'sponsored', isFeatured: false, isSponsored: true, lowestPrice: 9000 });
    const ranked = rankGroupedProducts([featured, sponsored]);
    expect(ranked.map((g) => g.canonicalId)).toEqual(['sponsored', 'featured']);
  });

  it('is a complete no-op when no group carries isSponsored (exact pre-Phase-5 ordering preserved)', () => {
    const cheap = group({ canonicalId: 'cheap', isFeatured: false, lowestPrice: 1000 });
    const featured = group({ canonicalId: 'featured', isFeatured: true, lowestPrice: 9000 });
    const expensive = group({ canonicalId: 'expensive', isFeatured: false, lowestPrice: 5000 });
    const ranked = rankGroupedProducts([cheap, featured, expensive]);
    expect(ranked.map((g) => g.canonicalId)).toEqual(['featured', 'cheap', 'expensive']);
  });
});

describe('applySponsoredPlacements', () => {
  function offer(overrides) {
    return { orgId: 'org_a', engineId: 'engine_a', storeName_en: 'Al Noor Pharmacy', displayPrice: 5000, ...overrides };
  }
  function group(overrides) {
    return { canonicalId: 'canonical_panadol', isFeatured: false, lowestPrice: 5000, offers: [offer({})], ...overrides };
  }

  it('is a no-op when sponsoredPlacements is empty/undefined (regression: exact same groups returned)', () => {
    const groups = [group({})];
    expect(applySponsoredPlacements(groups, [])).toBe(groups);
    expect(applySponsoredPlacements(groups, undefined)).toBe(groups);
  });

  it('marks the matching offer AND its parent group isSponsored for a sponsored_offer placement', () => {
    const groups = [
      group({
        canonicalId: 'canonical_panadol',
        offers: [
          offer({ orgId: 'org_a', engineId: 'engine_a' }),
          offer({ orgId: 'org_b', engineId: 'engine_b', storeName_en: 'Baghdad Central Pharmacy' }),
        ],
      }),
    ];
    const placements = [
      { placementId: 'p1', orgId: 'org_b', engineId: 'engine_b', placementType: 'sponsored_offer' },
    ];
    const result = applySponsoredPlacements(groups, placements);

    expect(result[0].isSponsored).toBe(true);
    const [orgAOffer, orgBOffer] = result[0].offers;
    expect(orgAOffer.isSponsored).toBeUndefined();
    expect(orgBOffer.isSponsored).toBe(true);
    expect(orgBOffer.sponsoredPlacementId).toBe('p1');
  });

  it('marks every offer belonging to a featured_store org, across different canonical groups', () => {
    const groups = [
      group({ canonicalId: 'canonical_panadol', offers: [offer({ orgId: 'org_a', engineId: 'engine_a' })] }),
      group({ canonicalId: 'canonical_ibuprofen', offers: [offer({ orgId: 'org_a', engineId: 'engine_b' })] }),
      group({ canonicalId: 'canonical_other', offers: [offer({ orgId: 'org_z', engineId: 'engine_z' })] }),
    ];
    const placements = [{ placementId: 'p2', orgId: 'org_a', engineId: null, placementType: 'featured_store' }];
    const result = applySponsoredPlacements(groups, placements);

    expect(result[0].isSponsored).toBe(true);
    expect(result[1].isSponsored).toBe(true);
    expect(result[2].isSponsored).toBeUndefined();
  });

  it('never touches price/name/availability/seller-identity fields — only adds isSponsored/sponsoredPlacementId', () => {
    const original = offer({ orgId: 'org_a', engineId: 'engine_a', displayPrice: 4750, availabilityBadge: 'low_stock' });
    const groups = [group({ offers: [original] })];
    const placements = [{ placementId: 'p3', orgId: 'org_a', engineId: 'engine_a', placementType: 'sponsored_offer' }];
    const result = applySponsoredPlacements(groups, placements);

    expect(result[0].offers[0].displayPrice).toBe(4750);
    expect(result[0].offers[0].availabilityBadge).toBe('low_stock');
    expect(result[0].offers[0].orgId).toBe('org_a');
  });

  it('does not mutate the input groups array or its offer objects', () => {
    const original = offer({ orgId: 'org_a', engineId: 'engine_a' });
    const groups = [group({ offers: [original] })];
    const placements = [{ placementId: 'p4', orgId: 'org_a', engineId: 'engine_a', placementType: 'sponsored_offer' }];
    applySponsoredPlacements(groups, placements);
    expect(original.isSponsored).toBeUndefined();
    expect(groups[0].isSponsored).toBeUndefined();
  });
});
