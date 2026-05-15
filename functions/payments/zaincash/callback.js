const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { mapZainStatus } = require("./utils");

// ✅ REQUIRED for Firestore to work reliably in Gen2
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

exports.zaincashCallback = functions.https.onRequest(async (req, res) => {
  // ✅ Move config access inside handler
  process.env.ZAINCASH_SECRET = functions.config().zaincash.secret;

  try {
    const payload = req.method === "GET" ? req.query : req.body;
    const orderId = String(payload.orderId || "");

    if (!orderId) return res.status(400).send("Missing orderId");

    const ref = db.collection("payments").doc(orderId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("Unknown orderId");

      const payment = snap.data();

      // ✅ Idempotency: do nothing if already finalized
      if (payment.finalizedAt) return;

      const status = mapZainStatus(payload);

      tx.update(ref, {
        status,
        providerRaw: payload,
        finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (status === "paid") {
        const subRef = db
          .collection("doctors")
          .doc(payment.uid)
          .collection("subscriptions")
          .doc(`sub_${Date.now()}`);

        tx.set(subRef, {
          status: "active",
          planCode: payment.planCode,
          amountIQD: payment.amountIQD,
          provider: "zaincash",
          orderId,
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    return res.status(200).send("OK");
  } catch (err) {
    functions.logger.error("zaincashCallback error", err);
    return res.status(500).send("ERROR");
  }
});
