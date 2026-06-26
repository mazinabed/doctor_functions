'use strict';

/**
 * Re-syncs all eligible diagnostic providers to public_diagnostic_providers.
 *
 * Also resolves missing centerId values by querying each provider's published
 * schedules. When a centerId is found in schedules but absent from the private
 * doc, it is written back to diagnostic_providers (mirroring what the
 * syncPublicDiagnosticProvider Cloud Function trigger now does automatically).
 *
 * Usage (from the functions/ directory):
 *
 *   # Preview — show what would be written, no Firestore writes
 *   node scripts/backfill_public_diagnostic_providers.js --dry-run
 *
 *   # Live run — writes to diagnostic_providers and public_diagnostic_providers
 *   node scripts/backfill_public_diagnostic_providers.js
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account key
 *     with Firestore read/write access, OR run from a machine already
 *     authenticated via `gcloud auth application-default login`.
 *   - Node 18+
 */

const admin = require("firebase-admin");
const { isProviderPublicEligible, buildPublicProviderDoc } = require("../lib/publicDiagnosticProviderSanitizer");

const DRY_RUN = process.argv.includes("--dry-run");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/**
 * Looks up the centerId for a provider by querying their published schedules.
 * Lab schedules store doctorId = providerId and centerId = medical_centers ID.
 * Returns null if no published schedule is found.
 */
async function resolveScheduleCenterId(providerId) {
  const snap = await db.collection("schedules")
    .where("doctorId", "==", providerId)
    .where("status", "==", "published")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const centerId = snap.docs[0].data().centerId;
  return (typeof centerId === "string" && centerId.trim()) ? centerId.trim() : null;
}

async function run() {
  console.log(`\n=== backfill_public_diagnostic_providers ${DRY_RUN ? "[DRY RUN]" : "[LIVE]"} ===\n`);

  const snap = await db.collection("diagnostic_providers").get();
  console.log(`Found ${snap.size} diagnostic_providers docs.\n`);

  let synced = 0;
  let removed = 0;
  let skipped = 0;
  let centerIdWritten = 0;

  for (const doc of snap.docs) {
    const providerId = doc.id;
    let data = doc.data();
    const publicRef = db.collection("public_diagnostic_providers").doc(providerId);

    if (!isProviderPublicEligible(data)) {
      const existing = await publicRef.get();
      if (existing.exists) {
        console.log(`  REMOVE  ${providerId} — ineligible (status=${data.status}, isActive=${data.isActive}, isVerified=${data.isVerified})`);
        if (!DRY_RUN) await publicRef.delete();
        removed++;
      } else {
        console.log(`  SKIP    ${providerId} — ineligible, no public doc`);
        skipped++;
      }
      continue;
    }

    // Resolve centerId: private doc first, then published schedules.
    let resolvedCenterId = (typeof data.centerId === "string" && data.centerId.trim())
      ? data.centerId.trim()
      : null;

    if (!resolvedCenterId) {
      const schedCenterId = await resolveScheduleCenterId(providerId);
      if (schedCenterId) {
        resolvedCenterId = schedCenterId;
        console.log(`  CENTERID ${providerId} — resolved from schedule: ${resolvedCenterId}`);
        if (!DRY_RUN) {
          await db.collection("diagnostic_providers").doc(providerId).update({
            centerId: resolvedCenterId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          // Refresh data so buildPublicProviderDoc sees the updated centerId.
          data = { ...data, centerId: resolvedCenterId };
          centerIdWritten++;
        }
      } else {
        console.log(`  WARN     ${providerId} — no published schedule found; centerId will fall back to userId/providerId`);
      }
    }

    const existing = await publicRef.get();
    const publicDoc = buildPublicProviderDoc(
      providerId,
      data,
      existing.exists ? existing.data() : null,
      resolvedCenterId
    );

    const centerIdNote = publicDoc.centerId === providerId
      ? " ⚠️  centerId == providerId (no schedule found)"
      : "";
    console.log(`  SYNC     ${providerId} [${data.serviceGroup || "?"}] centerId=${publicDoc.centerId}${centerIdNote}`);
    if (!DRY_RUN) await publicRef.set(publicDoc);
    synced++;
  }

  console.log(`\n--- Done ---`);
  console.log(`  synced:          ${synced}`);
  console.log(`  centerId written: ${centerIdWritten}`);
  console.log(`  removed:         ${removed}`);
  console.log(`  skipped:         ${skipped}`);
  if (DRY_RUN) console.log(`\n  [DRY RUN] No writes were made.`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
