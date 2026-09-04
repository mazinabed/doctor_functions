"use strict";

/**
 * Creates the operational-status mirror for every EXISTING pharmacy and
 * laboratory provider.
 *
 *   pharmacy_providers/{pharmacyId}/operational/status
 *   diagnostic_providers/{labId}/operational/status
 *
 * ─── WHY THIS IS MANDATORY, NOT OPTIONAL ─────────────────────────────────────
 *
 * syncPharmacyOperationalStatus / syncLabOperationalStatus only fire on a WRITE
 * to the parent document. An organization that is simply operating — nobody
 * editing its profile, no payment approved this month — never triggers them, so
 * without this script every provider that existed before the deploy would have
 * no mirror at all.
 *
 * SubscriptionAccessRules.fromDocument treats a missing document as `locked`,
 * deliberately and unchanged: an organization whose record cannot be read has
 * not demonstrated a paid subscription. That is the right default, and it is
 * also exactly why this script must run BEFORE the portal build that starts
 * reading the mirror — otherwise every existing pharmacy and lab staff member
 * would be redirected to billing on their next load.
 *
 * Deployment order is therefore: rules -> functions -> THIS SCRIPT -> portal.
 *
 * ─── PROPERTIES ──────────────────────────────────────────────────────────────
 *
 * Deterministic: the payload comes from the same pure buildOperationalStatus()
 * the trigger uses, so a backfilled mirror and a trigger-written mirror are
 * byte-identical for the same parent.
 *
 * Idempotent: re-running overwrites with the same projection. Safe to run
 * repeatedly, and safe to re-run after the triggers are live.
 *
 * Unconditional: unlike the public-projection backfills, this does NOT skip
 * ineligible providers. A suspended or lapsed organization needs its mirror
 * most of all — that is the state the access gate has to be able to observe.
 *
 * Usage (from the functions/ directory):
 *
 *   # Preview — show what would be written, no Firestore writes
 *   node scripts/backfill_provider_operational_status.js --dry-run
 *
 *   # Live run
 *   node scripts/backfill_provider_operational_status.js
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with
 *     Firestore read/write, OR `gcloud auth application-default login`.
 *   - Node 18+
 */

const admin = require("firebase-admin");
const {
  OPERATIONAL_COLLECTION,
  OPERATIONAL_DOC_ID,
  buildOperationalStatus,
} = require("../lib/operationalStatusMirror");

const DRY_RUN = process.argv.includes("--dry-run");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const COLLECTIONS = ["pharmacy_providers", "diagnostic_providers"];

function describe(payload) {
  const at = (v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString().slice(0, 10) : "—");
  return (
    `status=${payload.status || "—"} ` +
    `subscriptionStatus=${payload.subscriptionStatus || "—"} ` +
    `trialEnds=${at(payload.trialEnds)} ` +
    `subscriptionEnd=${at(payload.subscriptionEnd)} ` +
    `grace=${at(payload.gracePeriodEnds)}`
  );
}

async function backfillCollection(collectionName) {
  const snap = await db.collection(collectionName).get();
  console.log(`\n${collectionName}: ${snap.size} provider doc(s).`);

  let written = 0;

  for (const providerDoc of snap.docs) {
    const providerId = providerDoc.id;
    const payload = buildOperationalStatus(providerDoc.data());

    console.log(`  WRITE   ${collectionName}/${providerId} — ${describe(payload)}`);

    if (!DRY_RUN) {
      payload.syncedAt = admin.firestore.FieldValue.serverTimestamp();
      await db
        .collection(collectionName)
        .doc(providerId)
        .collection(OPERATIONAL_COLLECTION)
        .doc(OPERATIONAL_DOC_ID)
        .set(payload);
    }
    written++;
  }

  return written;
}

async function run() {
  console.log(
    `\n=== backfill_provider_operational_status ${DRY_RUN ? "[DRY RUN]" : "[LIVE]"} ===`
  );

  let total = 0;
  for (const collectionName of COLLECTIONS) {
    total += await backfillCollection(collectionName);
  }

  console.log(`\n--- Done ---`);
  console.log(`  mirrors written: ${total}`);
  if (DRY_RUN) console.log(`\n  [DRY RUN] No writes were made.`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
