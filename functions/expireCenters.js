'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  deriveTargetStatus,
  deriveProviderSubscriptionStatus,
  deriveCommerceTargetStatus,
  deriveCommerceReminderStage,
  BATCH_LIMIT,
} = require('./lib/expireLogic');
const { sendFcmPush } = require('./reminders/sendDailyReminders');
const { commerceReminderContent } = require('./lib/commerceReminderContent');

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
 *
 * Phase 1B (Commerce Billing) extension: the SAME daily pass over the SAME
 * documents also derives commerceSubscriptionStatus (deriveCommerceTargetStatus)
 * and checks for a due reminder stage (deriveCommerceReminderStage) — one
 * extra read per center, zero extra scheduled functions. Commerce's own
 * derivation NEVER writes centerStatus/subscriptionStatus, and Healthcare's
 * own derivation never reads/writes commerce* fields — the two state
 * machines share a document, never a code path (Commerce expiring can never
 * lock a center; a Healthcare-side lock can never suspend Commerce). Both
 * sets of field updates for a given center are merged into a SINGLE
 * batch.update() call — never two separate calls against the same
 * DocumentReference in one batch.
 *
 * Because the main query below deliberately excludes centerStatus=='locked'
 * centers (Healthcare-side, unchanged from before this phase), a SECOND,
 * Commerce-only pass separately covers already-locked centers — a pharmacy
 * whose Healthcare listing has expired must still have its independent
 * Commerce subscription tracked and reminded, per the finalized "Healthcare
 * expiration affects only Healthcare; Commerce expiration affects only
 * Commerce" decision.
 */

// Computes the Commerce-side field updates (if any) for one center and
// sends a reminder (Firestore notification + FCM) if a new stage is due.
// Returns the fields to merge into the caller's single batch.update() call
// for this document — never writes to the batch itself.
async function computeCommerceUpdate(db, docSnap, data, now) {
  const fields = {};
  let statusChanged = false;
  let reminderSent = false;

  const commerceTarget = deriveCommerceTargetStatus(data, now);
  if (commerceTarget) {
    Object.assign(fields, commerceTarget, {
      commerceSubscriptionStatusSyncedAt: FieldValue.serverTimestamp(),
    });
    statusChanged = true;
    console.log(
      `expireCenters: ${docSnap.id} → commerceSubscriptionStatus=${commerceTarget.commerceSubscriptionStatus}`,
    );
  }

  const reminderStage = deriveCommerceReminderStage(data, now);
  if (reminderStage) {
    const ownerUid = data.ownerId;
    if (!ownerUid) {
      console.warn(`expireCenters: center ${docSnap.id} has no ownerId — cannot send Commerce reminder`);
    } else {
      const content = commerceReminderContent(reminderStage);
      const reminderId = `commerce_reminder_${docSnap.id}_${reminderStage}`;
      const notifRef = db.collection('users').doc(ownerUid).collection('notifications').doc(reminderId);

      const existing = await notifRef.get();
      if (!existing.exists) {
        await notifRef.set({
          type: 'commerce_billing_reminder',
          stage: reminderStage,
          centerId: docSnap.id,
          titleEn: content.titleEn,
          titleAr: content.titleAr,
          titleKu: content.titleKu,
          bodyEn: content.bodyEn,
          bodyAr: content.bodyAr,
          bodyKu: content.bodyKu,
          isRead: false,
          createdAt: FieldValue.serverTimestamp(),
        });

        try {
          await sendFcmPush(db, ownerUid, content, { type: 'commerce_billing_reminder', centerId: docSnap.id });
        } catch (e) {
          // Non-fatal — Firestore notification already written, matching
          // sendDailyReminders' own established "FCM failure never blocks" rule.
          console.error(`expireCenters: Commerce reminder FCM non-fatal for ${docSnap.id}: ${e.message}`);
        }

        fields.commerceLastReminderStage = reminderStage;
        reminderSent = true;
      }
      // If the notification doc already exists, commerceLastReminderStage
      // must already be set too (both are written together on the prior
      // successful run) — nothing to add to fields here.
    }
  }

  return { fields, statusChanged, reminderSent };
}

/**
 * Syncs `subscriptionStatus` on one provider collection —
 * `pharmacy_providers` or `diagnostic_providers`.
 *
 * These carry the SAME subscription date fields as a medical center but a
 * different account-status field, so they get their own derivation
 * (deriveProviderSubscriptionStatus) that writes subscriptionStatus and
 * nothing else. An admin's suspended/rejected decision is never overwritten by
 * a lapsed invoice.
 *
 * Reads the whole collection rather than filtering server-side: provider
 * collections hold tens to hundreds of documents, and a `!=` filter would
 * silently skip any document missing the field — exactly the stale ones this
 * pass exists to correct.
 *
 * Like the center pass, this is REPORTING/SYNC ONLY. Access enforcement stays
 * date-driven in the client and the rules, so a delayed or failed run cannot
 * grant access to an expired provider.
 */
async function syncProviderCollection(db, collection, now) {
  const snap = await db.collection(collection).get();
  console.log(`expireCenters: ${snap.size} ${collection} candidate(s)`);

  let batch = db.batch();
  let batchCount = 0;
  let updated = 0;
  let skipped = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();

    const lifecycleStatus = data.accountLifecycle?.status;
    if (lifecycleStatus &&
        ['closurePending', 'closed', 'archived'].includes(lifecycleStatus)) {
      skipped++;
      continue;
    }

    const target = deriveProviderSubscriptionStatus(data, now);
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
      `expireCenters: queued ${collection}/${docSnap.id} → ` +
      `subscriptionStatus=${target.subscriptionStatus}`
    );

    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) await batch.commit();

  console.log(
    `expireCenters: ${collection} complete — updated=${updated} skipped=${skipped}`
  );
  return { updated, skipped };
}

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
    let commerceUpdated  = 0;
    let commerceReminded = 0;

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

      // Commerce derivation runs regardless of Healthcare's own date-field
      // presence — a center with no Healthcare trial/subscription dates at
      // all can still have an independent, fully populated Commerce cycle.
      const commerceResult = await computeCommerceUpdate(db, docSnap, data, now);
      if (commerceResult.statusChanged) commerceUpdated++;
      if (commerceResult.reminderSent) commerceReminded++;

      // Log malformed docs that have no Healthcare date fields at all.
      const hasAnyDate = data.trialEnds || data.subscriptionEnd || data.gracePeriodEnds;
      let healthcareFields = null;
      if (!hasAnyDate) {
        console.warn(`expireCenters: MALFORMED — ${docSnap.id} has no Healthcare date fields, skipping Healthcare sync`);
        malformed++;
      } else {
        const target = deriveTargetStatus(data, now);
        if (target) {
          healthcareFields = { ...target, statusSyncedAt: FieldValue.serverTimestamp() };
          updated++;
          console.log(
            `expireCenters: queued ${docSnap.id} → ` +
            `subscriptionStatus=${target.subscriptionStatus} centerStatus=${target.centerStatus}`
          );
        } else {
          skipped++;
        }
      }

      // Exactly one batch.update() call per document — Commerce and
      // Healthcare field updates are merged together, never queued as two
      // separate writes against the same DocumentReference.
      const combinedFields = { ...commerceResult.fields, ...healthcareFields };
      if (Object.keys(combinedFields).length > 0) {
        batch.update(docSnap.ref, combinedFields);
        batchCount++;

        // Flush before hitting the hard 500-op Firestore batch limit.
        if (batchCount >= BATCH_LIMIT) {
          await batch.commit();
          console.log(`expireCenters: committed batch of ${batchCount}`);
          batch      = db.batch();
          batchCount = 0;
        }
      }
    }

    if (batchCount > 0) {
      await batch.commit();
      console.log(`expireCenters: committed final batch of ${batchCount}`);
    }

    // ── Commerce-only pass over ALREADY-locked centers ──────────────────────
    // Healthcare being locked must never freeze Commerce's own, independent
    // subscription tracking — these centers were excluded from the query
    // above specifically because they're locked, not because their Commerce
    // subscription is irrelevant.
    const lockedSnap = await db
      .collection('medical_centers')
      .where('centerStatus', '==', 'locked')
      .get();

    console.log(`expireCenters: ${lockedSnap.size} locked center(s) — Commerce-only pass`);

    let lockedBatch      = db.batch();
    let lockedBatchCount = 0;

    for (const docSnap of lockedSnap.docs) {
      const data = docSnap.data();
      const lifecycleStatus = data.accountLifecycle?.status;
      if (lifecycleStatus && ['closurePending', 'closed', 'archived'].includes(lifecycleStatus)) {
        continue;
      }

      const commerceResult = await computeCommerceUpdate(db, docSnap, data, now);
      if (commerceResult.statusChanged) commerceUpdated++;
      if (commerceResult.reminderSent) commerceReminded++;

      if (Object.keys(commerceResult.fields).length > 0) {
        lockedBatch.update(docSnap.ref, commerceResult.fields);
        lockedBatchCount++;

        if (lockedBatchCount >= BATCH_LIMIT) {
          await lockedBatch.commit();
          lockedBatch      = db.batch();
          lockedBatchCount = 0;
        }
      }
    }

    if (lockedBatchCount > 0) {
      await lockedBatch.commit();
    }

    // ── Provider collections ────────────────────────────────────────────────
    // Pharmacies and labs keep their subscription on their OWN document, so
    // the center pass above never touched them: a lapsed provider kept
    // subscriptionStatus:'active' indefinitely. Access was unaffected (client
    // and rules are date-driven), but every status-based query and admin list
    // counted them as active.
    const pharmacyResult =
      await syncProviderCollection(db, 'pharmacy_providers', now);
    const labResult =
      await syncProviderCollection(db, 'diagnostic_providers', now);

    console.log(
      `expireCenters: complete — updated=${updated} skipped=${skipped} malformed=${malformed} ` +
      `commerceUpdated=${commerceUpdated} commerceReminded=${commerceReminded} ` +
      `pharmacyUpdated=${pharmacyResult.updated} labUpdated=${labResult.updated}`
    );
  }
);
