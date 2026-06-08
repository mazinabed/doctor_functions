'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { deriveTargetStatus, BATCH_LIMIT } = require('./lib/expireLogic');

/**
 * Phase 2 — Daily subscription expiry synchronization.
 *
 * Reads all non-locked medical centers, re-derives operational state from
 * date fields (trialEnds, subscriptionEnd, gracePeriodEnds), and writes
 * subscriptionStatus + centerStatus where needed.
 *
 * This function is REPORTING/SYNC ONLY.
 * Access enforcement remains in:
 *   - centerAccessProvider (Flutter client, date-only)
 *   - centerIsOperational (Firestore rules, date-only)
 *
 * MUST NOT: activate subscriptions, write 'active'/'trial' status,
 *           modify payments collection, modify doctor docs,
 *           or overwrite future valid date fields.
 */
exports.expireCenters = onSchedule(
  { schedule: '0 1 * * *', timeZone: 'UTC' },
  async (_event) => {
    const db  = getFirestore();
    const now = new Date();

    // Query candidates: skip already-locked centers.
    // Requires composite index on (centerStatus, __name__) — auto-created on deploy.
    const snap = await db
      .collection('medical_centers')
      .where('centerStatus', '!=', 'locked')
      .get();

    console.log(`expireCenters: ${snap.size} candidate center(s) found`);

    let batch      = db.batch();
    let batchCount = 0;
    let updated    = 0;
    let skipped    = 0;
    let malformed  = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data();

      // Skip centers in lifecycle-terminal states — subscription sync is irrelevant
      // for centers that are closing or have been archived.
      const lifecycleStatus = data.accountLifecycle?.status;
      if (lifecycleStatus && ['closurePending', 'closed', 'archived'].includes(lifecycleStatus)) {
        console.log(`expireCenters: skipped ${docSnap.id} — lifecycle status=${lifecycleStatus}`);
        skipped++;
        continue;
      }

      // Log malformed docs that have no date fields at all.
      const hasAnyDate = data.trialEnds || data.subscriptionEnd || data.gracePeriodEnds;
      if (!hasAnyDate) {
        console.warn(`expireCenters: MALFORMED — ${docSnap.id} has no date fields, skipping`);
        malformed++;
        continue;
      }

      const target = deriveTargetStatus(data, now);
      if (!target) {
        skipped++;
        continue;
      }

      batch.update(docSnap.ref, {
        ...target,
        statusSyncedAt: FieldValue.serverTimestamp(),
      });
      batchCount++;
      updated++;

      console.log(
        `expireCenters: queued ${docSnap.id} → ` +
        `subscriptionStatus=${target.subscriptionStatus} centerStatus=${target.centerStatus}`
      );

      // Flush before hitting the hard 500-op Firestore batch limit.
      if (batchCount >= BATCH_LIMIT) {
        await batch.commit();
        console.log(`expireCenters: committed batch of ${batchCount}`);
        batch      = db.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
      console.log(`expireCenters: committed final batch of ${batchCount}`);
    }

    console.log(
      `expireCenters: complete — updated=${updated} skipped=${skipped} malformed=${malformed}`
    );
  }
);
