"use strict";

const admin = require("firebase-admin");
const { isPublicEligible, buildPublicDoc } = require("./lib/publicDoctorSanitizer");

admin.initializeApp({ projectId: "doctorapp-7e8b3" });
const db = admin.firestore();

async function backfill() {
  console.log("=== public_doctors backfill starting ===\n");

  const snap = await db.collection("doctors").get();
  console.log(`Found ${snap.size} doctor documents.\n`);

  let synced = 0, removed = 0, skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const doctorId = doc.id;
    const publicRef = db.collection("public_doctors").doc(doctorId);

    if (!isPublicEligible(data)) {
      const existing = await publicRef.get();
      if (existing.exists) {
        await publicRef.delete();
        console.log(`REMOVED  ${doctorId}  status=${data.status || "none"}  isVerified=${data.isVerified || false}`);
        removed++;
      } else {
        console.log(`SKIP     ${doctorId}  status=${data.status || "none"}  isVerified=${data.isVerified || false}`);
        skipped++;
      }
      continue;
    }

    const existing = await publicRef.get();
    const publicDoc = buildPublicDoc(doctorId, data, existing.exists ? existing.data() : null);
    await publicRef.set(publicDoc);
    console.log(`SYNCED   ${doctorId}  name=${data.name_en || data.name || "(no name)"}`);
    synced++;
  }

  console.log(`\n=== Done ===`);
  console.log(`Synced:  ${synced}`);
  console.log(`Removed: ${removed}`);
  console.log(`Skipped: ${skipped}`);
  process.exit(0);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
