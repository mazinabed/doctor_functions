'use strict';

/**
 * Pure decision logic for Phase 2 expiry synchronization.
 *
 * Mirrors centerAccessProvider date-only computation from the Flutter client:
 * a center is operational when now < trialEnds  OR  now < subscriptionEnd
 * OR  now < gracePeriodEnds.
 *
 * Injectable `now` parameter enables deterministic unit testing.
 *
 * CONSTRAINTS (hard — must never be violated):
 *   - Returns only 'grace' or 'expired' — never 'active' or 'trial'.
 *   - Returns null (no write) when any operational date window is still valid.
 *   - Returns null when no date fields are present (fail-closed).
 *   - Idempotent: re-running on an already-correct center returns null.
 */

const BATCH_LIMIT = 499; // Firestore hard limit is 500; leave one slot of margin.

/**
 * Converts a value to a JS Date, handling Firestore Timestamps (admin or web SDK)
 * and plain Date objects. Returns null for anything else.
 *
 * @param {*} v
 * @returns {Date | null}
 */
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
  if (v instanceof Date) return v;
  return null;
}

/**
 * Given center document data and the current time, returns the status fields
 * that need to be written, or null if no write is needed.
 *
 * @param {Object} data  Firestore document data for the center
 * @param {Date}   now   Current time (injected — never reads Date.now() internally)
 * @returns {{ subscriptionStatus: string, centerStatus: string } | null}
 */
function deriveTargetStatus(data, now) {
  const trialEnds       = toDate(data.trialEnds);
  const subscriptionEnd = toDate(data.subscriptionEnd);
  const gracePeriodEnds = toDate(data.gracePeriodEnds);

  // Fail-closed: no date fields → no write.
  if (!trialEnds && !subscriptionEnd && !gracePeriodEnds) {
    return null;
  }

  const inTrial        = trialEnds       !== null && now < trialEnds;
  const inSubscription = subscriptionEnd !== null && now < subscriptionEnd;
  const inGrace        = gracePeriodEnds !== null && now < gracePeriodEnds;

  // Still within a valid operational window — do not expire.
  if (inTrial || inSubscription) {
    return null;
  }

  if (inGrace) {
    // Grace period active: sync status but leave center operational.
    if (data.subscriptionStatus === 'grace' && data.centerStatus === 'operational') {
      return null; // already correct
    }
    return { subscriptionStatus: 'grace', centerStatus: 'operational' };
  }

  // All windows exhausted — lock.
  if (data.subscriptionStatus === 'expired' && data.centerStatus === 'locked') {
    return null; // already correct
  }
  return { subscriptionStatus: 'expired', centerStatus: 'locked' };
}

/**
 * Provider-side expiry sync for `pharmacy_providers` and
 * `diagnostic_providers`.
 *
 * Same date rules as deriveTargetStatus, one hard difference: it returns ONLY
 * `subscriptionStatus`, never an account status field.
 *
 * A provider document carries TWO independent statuses:
 *
 *   subscriptionStatus  trial | active | grace | expired | pending_activation
 *   status              pending | active | suspended | rejected
 *
 * `status` is the administrative decision an admin made about the account, and
 * a lapsed invoice must never overwrite it. That is why deriveTargetStatus is
 * not reused directly here — it returns `centerStatus`, which on a provider
 * document is that very field.
 *
 * CONSTRAINTS (hard):
 *   - Returns only 'grace' or 'expired' — never 'active' or 'trial'. This job
 *     can expire a subscription; only a real payment approval can grant one.
 *   - Returns null when any operational window is still valid.
 *   - Returns null when no date fields are present (fail-closed).
 *   - Returns null for pending_activation: the provider has paid and is
 *     waiting on an admin, and overwriting it with 'expired' would replace
 *     "Pending approval" with "Subscription ended" in the portal and lose the
 *     fact that they acted.
 *   - Returns null for suspended/rejected accounts: they are outside the
 *     normal billing flow, and this job has no business writing to them.
 *   - Idempotent: re-running against an already-synced provider returns null.
 *
 * @param {Object} data Provider document data
 * @param {Date}   now  Injected current time
 * @returns {{ subscriptionStatus: string } | null}
 */
function deriveProviderSubscriptionStatus(data, now) {
  const accountStatus = data.status;
  if (accountStatus === 'suspended' || accountStatus === 'rejected') {
    return null;
  }

  // A submitted payment awaiting approval is a state the admin still has to
  // act on. It is not this job's to clear.
  if (data.subscriptionStatus === 'pending_activation') {
    return null;
  }

  const trialEnds       = toDate(data.trialEnds);
  const subscriptionEnd = toDate(data.subscriptionEnd);
  const gracePeriodEnds = toDate(data.gracePeriodEnds);

  // Fail-closed: nothing to reason from → no write.
  if (!trialEnds && !subscriptionEnd && !gracePeriodEnds) {
    return null;
  }

  const inTrial        = trialEnds       !== null && now < trialEnds;
  const inSubscription = subscriptionEnd !== null && now < subscriptionEnd;
  const inGrace        = gracePeriodEnds !== null && now < gracePeriodEnds;

  if (inTrial || inSubscription) {
    return null;
  }

  if (inGrace) {
    if (data.subscriptionStatus === 'grace') return null;
    return { subscriptionStatus: 'grace' };
  }

  if (data.subscriptionStatus === 'expired') return null;
  return { subscriptionStatus: 'expired' };
}

/**
 * Phase 1B (Commerce Billing) — Commerce's own, fully independent derivation,
 * over commerce*-namespaced fields on the SAME medical_centers document.
 *
 * CONSTRAINTS (hard — must never be violated, mirroring deriveTargetStatus's
 * own contract exactly, plus one Commerce-specific rule):
 *   - Returns only 'grace' or 'expired' — never 'active' or 'trial'.
 *   - Returns null (no write) when any operational date window is still valid.
 *   - Returns null when no Commerce date fields are present — this is what
 *     naturally leaves migration-grandfathered pharmacies alone (they have
 *     commerceSubscriptionStatus:'active' but no trial/subscription/grace
 *     dates at all until a real billing cycle is later assigned).
 *   - NEVER returns centerStatus/subscriptionStatus keys — Commerce expiry
 *     must never lock the center or affect the Healthcare subscription.
 *   - Idempotent: re-running on an already-correct center returns null.
 */
function deriveCommerceTargetStatus(data, now) {
  const trialEnds       = toDate(data.commerceTrialEnds);
  const subscriptionEnd = toDate(data.commerceSubscriptionEnd);
  const gracePeriodEnds = toDate(data.commerceGracePeriodEnds);

  if (!trialEnds && !subscriptionEnd && !gracePeriodEnds) {
    return null;
  }

  const inTrial        = trialEnds       !== null && now < trialEnds;
  const inSubscription = subscriptionEnd !== null && now < subscriptionEnd;
  const inGrace         = gracePeriodEnds !== null && now < gracePeriodEnds;

  if (inTrial || inSubscription) {
    return null;
  }

  if (inGrace) {
    if (data.commerceSubscriptionStatus === 'grace') return null;
    return { commerceSubscriptionStatus: 'grace' };
  }

  if (data.commerceSubscriptionStatus === 'expired') return null;
  return { commerceSubscriptionStatus: 'expired' };
}

/**
 * Phase 1B (Commerce Billing) — reminder-stage derivation.
 *
 * 7 stages, in chronological order: 14d/7d/3d/1d before the current anchor
 * date (commerceSubscriptionEnd if set, else commerceTrialEnds), then
 * 'expiry' (the anchor date itself), 'grace' (one day into the 7-day grace
 * window — a distinct, later notice from 'expiry', not a duplicate of it),
 * then 'final' (the moment commerceGracePeriodEnds itself passes — genuine
 * suspension). These offsets are proposed defaults, not extracted from any
 * pre-existing constant — no billing-reminder schedule existed before this.
 *
 * Returns the single MOST-ADVANCED stage whose trigger date has been
 * reached and that does not match `data.commerceLastReminderStage` — never
 * more than one stage per call, so a pharmacy that already passed several
 * thresholds before this logic first ran does not get a backlog of
 * reminders fired all at once, just the most current one. Returns null
 * when no Commerce billing cycle exists, or the currently-reached stage
 * was already sent.
 */
const REMINDER_STAGE_OFFSET_DAYS = { '14d': -14, '7d': -7, '3d': -3, '1d': -1, expiry: 0, grace: 1 };
const REMINDER_STAGES = ['14d', '7d', '3d', '1d', 'expiry', 'grace', 'final'];

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function deriveCommerceReminderStage(data, now) {
  const trialEnds       = toDate(data.commerceTrialEnds);
  const subscriptionEnd = toDate(data.commerceSubscriptionEnd);
  const gracePeriodEnds = toDate(data.commerceGracePeriodEnds);
  const anchor = subscriptionEnd || trialEnds;

  if (!anchor) return null; // no Commerce billing cycle — nothing to remind

  let latestReachedStage = null;
  for (const stage of REMINDER_STAGES) {
    let triggerDate;
    if (stage === 'final') {
      if (!gracePeriodEnds) continue;
      triggerDate = gracePeriodEnds;
    } else {
      triggerDate = addDays(anchor, REMINDER_STAGE_OFFSET_DAYS[stage]);
    }
    if (now >= triggerDate) {
      latestReachedStage = stage;
    }
  }

  if (!latestReachedStage) return null;
  if (latestReachedStage === data.commerceLastReminderStage) return null;
  return latestReachedStage;
}

module.exports = {
  deriveProviderSubscriptionStatus,
  deriveTargetStatus,
  deriveCommerceTargetStatus,
  deriveCommerceReminderStage,
  REMINDER_STAGES,
  BATCH_LIMIT,
};
