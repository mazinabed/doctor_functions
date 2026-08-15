'use strict';

/**
 * Marketplace Platform, Phase 2 — Multi-Seller Aggregated Discovery.
 * Pure-function tests, no Firestore/emulator needed — exercises the REAL
 * computeGroupedProducts/rankGroupedProducts functions
 * (functions/commerce/lib/marketplaceGrouping.js) directly.
 *
 * Run with: cd tests && npx jest marketplace_grouping
 */

const { computeGroupedProducts, rankGroupedProducts } = require('../functions/commerce/lib/marketplaceGrouping');

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
});
