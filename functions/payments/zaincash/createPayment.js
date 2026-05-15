"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/* ===================== CONSTANTS ===================== */
const PLAN_AMOUNT_IQD = {
  "1m": 30000,
  "6m": 132000,
  "12m": 240000,
};

/* ===================== ENV HELPER ===================== */
function mustEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}


/* ===================== ZAINCASH JWT ===================== */
function createZainCashToken({
  merchantId,
  merchantMsisdn,
  amount,
  orderId,
  redirectUrl,
  secret,
}) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    merchantId,
    amount,
    serviceType: "Doctor Subscription",
    msisdn: merchantMsisdn,
    orderId,
    redirectUrl,
    iat: now,
    exp: now + 60 * 10, // 10 minutes
  };

  return jwt.sign(payload, secret, {
    algorithm: "HS256",
  });
}



exports.createZainCashPayment = onCall(
    {
    region: "us-central1",
    secrets: [
      "ZAINCASH_SECRET",
      "ZAINCASH_MERCHANT_ID",
      "ZAINCASH_MSISDN",
      "ZAINCASH_CREATE_URL",
      "ZAINCASH_RETURN_URL",
    ],
  },
  async (request) => {
    try {
      // 🔐 AUTH (GEN-2)
      if (!request.auth) {
        throw new HttpsError(
          "unauthenticated",
          "You must be logged in."
        );
      }

      const uid = request.auth.uid;
      const planCode = (request.data?.planCode || "").toString().trim();

      console.log("✅ AUTH UID:", uid);

      if (!PLAN_AMOUNT_IQD[planCode]) {
        throw new HttpsError(
          "invalid-argument",
          "Invalid planCode"
        );
      }

      // 🔐 ENV (GEN-2 SAFE)
      const ZAINCASH_SECRET = mustEnv("ZAINCASH_SECRET");
      const ZAINCASH_MERCHANT_ID = mustEnv("ZAINCASH_MERCHANT_ID");
      const ZAINCASH_MSISDN = mustEnv("ZAINCASH_MSISDN");
      const ZAINCASH_CREATE_URL = mustEnv("ZAINCASH_CREATE_URL");
      const ZAINCASH_RETURN_URL = mustEnv("ZAINCASH_RETURN_URL");

      const amountIQD = PLAN_AMOUNT_IQD[planCode];
      const orderId = `zc_${uid}_${planCode}_${Date.now()}`;

      // 1️⃣ Create payment record
      await db.collection("payments").doc(orderId).set({
        orderId,
        uid,
        planCode,
        amountIQD,
        currency: "IQD",
        provider: "zaincash",
        env: "sandbox",
        status: "created",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2️⃣ JWT
      const token = createZainCashToken({
        merchantId: ZAINCASH_MERCHANT_ID,
        merchantMsisdn: ZAINCASH_MSISDN,
        amount: amountIQD,
        orderId,
        redirectUrl: ZAINCASH_RETURN_URL,
        secret: ZAINCASH_SECRET,
      });

      // 3️⃣ ZainCash INIT
      const params = new URLSearchParams();
      params.append("token", token);
      params.append("merchantId", ZAINCASH_MERCHANT_ID);
      params.append("lang", "en");

      const response = await fetch(ZAINCASH_CREATE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      const rawText = await response.text();
      let z;

      try {
        z = JSON.parse(rawText);
      } catch {
        z = { parseError: true, rawText };
      }

      console.error("ZAINCASH_INIT_RESPONSE", {
        status: response.status,
        body: z,
      });

      if (!response.ok || !z?.id) {
        await db.collection("payments").doc(orderId).update({
          status: "failed",
          providerHttpStatus: response.status,
          providerRaw: z,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        throw new HttpsError("internal", "ZainCash init failed");
      }

      // 4️⃣ Redirected
      await db.collection("payments").doc(orderId).update({
        status: "redirected",
        providerPaymentId: z.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 5️⃣ RETURN
      return {
        orderId,
        redirectUrl: `https://test.zaincash.iq/transaction/pay?id=${z.id}`,
      };
    } catch (err) {
      console.error("🔥 createZainCashPayment FAILED", err);

      if (err instanceof HttpsError) throw err;

      throw new HttpsError(
        "internal",
        err?.message || "Unknown error"
      );
    }
  }
);
