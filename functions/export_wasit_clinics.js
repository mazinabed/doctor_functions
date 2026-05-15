const admin = require("firebase-admin");
const fs = require("fs");

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

async function exportWasitClinics() {
  const snapshot = await db
    .collection("google_doctors")
    .where("province_key", "==", "wasit")
    .get();

  if (snapshot.empty) {
    console.log("❌ No Wasit clinics found");
    return;
  }

  const data = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  fs.writeFileSync(
    "wasit_google_clinics.json",
    JSON.stringify(data, null, 2)
  );

  console.log(`✅ Exported ${data.length} Wasit clinics`);
}

exportWasitClinics();
