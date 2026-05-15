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

// very conservative city detection
function detectCity(address) {
  const a = address.toLowerCase();
  if (a.includes("kut")) return "kut";
  if (a.includes("numaniyah")) return "numaniyah";
  if (a.includes("nu'maniyah")) return "numaniyah";
  if (a.includes("hayy")) return "hayy";
  if (a.includes("aziziyah")) return "aziziyah";
  return null;
}

async function normalizeWasit() {
  const snap = await db.collection("google_doctors").get();

  let fixed = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    const address = d.address?.toLowerCase() ?? "";

    if (!address.includes("wasit")) continue;
    if (!address.includes("iraq")) continue;

    const city = detectCity(address);
    if (!city) continue; // do NOT guess

    await doc.ref.update({
      country_key: "IQ",
      province_key: "wasit",
      city_lower: city,
    });

    fixed++;
  }

  console.log(`✅ Normalized ${fixed} Wasit clinics`);
}

normalizeWasit();
