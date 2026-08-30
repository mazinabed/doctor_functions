'use strict';

/**
 * Provider subscription expiry sync — pure unit tests, no emulator.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `expireCenters` scanned `medical_centers` only. A pharmacy or lab keeps its
 * subscription on its OWN document, so a lapsed provider kept
 * `subscriptionStatus: 'active'` indefinitely — every status-based admin query
 * counted an expired lab as active.
 *
 * Access was never affected: the client and the Firestore rules both derive
 * operational state from the DATES, so a delayed or failed run of this job
 * cannot grant access to an expired provider. That property is why this is data
 * hygiene rather than security, and the tests below keep it that way by pinning
 * that the job can only ever write 'grace' or 'expired' — never 'active'.
 *
 * ── The one hard difference from deriveTargetStatus ─────────────────────────
 *
 * A provider carries two independent statuses:
 *
 *   subscriptionStatus  trial | active | grace | expired | pending_activation
 *   status              pending | active | suspended | rejected
 *
 * `status` is an administrative decision. A lapsed invoice must never overwrite
 * it, which is why this derivation returns `subscriptionStatus` alone.
 */

const {
  deriveProviderSubscriptionStatus,
  deriveTargetStatus,
} = require('../functions/lib/expireLogic');

const NOW = new Date('2026-08-29T00:00:00Z');
const PAST = new Date('2026-07-21T00:00:00Z');
const FUTURE = new Date('2027-02-28T00:00:00Z');

/** Firestore Timestamp shape, as the SDK returns it. */
function ts(date) {
  return { toDate: () => date };
}

describe('the reported expired lab', () => {
  // status active, subscriptionStatus active, period 2026-06-21 -> 2026-07-21.
  const lab = {
    status: 'active',
    subscriptionStatus: 'active',
    subscriptionStart: ts(new Date('2026-06-21T00:00:00Z')),
    subscriptionEnd: ts(PAST),
  };

  test('is expired by the job', () => {
    expect(deriveProviderSubscriptionStatus(lab, NOW))
      .toEqual({ subscriptionStatus: 'expired' });
  });

  test('the write NEVER includes an account status field', () => {
    // deriveTargetStatus returns centerStatus, which on a provider document is
    // the administrative `status`. That is exactly why it is not reused here.
    const result = deriveProviderSubscriptionStatus(lab, NOW);
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('centerStatus');
    expect(Object.keys(result)).toEqual(['subscriptionStatus']);
  });

  test('re-running the job is idempotent', () => {
    const after = { ...lab, subscriptionStatus: 'expired' };
    expect(deriveProviderSubscriptionStatus(after, NOW)).toBeNull();
  });
});

describe('providers that must NOT be expired', () => {
  test('a future subscriptionEnd stays untouched', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'active', subscriptionEnd: ts(FUTURE) },
      NOW,
    )).toBeNull();
  });

  test('a live trial stays untouched', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'trial', trialEnds: ts(FUTURE) },
      NOW,
    )).toBeNull();
  });

  test('an expired subscription inside a valid grace window becomes grace', () => {
    expect(deriveProviderSubscriptionStatus(
      {
        status: 'active',
        subscriptionStatus: 'active',
        subscriptionEnd: ts(PAST),
        gracePeriodEnds: ts(FUTURE),
      },
      NOW,
    )).toEqual({ subscriptionStatus: 'grace' });
  });

  test('a provider already marked grace inside its window is left alone', () => {
    expect(deriveProviderSubscriptionStatus(
      {
        status: 'active',
        subscriptionStatus: 'grace',
        subscriptionEnd: ts(PAST),
        gracePeriodEnds: ts(FUTURE),
      },
      NOW,
    )).toBeNull();
  });

  test('a provider with no date fields at all is left alone (fail-closed)', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'active' },
      NOW,
    )).toBeNull();
  });

  test('malformed date values are treated as absent, not as expiry', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'active', subscriptionEnd: '2026-07-21' },
      NOW,
    )).toBeNull();
  });
});

describe('pending approval is preserved', () => {
  test('a submitted payment awaiting approval is not overwritten', () => {
    // Overwriting it with 'expired' would replace "Pending approval" with
    // "Subscription ended" in the portal and lose the fact that the provider
    // has already paid and is waiting on an admin.
    expect(deriveProviderSubscriptionStatus(
      {
        status: 'active',
        subscriptionStatus: 'pending_activation',
        subscriptionEnd: ts(PAST),
      },
      NOW,
    )).toBeNull();
  });

  test('pending is preserved even with no dates at all', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'pending_activation' },
      NOW,
    )).toBeNull();
  });
});

describe('administrative account state is never corrupted', () => {
  test('a suspended account is skipped entirely', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'suspended', subscriptionStatus: 'active', subscriptionEnd: ts(PAST) },
      NOW,
    )).toBeNull();
  });

  test('a rejected account is skipped entirely', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'rejected', subscriptionStatus: 'active', subscriptionEnd: ts(PAST) },
      NOW,
    )).toBeNull();
  });

  test('a suspended account with a VALID subscription is also skipped', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'suspended', subscriptionStatus: 'active', subscriptionEnd: ts(FUTURE) },
      NOW,
    )).toBeNull();
  });

  test('a pending (not yet approved) account still syncs its billing status', () => {
    // 'pending' is an account awaiting admin review, not a suspension — its
    // subscription clock still runs.
    expect(deriveProviderSubscriptionStatus(
      { status: 'pending', subscriptionStatus: 'active', subscriptionEnd: ts(PAST) },
      NOW,
    )).toEqual({ subscriptionStatus: 'expired' });
  });
});

describe('the job can never grant access', () => {
  test('it never returns active or trial, whatever the input', () => {
    const inputs = [
      { status: 'active', subscriptionStatus: 'expired', subscriptionEnd: ts(PAST) },
      { status: 'active', subscriptionStatus: 'trial', trialEnds: ts(PAST) },
      { status: 'active', subscriptionStatus: 'none', gracePeriodEnds: ts(PAST) },
      { status: 'active', subscriptionStatus: 'grace', subscriptionEnd: ts(PAST) },
    ];
    for (const input of inputs) {
      const result = deriveProviderSubscriptionStatus(input, NOW);
      if (result) {
        expect(['grace', 'expired']).toContain(result.subscriptionStatus);
      }
    }
  });

  test('an expired trial with no grace expires', () => {
    expect(deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'trial', trialEnds: ts(PAST) },
      NOW,
    )).toEqual({ subscriptionStatus: 'expired' });
  });
});

describe('medical center expiry is unchanged', () => {
  // The center derivation still owns centerStatus; adding the provider pass
  // must not have altered it.
  test('an expired center still locks', () => {
    expect(deriveTargetStatus(
      { subscriptionStatus: 'active', centerStatus: 'operational', subscriptionEnd: ts(PAST) },
      NOW,
    )).toEqual({ subscriptionStatus: 'expired', centerStatus: 'locked' });
  });

  test('a center with a future subscription is untouched', () => {
    expect(deriveTargetStatus({ subscriptionEnd: ts(FUTURE) }, NOW)).toBeNull();
  });

  test('a center in grace stays operational', () => {
    expect(deriveTargetStatus(
      { subscriptionEnd: ts(PAST), gracePeriodEnds: ts(FUTURE) },
      NOW,
    )).toEqual({ subscriptionStatus: 'grace', centerStatus: 'operational' });
  });

  test('the two derivations remain separate functions', () => {
    // A provider result must never carry centerStatus, and a center result
    // must still carry it — the whole reason for two functions.
    const provider = deriveProviderSubscriptionStatus(
      { status: 'active', subscriptionStatus: 'active', subscriptionEnd: ts(PAST) },
      NOW,
    );
    const center = deriveTargetStatus(
      { subscriptionStatus: 'active', centerStatus: 'operational', subscriptionEnd: ts(PAST) },
      NOW,
    );
    expect(provider).not.toHaveProperty('centerStatus');
    expect(center).toHaveProperty('centerStatus');
  });
});
