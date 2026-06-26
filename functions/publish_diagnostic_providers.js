"use strict";

// ─── Backfill: diagnostic_providers → public_diagnostic_providers ─────────────
//
// Usage (from doctor_functions/functions/):
//   node publish_diagnostic_providers.js
//
// Safe to run multiple times (idempotent). Eligible providers are upserted;
// ineligible providers are removed from the public collection if present.
// Run this once after deploying rules + indexes to populate initial public docs.

const admin = require("firebase-admin");

const {
  isProviderPublicEligible,
  buildPublicProviderDoc,
} = require("./lib/publicDiagnosticProviderSanitizer");

// Uses Application Default Credentials — same pattern as backfill_public_doctors.js.
// If you see SSL errors locally, run with:
//   set NODE_TLS_REJECT_UNAUTHORIZED=0 && node publish_diagnostic_providers.js   (Windows)
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node publish_diagnostic_providers.js           (macOS/Linux)
admin.initializeApp({ projectId: "doctorapp-7e8b3" });

const db = admin.firestore();

async function main() {
  console.log("Starting diagnostic_providers → public_diagnostic_providers backfill...");

  const snap = await db.collection("diagnostic_providers").get();
  console.log(`Found ${snap.size} diagnostic_providers to process.`);

  let published = 0;
  let removed = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    const providerId = doc.id;
    const data = doc.data();
    const publicRef = db.collection("public_diagnostic_providers").doc(providerId);

    try {
      if (!isProviderPublicEligible(data)) {
        const existing = await publicRef.get();
        if (existing.exists) {
          await publicRef.delete();
          removed++;
          console.log(
            `  removed:  ${providerId} ` +
            `(status=${data.status}, isActive=${data.isActive}, isVerified=${data.isVerified})`
          );
        } else {
          skipped++;
          console.log(
            `  skipped:  ${providerId} — ineligible, not in public collection ` +
            `(status=${data.status})`
          );
        }
        continue;
      }

      const existing = await publicRef.get();
      const publicDoc = buildPublicProviderDoc(
        providerId,
        data,
        existing.exists ? existing.data() : null
      );
      await publicRef.set(publicDoc);
      published++;
      console.log(
        `  published: ${providerId} ` +
        `"${data.facilityName_en || "(no name)"}" [${data.serviceGroup || data.providerKind}]`
      );
    } catch (err) {
      errors++;
      console.error(`  ERROR: ${providerId} — ${err.message}`);
    }
  }

  console.log(
    `\nBackfill complete. ` +
    `published=${published}  removed=${removed}  skipped=${skipped}  errors=${errors}`
  );
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
