'use strict';

// Pure-logic unit tests for lifecycle functions.
// Only tests modules with zero Firebase dependencies.
// Firebase-dependent modules (helpers.js, publicDoctorSanitizer.js) are covered
// by the emulator tests in lifecycle_rules.test.js.

const {
  isDoctorPubliclyEligible,
  isDoctorBookingPermitted,
  isPatientBookingPermitted,
} = require('../functions/lifecycle/lifecycleEligibility');

// ─── isDoctorPubliclyEligible ─────────────────────────────────────────────────

describe('isDoctorPubliclyEligible', () => {
  test('null data → false', () => {
    expect(isDoctorPubliclyEligible(null)).toBe(false);
  });

  test('no accountLifecycle (legacy doc) → true', () => {
    expect(isDoctorPubliclyEligible({ status: 'active' })).toBe(true);
  });

  test('accountLifecycle.status = active → true', () => {
    expect(isDoctorPubliclyEligible({ accountLifecycle: { status: 'active' } })).toBe(true);
  });

  test('accountLifecycle.status = deletionPending → false', () => {
    expect(isDoctorPubliclyEligible({ accountLifecycle: { status: 'deletionPending' } })).toBe(false);
  });

  test('accountLifecycle.status = deleted → false', () => {
    expect(isDoctorPubliclyEligible({ accountLifecycle: { status: 'deleted' } })).toBe(false);
  });

  test('accountLifecycle.status = archived → false', () => {
    expect(isDoctorPubliclyEligible({ accountLifecycle: { status: 'archived' } })).toBe(false);
  });

  test('active lifecycle, publicProfileHidden=true → false', () => {
    expect(isDoctorPubliclyEligible({
      accountLifecycle: { status: 'active', doctorState: { publicProfileHidden: true } },
    })).toBe(false);
  });

  test('active lifecycle, publicProfileHidden=false → true', () => {
    expect(isDoctorPubliclyEligible({
      accountLifecycle: { status: 'active', doctorState: { publicProfileHidden: false } },
    })).toBe(true);
  });

  test('active lifecycle, no doctorState → true', () => {
    expect(isDoctorPubliclyEligible({ accountLifecycle: { status: 'active' } })).toBe(true);
  });
});

// ─── isDoctorBookingPermitted ─────────────────────────────────────────────────

describe('isDoctorBookingPermitted', () => {
  test('null data → true (fail-open for legacy)', () => {
    expect(isDoctorBookingPermitted(null)).toBe(true);
  });

  test('no accountLifecycle → true', () => {
    expect(isDoctorBookingPermitted({ status: 'active' })).toBe(true);
  });

  test('active lifecycle → true', () => {
    expect(isDoctorBookingPermitted({ accountLifecycle: { status: 'active' } })).toBe(true);
  });

  test('deletionPending lifecycle → false', () => {
    expect(isDoctorBookingPermitted({ accountLifecycle: { status: 'deletionPending' } })).toBe(false);
  });

  test('deleted lifecycle → false', () => {
    expect(isDoctorBookingPermitted({ accountLifecycle: { status: 'deleted' } })).toBe(false);
  });

  test('active lifecycle, bookingDisabled=true → false', () => {
    expect(isDoctorBookingPermitted({
      accountLifecycle: { status: 'active', doctorState: { bookingDisabled: true } },
    })).toBe(false);
  });

  test('active lifecycle, bookingDisabled=false → true', () => {
    expect(isDoctorBookingPermitted({
      accountLifecycle: { status: 'active', doctorState: { bookingDisabled: false } },
    })).toBe(true);
  });
});

// ─── isPatientBookingPermitted ────────────────────────────────────────────────

describe('isPatientBookingPermitted', () => {
  test('null data → true', () => {
    expect(isPatientBookingPermitted(null)).toBe(true);
  });

  test('no accountLifecycle → true', () => {
    expect(isPatientBookingPermitted({ role: 'patient' })).toBe(true);
  });

  test('active lifecycle → true', () => {
    expect(isPatientBookingPermitted({ accountLifecycle: { status: 'active' } })).toBe(true);
  });

  test('deletionPending lifecycle → false', () => {
    expect(isPatientBookingPermitted({ accountLifecycle: { status: 'deletionPending' } })).toBe(false);
  });

  test('deleted lifecycle → false', () => {
    expect(isPatientBookingPermitted({ accountLifecycle: { status: 'deleted' } })).toBe(false);
  });
});

// ─── expireCenters lifecycle guard (inline logic check) ──────────────────────

describe('expireCenters lifecycle guard', () => {
  const TERMINAL = ['closurePending', 'closed', 'archived'];

  // The guard in expireCenters.js:
  //   const lifecycleStatus = data.accountLifecycle?.status;
  //   if (lifecycleStatus && TERMINAL_STATUSES.includes(lifecycleStatus)) → skip
  function shouldSkip(data) {
    const lifecycleStatus = data?.accountLifecycle?.status;
    return !!(lifecycleStatus && TERMINAL.includes(lifecycleStatus));
  }

  test('no accountLifecycle → not skipped', () => {
    expect(shouldSkip({ trialEnds: new Date() })).toBe(false);
  });

  test('active lifecycle → not skipped', () => {
    expect(shouldSkip({ accountLifecycle: { status: 'active' } })).toBe(false);
  });

  test('closurePending → skipped', () => {
    expect(shouldSkip({ accountLifecycle: { status: 'closurePending' } })).toBe(true);
  });

  test('closed → skipped', () => {
    expect(shouldSkip({ accountLifecycle: { status: 'closed' } })).toBe(true);
  });

  test('archived → skipped', () => {
    expect(shouldSkip({ accountLifecycle: { status: 'archived' } })).toBe(true);
  });
});

// ─── computeSubscriptionFreeze ISO string fix (date parsing logic) ────────────
// We test the date parsing logic that was added to fix the ISO string bug.
// This does NOT require firebase-admin — pure date math.

describe('computeSubscriptionFreeze date parsing logic', () => {
  // Extracted from helpers.js to test independently
  function toExpiryMs(expiresAt) {
    if (!expiresAt) return NaN;
    if (expiresAt.toMillis) return expiresAt.toMillis();         // Firestore Timestamp
    if (typeof expiresAt === 'string') return Date.parse(expiresAt); // ISO string
    return Number(expiresAt);
  }

  test('Firestore Timestamp → toMillis() called', () => {
    const ts = { toMillis: () => 9999999999000 };
    expect(toExpiryMs(ts)).toBe(9999999999000);
  });

  test('ISO string (future) → positive finite milliseconds', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const ms = toExpiryMs(future);
    expect(isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(Date.now());
  });

  test('ISO string (past) → finite but smaller than now', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const ms = toExpiryMs(past);
    expect(isFinite(ms)).toBe(true);
    expect(ms).toBeLessThan(Date.now());
  });

  test('unparseable string → NaN (fail-safe triggers null return)', () => {
    const ms = toExpiryMs('not-a-date');
    expect(isFinite(ms)).toBe(false);
    expect(isNaN(ms)).toBe(true);
  });

  test('null → NaN', () => {
    expect(isNaN(toExpiryMs(null))).toBe(true);
  });
});
