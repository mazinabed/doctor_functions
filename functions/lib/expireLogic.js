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

module.exports = { deriveTargetStatus, BATCH_LIMIT };
