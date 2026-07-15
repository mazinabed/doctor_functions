// TrustyDr Commerce Bridge — Milestone 6 (Cart, Checkout, Order Creation).
//
// Patient-App-facing, same direction as getMarketplaceCatalog.js
// (Healthcare -> Commerce), but write-capable and patient-identity-bound,
// unlike that read-only, unauthenticated function. The Patient App never
// calls Commerce or Odoo directly (ADR-C002, COMMERCE_DOMAIN_BOUNDARIES.md
// §5) — placeMarketplaceOrder is the only path from a patient's tap to a
// real Odoo sale.order.
//
// Patient identity: request.auth.uid IS the patientId, full stop — there is
// no bookedByUserId/staff-ordering equivalent for Marketplace orders today
// (unlike appointments' patientId != bookedByUserId dual-field convention).
// Build that only if/when a reception-initiated order flow is explicitly
// requested; this function would need a real design change, not a silent
// assumption, to support it.
//
// One-store-per-cart is enforced by the CALLER (the Flutter cart provider
// only ever holds one orgId at a time) — this function trusts the single
// orgId it's given. It does NOT independently verify every requested
// productEngineId actually belongs to that orgId's Odoo company; Commerce's
// own getLiveProductSnapshot has no per-org scoping either. This is the
// SAME deferred multi-tenant boundary every other write bridge in this
// ecosystem already defers to (TENANT_ARCHITECTURE_SAAS_EVALUATION.md,
// single-Odoo-company reality) — not a gap invented or silently patched
// here, and not safe to paper over with an ad-hoc check that would only
// half-solve a problem the real fix (per-tenant Odoo company resolution)
// already owns.
//
// Idempotency (PRIMARY guard — Commerce's own marketplace_order_idempotency
// check, in trustydr-commerce/functions/src/marketplaceCheckout.ts, is a
// SECONDARY net for a retried outbound fetch specifically): reserves
// marketplace_orders/{idempotencyKey} in HEALTHCARE'S OWN Firestore, in a
// transaction, BEFORE ever calling Commerce:
//   - doc missing -> create as 'pending', proceed to call Commerce.
//   - doc exists, status 'confirmed' -> return the stored result, no
//     second Commerce/Odoo call (safe replay of a client retry).
//   - doc exists, status 'pending' -> reject (a call may genuinely be in
//     flight for this exact key right now).
//   - doc exists, status 'failed' -> allowed to retry (transitions back to
//     'pending', calls Commerce again).
//   - doc exists but belongs to a DIFFERENT patientId -> reject; an
//     idempotency key must never let one patient read or replay into
//     another's order.
//
// marketplace_orders is the patient-facing order-history projection —
// Odoo's sale.order remains the actual system of record for the order
// itself (SYSTEM_OF_RECORD_MATRIX.md convention, matching every other
// Commerce write path); this collection exists because patients only ever
// read Healthcare's own Firestore, never Commerce's.

const { HttpsError, onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const COMMERCE_BASE_URL = "https://us-central1-trustydr-commerce.cloudfunctions.net";

async function callCommerce(endpoint, body) {
  let response;
  try {
    response = await fetch(`${COMMERCE_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[marketplaceCheckout] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[marketplaceCheckout] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  return { ok: response.ok, status: response.status, data };
}

exports.placeMarketplaceOrder = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to place an order.");
  }
  const patientId = request.auth.uid;

  const { orgId, idempotencyKey, lines, deliveryCarrierEngineId, patientName, patientPhone } =
    request.data || {};

  if (
    !orgId ||
    typeof orgId !== "string" ||
    !idempotencyKey ||
    typeof idempotencyKey !== "string" ||
    !Array.isArray(lines) ||
    lines.length === 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      "orgId, idempotencyKey, and a non-empty lines array are required.",
    );
  }
  if (lines.some((l) => !l || !l.productEngineId || !(Number(l.quantity) > 0))) {
    throw new HttpsError(
      "invalid-argument",
      "Every line requires a productEngineId and a positive quantity.",
    );
  }
  if (!patientName || typeof patientName !== "string") {
    throw new HttpsError("invalid-argument", "patientName is required.");
  }

  const db = admin.firestore();
  const orderRef = db.collection("marketplace_orders").doc(idempotencyKey);

  const shouldCallCommerce = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      tx.set(orderRef, {
        orderId: idempotencyKey,
        patientId,
        orgId,
        status: "pending",
        requestedLines: lines,
        deliveryCarrierEngineId: deliveryCarrierEngineId || null,
        order: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    }
    const data = snap.data();
    if (data.patientId !== patientId) {
      throw new HttpsError("permission-denied", "This order reference does not belong to you.");
    }
    if (data.status === "confirmed") return false;
    if (data.status === "pending") {
      throw new HttpsError("already-exists", "This order is already being processed.");
    }
    tx.update(orderRef, { status: "pending", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });

  if (!shouldCallCommerce) {
    const existing = (await orderRef.get()).data();
    return { orderId: idempotencyKey, order: existing.order };
  }

  const result = await callCommerce("placeMarketplaceOrderForHealthcare", {
    orgId,
    patientRef: patientId,
    patientName,
    patientPhone: patientPhone || undefined,
    idempotencyKey,
    lines,
    deliveryCarrierEngineId: deliveryCarrierEngineId || undefined,
  });

  if (!result.ok) {
    await orderRef.update({ status: "failed", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    if (result.status === 409) {
      throw new HttpsError(
        "failed-precondition",
        result.data.error || "Some items are no longer available.",
        { unavailable: result.data.unavailable || [] },
      );
    }
    throw new HttpsError("internal", result.data.error || "Could not place the order. Please try again.");
  }

  await orderRef.update({
    status: "confirmed",
    order: result.data.order,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { orderId: idempotencyKey, order: result.data.order };
});

// Cancellation boundary (business rule owned here, not by Odoo or
// Commerce): only while Odoo's own state is still 'sale' (confirmed, not
// yet done/invoiced) AND no linked stock.picking has progressed past
// 'confirmed' — i.e. fulfillment hasn't actually started. Re-checked LIVE
// against Odoo on every call, never against the locally-cached
// marketplace_orders projection.
const CANCELLABLE_PICKING_STATES = new Set([null, "draft", "waiting", "confirmed"]);

exports.cancelMarketplaceOrder = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const patientId = request.auth.uid;
  const { orderId } = request.data || {};
  if (!orderId || typeof orderId !== "string") {
    throw new HttpsError("invalid-argument", "orderId is required.");
  }

  const db = admin.firestore();
  const orderRef = db.collection("marketplace_orders").doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Order not found.");
  }
  const data = snap.data();
  if (data.patientId !== patientId) {
    throw new HttpsError("permission-denied", "This order does not belong to you.");
  }
  if (data.status !== "confirmed" || !data.order || !data.order.engineId) {
    throw new HttpsError("failed-precondition", "This order cannot be cancelled.");
  }

  const statusResult = await callCommerce("getMarketplaceOrderStatusForHealthcare", {
    engineId: data.order.engineId,
  });
  if (!statusResult.ok) {
    throw new HttpsError("internal", "Could not verify order status. Please try again.");
  }
  const live = statusResult.data;
  if (live.state !== "sale" || !CANCELLABLE_PICKING_STATES.has(live.pickingState)) {
    throw new HttpsError(
      "failed-precondition",
      "This order can no longer be cancelled — fulfillment has already started.",
    );
  }

  const cancelResult = await callCommerce("cancelMarketplaceOrderForHealthcare", {
    orgId: data.orgId,
    engineId: data.order.engineId,
    patientRef: patientId,
  });
  if (!cancelResult.ok) {
    throw new HttpsError("internal", cancelResult.data.error || "Could not cancel the order.");
  }

  await orderRef.update({
    status: "cancelled",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { orderId, state: cancelResult.data.state };
});

// Thin, read-only status read for the order-history/tracking page — no
// custom TrustyDr status enum, per the agreed thin-native-mapping
// approach. Returns Odoo's own state/invoiceStatus/pickingState fields
// as-is; the Flutter client owns the patient-facing label translation.
exports.getMarketplaceOrderStatus = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const patientId = request.auth.uid;
  const { orderId } = request.data || {};
  if (!orderId || typeof orderId !== "string") {
    throw new HttpsError("invalid-argument", "orderId is required.");
  }

  const db = admin.firestore();
  const snap = await db.collection("marketplace_orders").doc(orderId).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Order not found.");
  }
  const data = snap.data();
  if (data.patientId !== patientId) {
    throw new HttpsError("permission-denied", "This order does not belong to you.");
  }
  if (data.status !== "confirmed" || !data.order || !data.order.engineId) {
    return { orderId, status: data.status, live: null };
  }

  const result = await callCommerce("getMarketplaceOrderStatusForHealthcare", {
    engineId: data.order.engineId,
  });
  if (!result.ok) {
    throw new HttpsError("internal", "Could not read order status. Please try again.");
  }

  return { orderId, status: data.status, live: result.data };
});
