// TrustyDr Commerce Bridge — Standalone Subscription Billing (Admin Review).
//
// mydoctor_admin -> Healthcare -> Commerce, the exact same direction and
// trust boundary as adminMarketplaceCategories.js (see that file's own
// header for the full reasoning): admin identity is verified here, against
// users/{uid}.role == "admin" in THIS project's own Firestore (the one
// canonical "admin" definition this ecosystem actually enforces —
// firestore.rules' isAdmin()), and every call to Commerce mints a real
// Google-signed OIDC identity token scoped to the target URL as audience.
// Commerce's endpoints are IAM-invoker-restricted to this project's own
// runtime service account (see Commerce's standaloneBillingAdmin.ts /
// HEALTHCARE_SERVICE_ACCOUNT_EMAIL) — a plain unauthenticated fetch,
// including one from a merchant's own authenticated session, is rejected
// by Cloud Run itself before Commerce's code ever runs. `actorUid` in the
// body is only ever an audit-trail label on the Commerce side, never the
// security boundary — THIS requireAdmin() call is the real gate.
//
// Security context: this relay exists specifically to close the gap found
// in Commerce's original recordStandaloneSubscriptionPayment (owner-
// callable, so any merchant could grant themselves free access) — approval/
// rejection must be reachable ONLY through this admin-verified path.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { GoogleAuth } = require("google-auth-library");
const fetch = require("node-fetch");

const COMMERCE_BASE_URL = "https://us-central1-trustydr-commerce.cloudfunctions.net";

const googleAuth = new GoogleAuth();
const idTokenClientsByUrl = new Map();

async function getAuthHeaders(targetUrl) {
  let client = idTokenClientsByUrl.get(targetUrl);
  if (!client) {
    client = await googleAuth.getIdTokenClient(targetUrl);
    idTokenClientsByUrl.set(targetUrl, client);
  }
  const headers = await client.getRequestHeaders(targetUrl);
  return { ...headers, "Content-Type": "application/json" };
}

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }
  const userSnap = await getFirestore().collection("users").doc(request.auth.uid).get();
  if (userSnap.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

async function callCommerce(endpoint, body) {
  const targetUrl = `${COMMERCE_BASE_URL}/${endpoint}`;
  let response;
  try {
    const headers = await getAuthHeaders(targetUrl);
    response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[adminStandaloneSubscriptionPayments] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminStandaloneSubscriptionPayments] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    throw new HttpsError("invalid-argument", data?.error || "Request rejected by Commerce.");
  }
  return data;
}

exports.adminListStandaloneSubscriptionPayments = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listPendingStandaloneSubscriptionPaymentsForHealthcare", {});
});

exports.adminApproveStandaloneSubscriptionPayment = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.orgId || typeof data.orgId !== "string" || !data.paymentId || typeof data.paymentId !== "string") {
    throw new HttpsError("invalid-argument", "orgId and paymentId are required.");
  }
  return callCommerce("approveStandaloneSubscriptionPaymentForHealthcare", {
    actorUid: request.auth.uid,
    orgId: data.orgId,
    paymentId: data.paymentId,
  });
});

exports.adminRejectStandaloneSubscriptionPayment = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  if (!data.orgId || typeof data.orgId !== "string" || !data.paymentId || typeof data.paymentId !== "string") {
    throw new HttpsError("invalid-argument", "orgId and paymentId are required.");
  }
  return callCommerce("rejectStandaloneSubscriptionPaymentForHealthcare", {
    actorUid: request.auth.uid,
    orgId: data.orgId,
    paymentId: data.paymentId,
    rejectionReason: typeof data.rejectionReason === "string" ? data.rejectionReason : undefined,
  });
});
