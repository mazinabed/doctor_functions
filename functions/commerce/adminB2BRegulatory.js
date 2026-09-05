// TrustyDr Commerce Bridge — B2B Seller Regulatory Applications (Admin Control).
//
// mydoctor_admin -> Healthcare -> Commerce, the exact same direction and
// trust boundary as adminSponsoredPlacements.js (see that file's own
// header for the full reasoning): admin identity is verified here, against
// users/{uid}.role == "admin" in THIS project's own Firestore (the one
// canonical "admin" definition this ecosystem actually enforces —
// firestore.rules' isAdmin()), and every call to Commerce mints a real
// Google-signed OIDC identity token scoped to the target URL as audience.
// Commerce's endpoints are IAM-invoker-restricted to this project's own
// runtime service account (see Commerce's sellerRegulatoryApplications.ts /
// HEALTHCARE_SERVICE_ACCOUNT_EMAIL) — a plain unauthenticated fetch,
// including one from a merchant's own authenticated session, is rejected
// by Cloud Run itself before Commerce's code ever runs. `actorUid` in the
// body is only ever an audit-trail label on the Commerce side, never the
// security boundary — THIS requireAdmin() call is the real gate.
//
// Security context: Healthcare Wholesale Marketplace — Regulatory/
// Entitlement Foundation (Phase 4B.1, 2026-08-16 onward). A merchant can
// never self-declare that it wholesales medicine — sellerRegulatoryScopes
// (e.g. "pharmaceutical_wholesale") is granted EXCLUSIVELY through this
// admin-verified path, never by the merchant's own account, matching
// exactly the correction already applied to sponsoredChannels.
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

// Same status-to-HttpsError mapping as adminSponsoredPlacements.js's own
// httpsErrorCodeForStatus, plus 422 for Commerce's
// "documents_incomplete" precondition.
function httpsErrorCodeForStatus(status) {
  if (status === 400) return "invalid-argument";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission-denied";
  if (status === 404) return "not-found";
  if (status === 409 || status === 422) return "failed-precondition";
  if (status >= 500) return "internal";
  return "invalid-argument";
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
    console.error(`[adminB2BRegulatory] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminB2BRegulatory] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    console.error(
      `[adminB2BRegulatory] ${endpoint} returned ${response.status}:`,
      JSON.stringify(data),
    );
    const code = httpsErrorCodeForStatus(response.status);
    const message =
      code === "internal"
        ? "Commerce Bridge reported an internal error. Check Commerce Cloud Function logs for details."
        : data?.message || data?.error || "Request rejected by Commerce.";
    throw new HttpsError(code, message);
  }
  return data;
}

// The admin review queue — every seller regulatory application currently
// awaiting a decision, enriched with human-readable business names
// (Commerce-side, see listPendingSellerRegulatoryApplicationsForHealthcare).
exports.adminListSellerRegulatoryApplications = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listPendingSellerRegulatoryApplicationsForHealthcare", {
    actorUid: request.auth.uid,
  });
});

// Mints a short-lived signed URL for ONE required document on an
// application, for secure admin review — never a public/permanent link.
exports.adminGetSellerRegulatoryDocument = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { applicationId, docType } = request.data || {};
  if (!applicationId || typeof applicationId !== "string" || !docType || typeof docType !== "string") {
    throw new HttpsError("invalid-argument", "applicationId and docType are required.");
  }
  return callCommerce("getSellerRegulatoryDocumentForHealthcare", {
    actorUid: request.auth.uid,
    applicationId,
    docType,
  });
});

// Approval — the ONE place organizations/{orgId}.sellerRegulatoryScopes is
// ever granted. Commerce independently re-verifies the required document
// set is complete (hasAllRequiredDocuments) before granting anything —
// this relay never trusts the admin UI's own completeness display as the
// real gate.
exports.adminApproveSellerRegulatoryApplication = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, applicationId } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !applicationId || typeof applicationId !== "string") {
    throw new HttpsError("invalid-argument", "orgId and applicationId are required.");
  }
  return callCommerce("approveSellerRegulatoryApplicationForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    applicationId,
  });
});

exports.adminRejectSellerRegulatoryApplication = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, applicationId, rejectionReason } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !applicationId || typeof applicationId !== "string") {
    throw new HttpsError("invalid-argument", "orgId and applicationId are required.");
  }
  return callCommerce("rejectSellerRegulatoryApplicationForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    applicationId,
    rejectionReason: typeof rejectionReason === "string" ? rejectionReason : undefined,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Merchant Verification (2026-09) — base identity/business verification for
// standalone Commerce merchants.
//
// Lives in THIS file, and reuses its requireAdmin/callCommerce/OIDC machinery
// verbatim, because the trust boundary is identical: mydoctor_admin ->
// Healthcare (admin verified here, against users/{uid}.role) -> Commerce
// (IAM-invoker-restricted to this project's runtime service account). A
// second relay file would duplicate that boundary for no gain.
//
// What it is NOT is the same APPROVAL. These four endpoints move
// organizations/{orgId}.verificationStatus — "is this a real business run by
// a known person", which gates trading at all. The regulatory endpoints above
// move sellerRegulatoryScopes — "may this business sell pharmaceuticals".
// Approving one never grants the other, on either side of this relay.
// ─────────────────────────────────────────────────────────────────────────────

exports.adminListMerchantVerifications = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listPendingMerchantVerificationsForHealthcare", {
    actorUid: request.auth.uid,
  });
});

// Short-lived signed URL for ONE government-ID/registration document, for
// secure review. Identity documents are never public and never directly
// readable by any Commerce user or staff member — Commerce's storage.rules
// denies every client read, and this is the only path to the bytes.
exports.adminGetMerchantVerificationDocument = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, docType } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !docType || typeof docType !== "string") {
    throw new HttpsError("invalid-argument", "orgId and docType are required.");
  }
  return callCommerce("getMerchantVerificationDocumentForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    docType,
  });
});

// Approval — the ONE place a standalone organization becomes "verified", and
// the point at which its commercial trial starts. Commerce independently
// re-checks document completeness and that the reviewed person is still the
// organization's owner before granting anything; this relay never trusts the
// admin UI's own completeness display as the real gate.
//
// Never grants sellerRegulatoryScopes. A verified medical supplier still
// needs adminApproveSellerRegulatoryApplication above.
exports.adminApproveMerchantVerification = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId } = request.data || {};
  if (!orgId || typeof orgId !== "string") {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }
  return callCommerce("approveMerchantVerificationForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
  });
});

// Reject (terminal for this application) or request changes (resubmittable).
// A reason is REQUIRED for both: a merchant told to fix something must be told
// what, and an unexplained rejection is an unactionable one.
exports.adminReviewMerchantVerification = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, decision, reason } = request.data || {};
  if (!orgId || typeof orgId !== "string") {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }
  if (decision !== "rejected" && decision !== "changes_requested") {
    throw new HttpsError("invalid-argument", 'decision must be "rejected" or "changes_requested".');
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new HttpsError("invalid-argument", "A reason is required.");
  }
  return callCommerce("reviewMerchantVerificationForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    decision,
    reason: reason.trim(),
  });
});
