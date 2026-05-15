"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

exports.zaincashCallback = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    try {
      const token = req.query.token;

      if (!token) {
        res.status(400).send("Missing token");
        return;
      }

      // 🔐 Decode token from ZainCash
      const secret = process.env.ZAINCASH_SECRET;
      const decoded = jwt.verify(token, secret);

      /*
        decoded = {
          status: "success" | "failed" | "pending",
          orderid: "zc_xxx",
          id: "zaincash_transaction_id",
          msg?: "reason"
        }
      */

      const orderId = decoded.orderid;
      const status = decoded.status;

      console.log("📥 ZainCash decoded:", decoded);

      const paymentRef = db.collection("payments").doc(orderId);
      const snap = await paymentRef.get();

      if (!snap.exists) {
        res.status(404).send("Payment not found");
        return;
      }

      const payment = snap.data();

      if (status !== "success") {
        await paymentRef.update({
          status: "failed",
          providerStatus: status,
          providerMessage: decoded.msg || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.redirect("https://doctor.trustydr.com/payment-failed");
        return;
      }

      // ✅ MARK PAYMENT PAID
      await paymentRef.update({
        status: "paid",
        providerPaymentId: decoded.id,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ✅ ACTIVATE DOCTOR
      await db.collection("doctors").doc(payment.uid).update({
        isPaidUser: true,
        subscriptionStatus: "active",
        subscriptionPlan: payment.planCode,
        nextBillingDate: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ✅ REDIRECT USER
      res.redirect("https://doctor.trustydr.com/payment-success");
    } catch (err) {
      console.error("🔥 zaincashCallback error", err);
      res.status(500).send("Internal Server Error");
    }
  }
);
