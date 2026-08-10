'use strict';

/**
 * Product Ratings & Reviews, Phase 3 (2026-08-10) — focused test for the
 * pure/near-pure helpers exported from functions/commerce/
 * marketplaceProductReview.js (resolveOdooLang, throwForReviewFailure),
 * same convention as marketplace_checkout_guards.test.js: test the REAL
 * exported functions directly, no emulator-backed way to invoke the full
 * onCall handler in this repo (see that file's own header).
 *
 * Run with:
 *   cd tests && npx jest marketplace_product_review --runInBand --forceExit
 */

const {
  resolveOdooLang,
  throwForReviewFailure,
} = require('../functions/commerce/marketplaceProductReview');

// Duck-typed instead of `instanceof HttpsError` — firebase-functions v2's
// HttpsError is resolved via package.json's "exports" map (v2/https ->
// lib/v2/https/*), which only works through a normal bare-specifier
// require from within functions/ itself; a second require of it from this
// test file would risk resolving a DIFFERENT copy (or none at all — this
// repo's tests/node_modules has no firebase-functions dependency), making
// instanceof unreliable. `.code` is the actual contract every caller of
// throwForReviewFailure (marketplaceProductReview.js's onCall handlers,
// and ultimately the Flutter client) depends on — confirmed live via this
// suite's own first run that `.name` stays the plain "Error" default
// (firebase-functions' HttpsError does not override it), so this
// deliberately does not assert on `.name`.
function assertHttpsErrorLike(err, expectedCode) {
  expect(err).not.toBeNull();
  expect(err.code).toBe(expectedCode);
}

describe('resolveOdooLang', () => {
  test('en -> en_US', () => {
    expect(resolveOdooLang('en')).toBe('en_US');
  });

  test('ar -> ar_001', () => {
    expect(resolveOdooLang('ar')).toBe('ar_001');
  });

  test('ku falls back to ar_001 (no Kurdish res.lang on the connected Odoo instance)', () => {
    expect(resolveOdooLang('ku')).toBe('ar_001');
  });

  test('an unrecognized locale resolves to undefined, never guessed', () => {
    expect(resolveOdooLang('fr')).toBeUndefined();
    expect(resolveOdooLang(undefined)).toBeUndefined();
    expect(resolveOdooLang(null)).toBeUndefined();
  });
});

describe('throwForReviewFailure', () => {
  test('403 NOT_VERIFIED_PURCHASE maps to failed-precondition', () => {
    let caught = null;
    try {
      throwForReviewFailure('test', {
        status: 403,
        data: { error: 'NOT_VERIFIED_PURCHASE', message: 'Only patients who have purchased this product may review it.' },
      });
    } catch (err) {
      caught = err;
    }
    assertHttpsErrorLike(caught, 'failed-precondition');
    expect(caught.details).toEqual({ code: 'not_verified_purchase' });
  });

  test('400 INVALID_RATING_VALUE maps to invalid-argument', () => {
    let caught = null;
    try {
      throwForReviewFailure('test', {
        status: 400,
        data: { error: 'INVALID_RATING_VALUE', message: 'Rating must be an integer from 1 to 5.' },
      });
    } catch (err) {
      caught = err;
    }
    assertHttpsErrorLike(caught, 'invalid-argument');
    expect(caught.details).toEqual({ code: 'invalid_rating_value' });
  });

  test('a generic 400 (unrecognized error code) still maps to invalid-argument, not a raw 500', () => {
    let caught = null;
    try {
      throwForReviewFailure('test', {
        status: 400,
        data: { error: 'engineId is required.' },
      });
    } catch (err) {
      caught = err;
    }
    assertHttpsErrorLike(caught, 'invalid-argument');
  });

  test('an unhandled status (e.g. 500) maps to internal, never silently swallowed', () => {
    let caught = null;
    try {
      throwForReviewFailure('test', {
        status: 500,
        data: { error: 'Internal error.' },
      });
    } catch (err) {
      caught = err;
    }
    assertHttpsErrorLike(caught, 'internal');
  });

  test('throwForReviewFailure always throws — it never returns normally', () => {
    let caught = null;
    try {
      throwForReviewFailure('test', { status: 200, data: {} });
    } catch (err) {
      caught = err;
    }
    assertHttpsErrorLike(caught, 'internal');
  });
});
