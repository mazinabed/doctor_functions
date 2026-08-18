'use strict';

/**
 * Phone-verification bridge correction (2026-08-18) — pure unit tests for
 * resolveVerifiedPhoneNumber (functions/commerce/resolveAccessContext.js),
 * the one-line decision that extracts the caller's own verified phone
 * number from an already-verified admin.auth().verifyIdToken() result. No
 * emulator, no real ID token needed — same "pure unit test" convention as
 * commerce_auth_helper.test.js.
 */

const { resolveVerifiedPhoneNumber } = require('../functions/commerce/resolveAccessContext');

describe('resolveVerifiedPhoneNumber', () => {
  test('extracts phone_number from a decoded phone-authenticated token', () => {
    expect(resolveVerifiedPhoneNumber({ uid: 'u1', phone_number: '+9647701234567' })).toBe(
      '+9647701234567',
    );
  });

  test('returns null when the decoded token has no phone_number at all (e.g. never phone-verified)', () => {
    expect(resolveVerifiedPhoneNumber({ uid: 'u1' })).toBeNull();
  });

  test('returns null for an empty-string phone_number rather than forwarding a falsy placeholder', () => {
    expect(resolveVerifiedPhoneNumber({ uid: 'u1', phone_number: '' })).toBeNull();
  });

  test('returns null for a null/undefined decoded token rather than throwing', () => {
    expect(resolveVerifiedPhoneNumber(null)).toBeNull();
    expect(resolveVerifiedPhoneNumber(undefined)).toBeNull();
  });
});
