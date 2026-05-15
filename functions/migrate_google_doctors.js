/**
 * One-time migration for google_doctors
 * - Adds province_key
 * - Keeps provinceKey (backward compatible)
 * - Normalizes city_lower
 */



// Use default credentials (works with Firebase CLI / Cloud Shell)
const admin = require('firebase-admin');
const path = require('path');

admin.initializeApp({
  credential: admin.credential.cert(
    require(
      path.join(
        __dirname,
        'doctorapp-7e8b3-firebase-adminsdk-fbsvc-32f7844f03.json'
      )
    )
  ),
});

const db = admin.firestore();

async function migrateGoogleDoctors() {
  const snapshot = await db.collection('google_doctors').get();

  let batch = db.batch();
  let ops = 0;
  let migrated = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    const updates = {};

    // 🔹 province_key (copy once)
    if (!data.province_key && data.provinceKey) {
      updates.province_key = data.provinceKey;
    }

    // 🔹 city_lower normalization
    if (!data.city_lower) {
      const city =
        data.city_en ||
        data.cityEn ||
        data.city ||
        '';

      if (city) {
        updates.city_lower = city.toLowerCase().trim();
      }
    }

    if (Object.keys(updates).length === 0) {
      continue; // nothing to update
    }

    batch.update(doc.ref, updates);
    ops++;
    migrated++;

    // 🔥 Firestore batch limit = 500
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log(`✅ Migration complete. Updated ${migrated} documents.`);
}

migrateGoogleDoctors()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  });
