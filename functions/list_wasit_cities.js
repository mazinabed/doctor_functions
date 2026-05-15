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

async function listWasitCities() {
  const snapshot = await db
    .collection("google_doctors")
    .where("province_key", "==", "wasit")
    .get();

  if (snapshot.empty) {
    console.log("❌ No documents found for Wasit");
    return;
  }

  const cities = new Set();

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    if (data.city_lower) {
      cities.add(data.city_lower);
    }
  });

  console.log("✅ Cities found in Wasit:");
  [...cities].sort().forEach(c => console.log(" -", c));

  console.log(`\nTotal docs in Wasit: ${snapshot.size}`);
}

listWasitCities();
