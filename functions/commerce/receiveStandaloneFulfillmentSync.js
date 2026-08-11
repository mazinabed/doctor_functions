'use strict';

// Standalone Commerce -> Healthcare Fulfillment Projection Bridge
// (2026-08-10) — receiving side. Closes the confirmed live gap (order
// S00109) where a standalone Commerce org's fulfillment overlay
// (organizations/{orgId}/orderFulfillment/{engineId}, trustydr-commerce's
// own Firestore project) never reached this project's marketplace_orders
// projection, so the Patient App and its notification engine never learned
// about a merchant action for standalone-org orders at all.
//
// Healthcare-linked pharmacy orgs (hc_pharmacy_*) are NOT affected by this
// file — that path already writes marketplace_orders directly via
// pharmacyOrderActions.js's own applyFulfillmentTransition, called from
// doctor_portal, and remains completely untouched. Commerce's own
// isStandaloneOrgId() gate (healthcareFulfillmentBridge.ts) is what keeps
// hc_pharmacy_* orgs from ever reaching this endpoint at all; this file
// does not need to re-derive that distinction.
//
// SECURITY: this is a server-to-server onRequest endpoint with NO Firebase
// Auth request.auth (Commerce has no identity in this project). The
// SECURITY BOUNDARY is entirely IAM-invoker restriction, not application
// code: `invoker: [COMMERCE_SERVICE_ACCOUNT_EMAIL]` below rejects any
// caller lacking Cloud Run's roles/run.invoker for this specific service
// BEFORE this code ever runs — this is the exact same trust model
// Commerce's own admin bridge endpoints already use in the opposite
// direction (see trustydr-commerce/functions/src/lib/healthcareBridge.ts's
// own HEALTHCARE_SERVICE_ACCOUNT_EMAIL doc comment), mirrored, not
// invented. --allow-unauthenticated is deliberately never used here.
// actorUid in the request body remains only an audit-trail label, exactly
// like every existing bridge in this codebase — never the security
// boundary itself. This does NOT touch, weaken, or refactor the separately
// scoped, already-known-insecure *ForHealthcare patient-facing endpoints —
// that gap is a different, later, independently scheduled audit.
//
// Reliability: this endpoint does not need its own retry logic — Commerce's
// own outbox (healthcareFulfillmentOutbox.ts) durably retries with bounded
// backoff on any non-2xx/network failure. This endpoint only needs to be:
// (1) idempotent for a replayed eventId, and (2) safe against out-of-order
// delivery, both implemented below via the SAME fromStatuses-guarded
// transactional pattern pharmacyOrderActions.js's own
// applyFulfillmentTransition already uses for the Healthcare-linked path —
// reused in spirit, not by importing that file directly (it is keyed by
// Firestore doc id, this endpoint must first resolve the doc id from
// orgId + order.engineId).

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

// Commerce's default Cloud Functions/Cloud Run runtime service account
// (project trustydr-commerce, project number 749624058165 — confirmed live
// via `firebase projects:list`, 2026-08-10; no custom runtime
// serviceAccount is set anywhere in trustydr-commerce/functions/src, so
// every Commerce function, including the caller of this endpoint, runs as
// this default compute service account). Mirrors healthcareBridge.ts's own
// HEALTHCARE_SERVICE_ACCOUNT_EMAIL exactly, reversed.
const COMMERCE_SERVICE_ACCOUNT_EMAIL = "749624058165-compute@developer.gserviceaccount.com";

const RECEIVE_SYNC_OPTIONS = {
  region: "us-central1",
  invoker: [COMMERCE_SERVICE_ACCOUNT_EMAIL],
  timeoutSeconds: 30,
  memory: "256MiB",
};

// The exact valid predecessor set for each transition, independently
// derived here (never trusted from the request body's own `fromStatus`,
// which is informational/logging-only) — mirrors, transition-for-
// transition, the fromStatuses Commerce's own marketplaceOrdersForOrg.ts
// passes to applyOverlayTransition for each of its 8 exported actions. This
// map alone is what provides out-of-order protection: a delayed
// 'preparing' event arriving after 'completed' has already been applied
// simply fails this check (current status 'completed' is not in
// ['accepted']) and is safely dropped as stale, never applied backwards.
const FROM_STATUSES_FOR_TRANSITION = {
  accepted: ["new"],
  rejected: ["new"],
  preparing: ["accepted"],
  readyForPickup: ["preparing"],
  readyForDelivery: ["preparing"],
  outForDelivery: ["readyForDelivery"],
  completed: ["readyForPickup", "outForDelivery"],
  deliveryFailed: ["outForDelivery"],
};

function fromStatusesForTransition(toStatus) {
  return FROM_STATUSES_FOR_TRANSITION[toStatus] || null;
}

// Never blindly forward Commerce's extraFields into a shared production
// document — even though the caller is now IAM-authenticated, a whitelist
// costs nothing and keeps this endpoint from becoming a write-anything
// relay if Commerce's own payload shape ever drifts or is misused.
const EXTRA_FIELD_WHITELIST = [
  "paymentStatus",
  "paymentMethod",
  "amountPaid",
  "receiptRef",
  "paymentNotes",
  "deliveryFailureNote",
];

function whitelistExtraFields(rawExtraFields) {
  if (!rawExtraFields || typeof rawExtraFields !== "object") return {};
  const out = {};
  for (const key of EXTRA_FIELD_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(rawExtraFields, key)) {
      out[key] = rawExtraFields[key];
    }
  }
  return out;
}

function validateBody(body) {
  const { orgId, engineId, eventId, toStatus, actorUid } = body || {};
  if (typeof orgId !== "string" || !orgId) return "orgId is required.";
  if (typeof engineId !== "string" || !engineId) return "engineId is required.";
  if (typeof eventId !== "string" || !eventId) return "eventId is required.";
  if (typeof actorUid !== "string" || !actorUid) return "actorUid is required.";
  if (!fromStatusesForTransition(toStatus)) return `toStatus '${toStatus}' is not a recognized transition.`;
  return null;
}

// Exported for a direct-call unit test — the actual read/write logic,
// separated from the onRequest transport wrapper so it can be exercised
// against a real Firestore emulator without an HTTP round-trip.
async function applyStandaloneFulfillmentSync(db, body) {
  const { orgId, engineId, eventId, toStatus, actorUid } = body;
  const extraFields = whitelistExtraFields(body.extraFields);
  const fromStatuses = fromStatusesForTransition(toStatus);

  // Correlation: marketplace_orders is keyed by a client-generated
  // idempotencyKey at checkout, never the Odoo engineId — orgId +
  // order.engineId is the only proven correlation (see the design trace).
  // This lookup happens outside the transaction (Firestore transactions
  // need a concrete doc ref up front); the transaction below re-reads the
  // SAME doc fresh for the actual guard + write.
  const querySnap = await db
    .collection("marketplace_orders")
    .where("orgId", "==", orgId)
    .where("order.engineId", "==", engineId)
    .limit(1)
    .get();

  if (querySnap.empty) {
    return { outcome: "not_found" };
  }
  const orderRef = querySnap.docs[0].ref;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      return { outcome: "not_found" };
    }
    const data = snap.data();

    // Idempotency — the SAME eventId replayed (e.g. Commerce retried after
    // the response was lost, even though the write already committed) must
    // never re-apply, never append a second history entry, and therefore
    // never re-trigger onMarketplaceOrderFulfillmentUpdated a second time
    // (that trigger only fires on an actual document field change — a true
    // no-op here means no write, means no second notification).
    const processedEventIds = Array.isArray(data.healthcareSyncProcessedEventIds)
      ? data.healthcareSyncProcessedEventIds
      : [];
    if (processedEventIds.includes(eventId)) {
      return { outcome: "already_processed" };
    }

    const current = data.fulfillmentStatus || "new";
    if (!fromStatuses.includes(current)) {
      // Out-of-order / superseded event — the order has already moved
      // past the state this event assumed. Never move it backwards; just
      // record nothing and report "stale" so Commerce's outbox stops
      // retrying an event that can never apply.
      return { outcome: "stale" };
    }

    const update = {
      fulfillmentStatus: toStatus,
      fulfillmentStatusHistory: admin.firestore.FieldValue.arrayUnion({
        status: toStatus,
        at: admin.firestore.Timestamp.now(),
        byUid: actorUid,
        byName: "",
        source: "commerce_standalone_sync",
      }),
      healthcareSyncProcessedEventIds: admin.firestore.FieldValue.arrayUnion(eventId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extraFields,
    };
    tx.update(orderRef, update);
    return { outcome: "applied" };
  });
}

const receiveStandaloneFulfillmentSync = onRequest(RECEIVE_SYNC_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const validationError = validateBody(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const db = admin.firestore();
    const result = await applyStandaloneFulfillmentSync(db, req.body);

    if (result.outcome === "not_found") {
      res.status(404).json({ error: "No matching marketplace_orders document for this orgId + engineId." });
      return;
    }
    if (result.outcome === "stale") {
      res.status(200).json({ status: "stale" });
      return;
    }
    if (result.outcome === "already_processed") {
      res.status(200).json({ status: "alreadyProcessed" });
      return;
    }
    res.status(200).json({ status: "applied" });
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "receiveStandaloneFulfillmentSync.failed",
        orgId: req.body && req.body.orgId,
        engineId: req.body && req.body.engineId,
        eventId: req.body && req.body.eventId,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      }),
    );
    res.status(500).json({ error: "Could not process this fulfillment sync event. Please try again." });
  }
});

module.exports = {
  receiveStandaloneFulfillmentSync,
  COMMERCE_SERVICE_ACCOUNT_EMAIL,
  RECEIVE_SYNC_OPTIONS,
  fromStatusesForTransition,
  whitelistExtraFields,
  applyStandaloneFulfillmentSync,
};
