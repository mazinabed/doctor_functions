'use strict';

/**
 * Unit tests for the shared Healthcare -> Commerce OIDC auth helper
 * (functions/commerce/lib/commerceAuth.js) — the Stage 1 mechanism every
 * private bridge caller (marketplaceCheckout.js, marketplaceProductReview.js,
 * pharmacyOrderActions.js, adminMarketplaceCategories.js) now shares
 * instead of each re-deriving its own GoogleAuth().getIdTokenClient() copy.
 * Pure unit tests, no emulator: google-auth-library is mocked so no real
 * network/token call ever happens and no real credentials are needed.
 */

const mockGetRequestHeaders = jest.fn();
const mockGetIdTokenClient = jest.fn();

// google-auth-library lives under functions/node_modules, not
// tests/node_modules — jest.mock() needs the module resolved to that exact
// path (rather than the bare specifier, which Jest would otherwise try to
// resolve relative to this test file's own node_modules) so the mock
// applies to the SAME resolved module commerceAuth.js's own
// require("google-auth-library") reaches.
jest.mock(require.resolve('../functions/node_modules/google-auth-library'), () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: mockGetIdTokenClient,
  })),
}));

describe('getCommerceAuthHeaders', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetIdTokenClient.mockReset();
    mockGetRequestHeaders.mockReset();
    mockGetIdTokenClient.mockResolvedValue({ getRequestHeaders: mockGetRequestHeaders });
    mockGetRequestHeaders.mockResolvedValue({ Authorization: 'Bearer fake-oidc-token' });
  });

  test('mints an ID token client scoped to the exact target URL (audience) and attaches it as a Bearer header', async () => {
    const { getCommerceAuthHeaders } = require('../functions/commerce/lib/commerceAuth');
    const url = 'https://us-central1-trustydr-commerce.cloudfunctions.net/placeMarketplaceOrderForHealthcare';

    const headers = await getCommerceAuthHeaders(url);

    expect(mockGetIdTokenClient).toHaveBeenCalledWith(url);
    expect(mockGetRequestHeaders).toHaveBeenCalledWith(url);
    expect(headers.Authorization).toBe('Bearer fake-oidc-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('reuses the same IdTokenClient for repeated calls to the same URL (warm-instance caching)', async () => {
    const { getCommerceAuthHeaders } = require('../functions/commerce/lib/commerceAuth');
    const url = 'https://us-central1-trustydr-commerce.cloudfunctions.net/cancelMarketplaceOrderForHealthcare';

    await getCommerceAuthHeaders(url);
    await getCommerceAuthHeaders(url);

    expect(mockGetIdTokenClient).toHaveBeenCalledTimes(1);
    expect(mockGetRequestHeaders).toHaveBeenCalledTimes(2);
  });

  test('mints a SEPARATE client per distinct target URL (each endpoint is its own OIDC audience)', async () => {
    const { getCommerceAuthHeaders } = require('../functions/commerce/lib/commerceAuth');

    await getCommerceAuthHeaders('https://us-central1-trustydr-commerce.cloudfunctions.net/placeMarketplaceOrderForHealthcare');
    await getCommerceAuthHeaders('https://us-central1-trustydr-commerce.cloudfunctions.net/cancelMarketplaceOrderForHealthcare');

    expect(mockGetIdTokenClient).toHaveBeenCalledTimes(2);
  });

  test('propagates a token-acquisition failure rather than swallowing it (caller must log + surface, never call Commerce unauthenticated)', async () => {
    mockGetIdTokenClient.mockRejectedValueOnce(new Error('no ambient credentials'));
    const { getCommerceAuthHeaders } = require('../functions/commerce/lib/commerceAuth');

    await expect(
      getCommerceAuthHeaders('https://us-central1-trustydr-commerce.cloudfunctions.net/placeMarketplaceOrderForHealthcare'),
    ).rejects.toThrow('no ambient credentials');
  });
});

describe('PRIVATE_COMMERCE_ENDPOINTS / PUBLIC_COMMERCE_ENDPOINTS classification', () => {
  test('the two sets are disjoint', () => {
    const { PRIVATE_COMMERCE_ENDPOINTS, PUBLIC_COMMERCE_ENDPOINTS } = require('../functions/commerce/lib/commerceAuth');
    for (const name of PRIVATE_COMMERCE_ENDPOINTS) {
      expect(PUBLIC_COMMERCE_ENDPOINTS.has(name)).toBe(false);
    }
  });

  // Known, pre-existing gap deliberately NOT closed here: the 14 category
  // and attribute CRUD endpoints that adminMarketplaceCategories.js and
  // adminMarketplaceAttributes.js call are still absent from both sets
  // (they predate this registry). They are not a live exposure — both
  // relays route every call through callCommerce, which is asserted to use
  // the shared OIDC helper by commerce_bridge_auth_coverage.test.js's
  // ALL_PRIVATE_FILES check. Registering them is tracked separately so
  // this list keeps meaning "audited and confirmed", not "assumed".
  test('contains exactly the 15 confirmed private bridge endpoints (2026-08-11 live IAM audit; +3 category-rule endpoints 2026-08-29)', () => {
    const { PRIVATE_COMMERCE_ENDPOINTS } = require('../functions/commerce/lib/commerceAuth');
    const expected = [
      'placeMarketplaceOrderForHealthcare',
      'quoteMarketplaceCartForHealthcare',
      'cancelMarketplaceOrderForHealthcare',
      'getMarketplaceOrderStatusForHealthcare',
      'startOrderPreparationForHealthcare',
      'completeOrderFulfillmentForHealthcare',
      'processDeliveryFailureForHealthcare',
      'submitProductReviewForHealthcare',
      'withdrawProductReviewForHealthcare',
      'getMyProductReviewForHealthcare',
      'syncMarketplaceCategoriesToOdoo',
      'syncAttributeDefinitionsToOdoo',
      'listCategoryAttributeRulesForHealthcare',
      'setCategoryAttributeRuleForHealthcare',
      'deleteCategoryAttributeRuleForHealthcare',
    ].sort();
    expect([...PRIVATE_COMMERCE_ENDPOINTS].sort()).toEqual(expected);
  });

  test('contains exactly the 7 confirmed public-by-design bridge endpoints', () => {
    const { PUBLIC_COMMERCE_ENDPOINTS } = require('../functions/commerce/lib/commerceAuth');
    const expected = [
      'getMarketplaceProductDetailForHealthcare',
      'getMarketplaceDeliveryMethodsForHealthcare',
      'getProductReviewsForHealthcare',
      'getMarketplaceCatalogForHealthcare',
      'getActiveMarketplaceStoresForHealthcare',
      'getEligibleStandaloneStoresForHealthcare',
      // Marketplace Platform Phase 2 (Multi-Seller Aggregated Discovery,
      // 2026-08-14) — see commerceAuth.js's own comment on this entry.
      'getApprovedCanonicalLinksForHealthcare',
    ].sort();
    expect([...PUBLIC_COMMERCE_ENDPOINTS].sort()).toEqual(expected);
  });
});
