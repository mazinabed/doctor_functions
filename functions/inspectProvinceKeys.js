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

async function inspectProvinceKeys() {
  const snap = await db.collection("google_doctors").limit(50).get();

  if (snap.empty) {
    console.log("❌ google_doctors is empty");
    return;
  }

  const set = new Set();

  snap.docs.forEach(d => {
    const v = d.data().province_key;
    set.add(v === undefined ? "❌ MISSING" : `"${v}"`);
  });

  console.log("province_key values found:");
  console.log([...set]);
}

inspectProvinceKeys();
