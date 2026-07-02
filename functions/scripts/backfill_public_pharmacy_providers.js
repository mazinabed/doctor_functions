'use strict';

/**
 * Re-syncs all eligible pharmacy providers to public_pharmacy_providers.
 *
 * Eligibility gate (mirrors isPharmacyPublicEligible):
 *   status === 'active' && isVerified === true
 *
 * For each pharmacy_providers doc:
 *   - eligible   → upsert public_pharmacy_providers/{id}
 *   - ineligible → delete public_pharmacy_providers/{id} if it exists
 *
 * Usage (from the functions/ directory):
 *
 *   # Preview — show what would be written, no Firestore writes
 *   node scripts/backfill_public_pharmacy_providers.js --dry-run
 *
 *   # Live run — writes to public_pharmacy_providers
 *   node scripts/backfill_public_pharmacy_providers.js
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account key
 *     with Firestore read/write access, OR run from a machine already
 *     authenticated via `gcloud auth application-default login`.
 *   - Node 18+
 */

const admin = require("firebase-admin");
const {
  isPharmacyPublicEligible,
  buildPublicPharmacyDoc,
} = require("../lib/publicPharmacyProviderSanitizer");

const DRY_RUN = process.argv.includes("--dry-run");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

async function run() {
  console.log(
    `\n=== backfill_public_pharmacy_providers ${DRY_RUN ? "[DRY RUN]" : "[LIVE]"} ===\n`
  );

  const snap = await db.collection("pharmacy_providers").get();
  console.log(`Found ${snap.size} pharmacy_providers docs.\n`);

  let synced = 0;
  let removed = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const pharmacyId = doc.id;
    const data = doc.data();
    const publicRef = db
      .collection("public_pharmacy_providers")
      .doc(pharmacyId);

    if (!isPharmacyPublicEligible(data)) {
      const existing = await publicRef.get();
      if (existing.exists) {
        console.log(
          `  REMOVE  ${pharmacyId} — ineligible (status=${data.status}, isVerified=${data.isVerified})`
        );
        if (!DRY_RUN) await publicRef.delete();
        removed++;
      } else {
        console.log(
          `  SKIP    ${pharmacyId} — ineligible (status=${data.status}, isVerified=${data.isVerified}), no public doc`
        );
        skipped++;
      }
      continue;
    }

    const existing = await publicRef.get();
    const publicDoc = buildPublicPharmacyDoc(
      pharmacyId,
      data,
      existing.exists ? existing.data() : null
    );

    const name = publicDoc.facilityName_en || publicDoc.facilityName_ar || pharmacyId;
    console.log(
      `  SYNC    ${pharmacyId} — "${name}" city=${publicDoc.city_en || "?"} centerId=${publicDoc.centerId || "null"}`
    );
    if (!DRY_RUN) await publicRef.set(publicDoc);
    synced++;
  }

  console.log(`\n--- Done ---`);
  console.log(`  synced:  ${synced}`);
  console.log(`  removed: ${removed}`);
  console.log(`  skipped: ${skipped}`);
  if (DRY_RUN) console.log(`\n  [DRY RUN] No writes were made.`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
