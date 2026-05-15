/**
 * CLEANUP SCRIPT – Remove duplicate Google doctors
 * Run with:
 *    node cleanup_google_doctors.js
 */

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function cleanupGoogleDoctors() {
  console.log("🚀 Starting cleanup of Google imported doctors...");

  const snap = await db
    .collection("doctors")
    .where("sourceType", "==", "google_places")
    .get();

  console.log(`📌 Found ${snap.size} Google doctors.`);

  const groups = {};

  snap.forEach((doc) => {
    const data = doc.data();
    const placeId =
      data.sourceIds?.googlePlaceId ||
      data.googlePlaceId ||
      "UNKNOWN";

    if (!groups[placeId]) groups[placeId] = [];
    groups[placeId].push({ id: doc.id, data });
  });

  let deletions = 0;
  let survivors = 0;

  for (const placeId of Object.keys(groups)) {
    const docs = groups[placeId];

    if (docs.length === 1) {
      survivors++;
      continue;
    }

    console.log(
      `⚠️ Duplicate found for googlePlaceId=${placeId} (count=${docs.length})`
    );

    docs.sort((a, b) => {
      const tA = new Date(a.data.updatedAt || "2000").getTime();
      const tB = new Date(b.data.updatedAt || "2000").getTime();
      return tB - tA;
    });

    const keep = docs[0];
    const remove = docs.slice(1);

    for (const r of remove) {
      await db.collection("doctors").doc(r.id).delete();
      deletions++;
      console.log(`🗑️ Deleted duplicate: ${r.id}`);
    }

    survivors++;
  }

  console.log("-------------------------------------------------");
  console.log(`🟢 Cleanup complete`);
  console.log(`✔ Unique clinics kept: ${survivors}`);
  console.log(`🗑️ Duplicates removed: ${deletions}`);
  console.log("-------------------------------------------------");

  process.exit(0);
}

cleanupGoogleDoctors().catch((err) => {
  console.error("❌ Cleanup failed:", err);
  process.exit(1);
});
