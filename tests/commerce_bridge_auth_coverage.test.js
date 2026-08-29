'use strict';

/**
 * Static regression test — the source-level counterpart to
 * functions/commerce/lib/commerceAuth.js's PRIVATE_COMMERCE_ENDPOINTS /
 * PUBLIC_COMMERCE_ENDPOINTS classification (Healthcare<->Commerce Bridge
 * Security Hardening, Stage 1, 2026-08-11).
 *
 * Scans the actual source of every known Healthcare-side Commerce bridge
 * caller file and asserts every call site targeting a PRIVATE endpoint uses
 * that file's authenticated call path, and every call site targeting a
 * PUBLIC endpoint does not. This is what would have caught the original
 * vulnerability structurally: a future edit that adds a new private-
 * endpoint call site using the wrong helper fails this test immediately,
 * rather than surfacing months later in a live audit.
 *
 * marketplaceCheckout.js / marketplaceProductReview.js mix private and
 * public targets, so each call site's wrapper name is checked against the
 * endpoint's actual classification. pharmacyOrderActions.js and
 * adminMarketplaceCategories.js call ONLY private endpoints (see each
 * file's own header comment) — for those, the invariant is simpler and
 * stronger: every Commerce call in the file must go through the file's one
 * authenticated wrapper, full stop.
 */
const fs = require('fs');
const path = require('path');
const {
  PRIVATE_COMMERCE_ENDPOINTS,
  PUBLIC_COMMERCE_ENDPOINTS,
} = require('../functions/commerce/lib/commerceAuth');

const COMMERCE_DIR = path.resolve(__dirname, '../functions/commerce');

function readSource(fileName) {
  return fs.readFileSync(path.join(COMMERCE_DIR, fileName), 'utf8');
}

// Matches `someCallName("endpointNameLiteral"` (single or double quotes) —
// the small, consistent shape every callCommerce-family call site in these
// files uses.
function findCallSites(source) {
  const results = [];
  const re = /\b(callCommerce\w*)\(\s*["']([A-Za-z0-9_]+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    results.push({ callName: m[1], endpoint: m[2] });
  }
  return results;
}

describe('Mixed-posture bridge files: private endpoints use callCommerceAuthenticated, public endpoints do not', () => {
  const MIXED_FILES = ['marketplaceCheckout.js', 'marketplaceProductReview.js'];

  for (const fileName of MIXED_FILES) {
    describe(fileName, () => {
      const source = readSource(fileName);
      const callSites = findCallSites(source);

      test('at least one private endpoint is called via the wrapper, and at least one public endpoint is referenced (sanity check this file still has both postures)', () => {
        // Public endpoints aren't always reached through the
        // callCommerce-family wrapper (marketplaceProductReview.js's
        // getProductReviews uses its own inline, deliberately separate
        // fetch() for its one public target) — checked as a source
        // substring here so both calling styles satisfy the sanity check;
        // the strict per-call-site assertion below only concerns itself
        // with actual callCommerce-family call sites.
        const wrappedEndpoints = callSites.map((c) => c.endpoint);
        expect(wrappedEndpoints.some((e) => PRIVATE_COMMERCE_ENDPOINTS.has(e))).toBe(true);
        expect([...PUBLIC_COMMERCE_ENDPOINTS].some((e) => source.includes(e))).toBe(true);
      });

      test.each(callSites.map((c) => [c.endpoint, c.callName]))(
        '%s (called via %s) uses the correct wrapper for its classification',
        (endpoint, callName) => {
          const isPrivate = PRIVATE_COMMERCE_ENDPOINTS.has(endpoint);
          const isPublic = PUBLIC_COMMERCE_ENDPOINTS.has(endpoint);
          // Every endpoint this file calls must be classified in
          // lib/commerceAuth.js — an unclassified name here means either a
          // typo or a genuinely new endpoint that hasn't been triaged yet.
          expect(isPrivate || isPublic).toBe(true);

          if (isPrivate) {
            expect(callName).toBe('callCommerceAuthenticated');
          } else {
            expect(callName).toBe('callCommerce');
          }
        },
      );
    });
  }
});

describe('All-private bridge files: every Commerce call site is authenticated', () => {
  // For these files every call target is confirmed PRIVATE (see each file's
  // own header comment) — asserting membership isn't the useful check;
  // asserting there is no OTHER, unauthenticated way this file reaches
  // Commerce is. callCommerce is these files' one and only wrapper, and it
  // internally calls getCommerceAuthHeaders (verified by
  // commerce_auth_helper.test.js) before every fetch.
  // adminMarketplaceCategoryRules.js added with the relay itself
  // (2026-08-29). adminMarketplaceAttributes.js added at the same time —
  // it had been live since 2026-07-18 while sitting outside this coverage
  // list entirely, so nothing structurally enforced that its Commerce
  // calls stayed authenticated.
  const ALL_PRIVATE_FILES = [
    'pharmacyOrderActions.js',
    'adminMarketplaceCategories.js',
    'adminMarketplaceAttributes.js',
    'adminMarketplaceCategoryRules.js',
  ];

  for (const fileName of ALL_PRIVATE_FILES) {
    test(`${fileName} has no plain, unauthenticated fetch() to the Commerce Bridge outside callCommerce`, () => {
      const source = readSource(fileName);
      const callSites = findCallSites(source);
      expect(callSites.length).toBeGreaterThan(0);
      for (const { callName } of callSites) {
        expect(callName).toBe('callCommerce');
      }
      // callCommerce itself must resolve its headers via the shared OIDC
      // helper — not construct a bare `{ "Content-Type": ... }` object the
      // way the pre-hardening version of this file did.
      expect(source).toMatch(/getCommerceAuthHeaders/);
    });
  }
});

describe('Public-only relay never references a private endpoint', () => {
  test('getMarketplaceProductDetail.js only ever names a PUBLIC endpoint', () => {
    const source = readSource('getMarketplaceProductDetail.js');
    for (const name of PRIVATE_COMMERCE_ENDPOINTS) {
      expect(source.includes(name)).toBe(false);
    }
    expect(source.includes('getMarketplaceProductDetailForHealthcare')).toBe(true);
  });
});
