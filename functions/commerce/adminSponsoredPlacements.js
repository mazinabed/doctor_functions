// TrustyDr Commerce Bridge — Sponsored Placements (Admin Control).
//
// mydoctor_admin -> Healthcare -> Commerce, the exact same direction and
// trust boundary as adminStandaloneSubscriptionPayments.js (see that
// file's own header for the full reasoning): admin identity is verified
// here, against users/{uid}.role == "admin" in THIS project's own
// Firestore (the one canonical "admin" definition this ecosystem actually
// enforces — firestore.rules' isAdmin()), and every call to Commerce mints
// a real Google-signed OIDC identity token scoped to the target URL as
// audience. Commerce's endpoints are IAM-invoker-restricted to this
// project's own runtime service account (see Commerce's
// sponsoredPlacements.ts / HEALTHCARE_SERVICE_ACCOUNT_EMAIL) — a plain
// unauthenticated fetch, including one from a merchant's own authenticated
// session, is rejected by Cloud Run itself before Commerce's code ever
// runs. `actorUid` in the body is only ever an audit-trail label on the
// Commerce side, never the security boundary — THIS requireAdmin() call is
// the real gate.
//
// Security context: this relay exists specifically to close the gap found
// in a live code review of Marketplace Platform Phase 5 — the original
// updateSponsoredChannels was owner-callable, so any merchant could grant
// themselves sponsored eligibility for free, and there was no admin review
// step before a placement went live. Granting/revoking sponsoredChannels
// and approving/rejecting a sponsorship request must be reachable ONLY
// through this admin-verified path.
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

// Same status-to-HttpsError mapping as adminStandaloneSubscriptionPayments.js's
// own httpsErrorCodeForStatus — one case per status family Commerce's
// sponsoredPlacements.ts admin endpoints can actually return (400 bad
// input, 403 authorization failure, 404 missing resource, 409/422
// conflict-or-invalid-state, 5xx backend failure). The 5xx branch
// deliberately does NOT forward Commerce's own response body to the
// browser — the real detail stays in this relay's own server-side log line.
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
    console.error(`[adminSponsoredPlacements] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[adminSponsoredPlacements] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  if (!response.ok) {
    console.error(
      `[adminSponsoredPlacements] ${endpoint} returned ${response.status}:`,
      JSON.stringify(data),
    );
    const code = httpsErrorCodeForStatus(response.status);
    const message =
      code === "internal"
        ? "Commerce Bridge reported an internal error. Check Commerce Cloud Function logs for details."
        : data?.error || data?.message || "Request rejected by Commerce.";
    throw new HttpsError(code, message);
  }
  return data;
}

// Human-readable organization search — powers the sponsoredChannels grant/
// revoke screen's picker. No raw orgId is ever typed by the admin; this is
// how they FIND the orgId behind a real business name.
exports.adminSearchOrganizations = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { query, limit } = request.data || {};
  if (!query || typeof query !== "string") {
    throw new HttpsError("invalid-argument", "query is required.");
  }
  return callCommerce("searchOrganizationsForHealthcare", {
    actorUid: request.auth.uid,
    query,
    limit: typeof limit === "number" ? limit : undefined,
  });
});

exports.adminUpdateSponsoredChannels = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, sponsoredChannels } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !Array.isArray(sponsoredChannels)) {
    throw new HttpsError("invalid-argument", "orgId and a sponsoredChannels array are required.");
  }
  return callCommerce("updateSponsoredChannelsForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    sponsoredChannels,
  });
});

exports.adminListSponsoredPlacementRequests = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  return callCommerce("listPendingSponsoredPlacementRequestsForHealthcare", {
    actorUid: request.auth.uid,
  });
});

exports.adminApproveSponsoredPlacementRequest = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, placementId } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !placementId || typeof placementId !== "string") {
    throw new HttpsError("invalid-argument", "orgId and placementId are required.");
  }
  return callCommerce("approveSponsoredPlacementRequestForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    placementId,
  });
});

exports.adminRejectSponsoredPlacementRequest = onCall({ region: "us-central1" }, async (request) => {
  await requireAdmin(request);
  const { orgId, placementId, rejectionReason } = request.data || {};
  if (!orgId || typeof orgId !== "string" || !placementId || typeof placementId !== "string") {
    throw new HttpsError("invalid-argument", "orgId and placementId are required.");
  }
  return callCommerce("rejectSponsoredPlacementRequestForHealthcare", {
    actorUid: request.auth.uid,
    orgId,
    placementId,
    rejectionReason: typeof rejectionReason === "string" ? rejectionReason : undefined,
  });
});
