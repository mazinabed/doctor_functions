const admin = require("firebase-admin");
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

const cutoff = "2026-01-01T00:00:00.000Z";

async function deleteOldGoogleDoctors() {
  const snapshot = await db
    .collection("google_doctors")
    .where("createdAt", "<", cutoff)
    .get();

  if (snapshot.empty) {
    console.log("No documents to delete.");
    return;
  }

  let batch = db.batch();
  let count = 0;

  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
    count++;

    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
      console.log(`Deleted ${count} docs...`);
    }
  }

  if (count % 400 !== 0) {
    await batch.commit();
  }

  console.log(`✅ DONE. Total deleted: ${count}`);
}

deleteOldGoogleDoctors();
