'use strict';

/**
 * Phase 2 — expiry synchronization logic tests.
 *
 * Tests the pure `deriveTargetStatus(data, now)` function that drives the
 * expireCenters Cloud Function. No emulator needed — these are deterministic
 * unit tests of the decision logic only.
 *
 * The function mirrors centerAccessProvider date-only logic:
 * operational = now < trialEnds  OR  now < subscriptionEnd  OR  now < gracePeriodEnds.
 */

const {
  deriveTargetStatus,
  deriveCommerceTargetStatus,
  deriveCommerceReminderStage,
} = require('../functions/lib/expireLogic');

const NOW    = new Date('2026-05-17T01:00:00Z');
const PAST   = new Date('2026-04-01T00:00:00Z');   // ~46 days before NOW
const FUTURE = new Date('2026-06-17T00:00:00Z');   // ~31 days after NOW

const makeTimestamp = (d) => ({ toDate: () => d });


// ─────────────────────────────────────────────────────────────────────────────
// STILL OPERATIONAL — no write expected
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 — no write: center still operational', () => {

  test('P2-1 NO WRITE — trial still running (trialEnds future)', () => {
    expect(deriveTargetStatus({ trialEnds: FUTURE }, NOW)).toBeNull();
  });

  test('P2-2 NO WRITE — subscription still running (subscriptionEnd future)', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionEnd: FUTURE,
    }, NOW)).toBeNull();
  });

  test('P2-3 NO WRITE — only subscriptionEnd present, still future', () => {
    expect(deriveTargetStatus({ subscriptionEnd: FUTURE }, NOW)).toBeNull();
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// GRACE PERIOD
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 — grace period transitions', () => {

  test('P2-4 WRITE grace — subscription past, grace future, currently active/operational', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionEnd: PAST,
      gracePeriodEnds: FUTURE,
      subscriptionStatus: 'active',
      centerStatus: 'operational',
    }, NOW)).toEqual({ subscriptionStatus: 'grace', centerStatus: 'operational' });
  });

  test('P2-5 WRITE grace — grace future, no prior status fields', () => {
    expect(deriveTargetStatus({
      gracePeriodEnds: FUTURE,
    }, NOW)).toEqual({ subscriptionStatus: 'grace', centerStatus: 'operational' });
  });

  test('P2-6 NO WRITE — already in grace, idempotent', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionEnd: PAST,
      gracePeriodEnds: FUTURE,
      subscriptionStatus: 'grace',
      centerStatus: 'operational',
    }, NOW)).toBeNull();
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// FULL EXPIRY — lock
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 — full expiry (lock)', () => {

  test('P2-7 WRITE locked — all windows past, currently active/operational', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionEnd: PAST,
      gracePeriodEnds: PAST,
      subscriptionStatus: 'active',
      centerStatus: 'operational',
    }, NOW)).toEqual({ subscriptionStatus: 'expired', centerStatus: 'locked' });
  });

  test('P2-8 WRITE locked — trial expired, no subscription or grace ever set', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionStatus: 'trial',
      centerStatus: 'operational',
    }, NOW)).toEqual({ subscriptionStatus: 'expired', centerStatus: 'locked' });
  });

  test('P2-9 WRITE locked — subscription past, no gracePeriodEnds field', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionEnd: PAST,
      subscriptionStatus: 'active',
      centerStatus: 'operational',
    }, NOW)).toEqual({ subscriptionStatus: 'expired', centerStatus: 'locked' });
  });

  test('P2-10 NO WRITE — already expired+locked, idempotent', () => {
    expect(deriveTargetStatus({
      trialEnds: PAST,
      subscriptionEnd: PAST,
      gracePeriodEnds: PAST,
      subscriptionStatus: 'expired',
      centerStatus: 'locked',
    }, NOW)).toBeNull();
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED — malformed data produces no write
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 — fail-closed: malformed or missing date fields', () => {

  test('P2-11 NO WRITE — no date fields at all', () => {
    expect(deriveTargetStatus({
      subscriptionStatus: 'trial',
      centerStatus: 'operational',
    }, NOW)).toBeNull();
  });

  test('P2-12 NO WRITE — completely empty doc', () => {
    expect(deriveTargetStatus({}, NOW)).toBeNull();
  });

  test('P2-13 NO WRITE — null date field values', () => {
    expect(deriveTargetStatus({
      trialEnds: null,
      subscriptionEnd: null,
      gracePeriodEnds: null,
    }, NOW)).toBeNull();
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// MUST NOT ACTIVATE — function must never produce 'active' or 'trial'
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 — activation guard: must never produce active or trial', () => {

  const allCases = [
    { trialEnds: FUTURE },
    { subscriptionEnd: FUTURE },
    { trialEnds: PAST, subscriptionEnd: PAST, gracePeriodEnds: FUTURE },
    { trialEnds: PAST, subscriptionEnd: PAST, gracePeriodEnds: PAST },
    { trialEnds: PAST },
    {},
  ];

  test('P2-14 NEVER produces subscriptionStatus active or trial across all cases', () => {
    for (const data of allCases) {
      const result = deriveTargetStatus(data, NOW);
      if (result !== null) {
        expect(['grace', 'expired']).toContain(result.subscriptionStatus);
        expect(['operational', 'locked']).toContain(result.centerStatus);
      }
    }
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// FIRESTORE TIMESTAMP COMPATIBILITY
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2 — Firestore Timestamp compatibility', () => {

  test('P2-15 handles Timestamp with .toDate() — past trial → locked', () => {
    expect(deriveTargetStatus({
      trialEnds: makeTimestamp(PAST),
      subscriptionStatus: 'trial',
      centerStatus: 'operational',
    }, NOW)).toEqual({ subscriptionStatus: 'expired', centerStatus: 'locked' });
  });

  test('P2-16 handles Timestamp with .toDate() — future trial → no write', () => {
    expect(deriveTargetStatus({
      trialEnds: makeTimestamp(FUTURE),
    }, NOW)).toBeNull();
  });

  test('P2-17 handles Timestamp with .toDate() — grace period active', () => {
    expect(deriveTargetStatus({
      trialEnds: makeTimestamp(PAST),
      subscriptionEnd: makeTimestamp(PAST),
      gracePeriodEnds: makeTimestamp(FUTURE),
      subscriptionStatus: 'active',
      centerStatus: 'operational',
    }, NOW)).toEqual({ subscriptionStatus: 'grace', centerStatus: 'operational' });
  });

  test('P2-18 handles mixed Timestamp + Date fields', () => {
    expect(deriveTargetStatus({
      trialEnds: makeTimestamp(PAST),
      subscriptionEnd: PAST,
      gracePeriodEnds: makeTimestamp(FUTURE),
      subscriptionStatus: 'grace',
      centerStatus: 'operational',
    }, NOW)).toBeNull(); // already grace — idempotent
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B — Commerce billing: deriveCommerceTargetStatus
// Same contract as deriveTargetStatus, over commerce*-namespaced fields,
// but must NEVER return centerStatus/subscriptionStatus keys.
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1B — Commerce: no write while still operational', () => {
  test('C-1 NO WRITE — commerce trial still running', () => {
    expect(deriveCommerceTargetStatus({ commerceTrialEnds: FUTURE }, NOW)).toBeNull();
  });

  test('C-2 NO WRITE — commerce subscription still running', () => {
    expect(deriveCommerceTargetStatus({
      commerceTrialEnds: PAST,
      commerceSubscriptionEnd: FUTURE,
    }, NOW)).toBeNull();
  });

  test('C-3 NO WRITE — migration-grandfathered pharmacy (no Commerce dates at all)', () => {
    expect(deriveCommerceTargetStatus({
      commerceSubscriptionStatus: 'active',
      commercePlanId: 'starter',
      commerceTrialCompleted: true,
    }, NOW)).toBeNull();
  });

  test('C-4 NO WRITE — Commerce never enabled (no fields at all)', () => {
    expect(deriveCommerceTargetStatus({}, NOW)).toBeNull();
  });
});

describe('Phase 1B — Commerce: grace period', () => {
  test('C-5 WRITE grace — trial ended, within 7-day grace window', () => {
    expect(deriveCommerceTargetStatus({
      commerceTrialEnds: PAST,
      commerceGracePeriodEnds: FUTURE,
    }, NOW)).toEqual({ commerceSubscriptionStatus: 'grace' });
  });

  test('C-6 NO WRITE — already correctly in grace (idempotent)', () => {
    expect(deriveCommerceTargetStatus({
      commerceTrialEnds: PAST,
      commerceGracePeriodEnds: FUTURE,
      commerceSubscriptionStatus: 'grace',
    }, NOW)).toBeNull();
  });
});

describe('Phase 1B — Commerce: expired', () => {
  test('C-7 WRITE expired — all Commerce windows exhausted', () => {
    expect(deriveCommerceTargetStatus({
      commerceTrialEnds: PAST,
      commerceGracePeriodEnds: PAST,
    }, NOW)).toEqual({ commerceSubscriptionStatus: 'expired' });
  });

  test('C-8 NO WRITE — already correctly expired (idempotent)', () => {
    expect(deriveCommerceTargetStatus({
      commerceTrialEnds: PAST,
      commerceGracePeriodEnds: PAST,
      commerceSubscriptionStatus: 'expired',
    }, NOW)).toBeNull();
  });

  test('C-9 output NEVER includes centerStatus or subscriptionStatus keys', () => {
    const result = deriveCommerceTargetStatus({
      commerceTrialEnds: PAST,
      commerceGracePeriodEnds: PAST,
    }, NOW);
    expect(result).not.toHaveProperty('centerStatus');
    expect(result).not.toHaveProperty('subscriptionStatus');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B — Commerce billing: deriveCommerceReminderStage
// ─────────────────────────────────────────────────────────────────────────────

const addDaysTo = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

describe('Phase 1B — Commerce: reminder stages', () => {
  test('R-1 NO REMINDER — Commerce never enabled', () => {
    expect(deriveCommerceReminderStage({}, NOW)).toBeNull();
  });

  test('R-2 NO REMINDER — anchor more than 14 days away', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, 20),
    }, NOW)).toBeNull();
  });

  test('R-3 fires 14d stage exactly 14 days before trial end', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, 14),
    }, NOW)).toBe('14d');
  });

  test('R-4 fires 7d stage, using commerceSubscriptionEnd as the anchor when set', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, -60), // old trial, irrelevant once subscribed
      commerceSubscriptionEnd: addDaysTo(NOW, 7),
    }, NOW)).toBe('7d');
  });

  test('R-5 does not re-fire a stage already sent', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, 7),
      commerceLastReminderStage: '7d',
    }, NOW)).toBeNull();
  });

  test('R-6 catches up to the MOST ADVANCED reached stage, not a backlog', () => {
    // Trial ended 10 days ago with NO reminder ever sent — should jump
    // straight to 'expiry' (the latest reached stage), not fire 14d/7d/3d/1d
    // retroactively in one run.
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, -10),
      commerceGracePeriodEnds: addDaysTo(NOW, -3), // still resolves - grace already passed too, but 'final' needs grace reached
    }, NOW)).toBe('final');
  });

  test('R-7 fires expiry stage on the anchor day itself', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: NOW,
    }, NOW)).toBe('expiry');
  });

  test('R-8 fires grace stage one day into the grace window', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, -1),
      commerceLastReminderStage: 'expiry',
    }, NOW)).toBe('grace');
  });

  test('R-9 fires final stage exactly when commerceGracePeriodEnds passes', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, -30),
      commerceGracePeriodEnds: NOW,
      commerceLastReminderStage: 'grace',
    }, NOW)).toBe('final');
  });

  test('R-10 no final stage possible without commerceGracePeriodEnds set', () => {
    expect(deriveCommerceReminderStage({
      commerceTrialEnds: addDaysTo(NOW, -30),
      commerceLastReminderStage: 'grace',
    }, NOW)).toBeNull(); // 'grace' was the latest reachable stage without a grace end date, already sent
  });
});
