'use strict';

// Pharmacy Operations Dashboard — Phase 1, Increment 2 (Accept, Reject,
// Start Preparing, Mark Ready for Pickup / Ready for Delivery / Out for
// Delivery, Mark Completed).
//
// Every action follows the SAME required flow, no exceptions:
//   Pharmacy Dashboard -> this file (authenticated Healthcare bridge) ->
//   Commerce (trustydr-commerce, direct HTTPS, same callCommerce() pattern
//   marketplaceCheckout.js already uses) -> Odoo native action ->
//   re-read live Odoo state -> update marketplace_orders projection ->
//   Patient My Orders / Pharmacy Dashboard refresh from that write.
// marketplace_orders is NEVER updated before Odoo has confirmed success —
// every function below calls Commerce (or, for Accept/Ready-relabeling,
// re-verifies live state) BEFORE the Firestore write, and aborts with no
// write at all if Odoo didn't confirm.
//
// Odoo has no native "pharmacy accepted this order" or "ready for
// pickup/delivery"/"out for delivery" concept (see pharmacy_order_status.dart's
// own mapping table in doctor_portal for the full state design). Only 4 of
// the actions here make a real Odoo write:
//   - rejectPharmacyOrder            -> reuses cancelMarketplaceOrderForHealthcare
//   - startPharmacyOrderPreparation  -> startOrderPreparationForHealthcare
//     (Phase 7, 2026-07-23 reorder: action_assign + button_validate — this
//     is now where the real stock decrement happens, matching pickingState
//     'done' immediately, not just 'assigned')
//   - markPharmacyOrderCompleted     -> completeOrderFulfillmentForHealthcare
//     (Phase 7: pure re-read now, no Odoo write — the picking was already
//     validated back at Preparing; "Completed" is handoff, not inventory
//     removal)
//   - markPharmacyOrderDeliveryFailed -> processDeliveryFailureForHealthcare
//     (Commerce Reverse Fulfillment Phase 9C, 2026-07-27: full-order
//     stock.return.picking reversal, driven through the same Reverse
//     Fulfillment case state machine Phase 9A/9B use, auto-resolved and
//     closed in the same request since there is no separate Commerce
//     review step for this event — see that endpoint's own doc comment in
//     reverseFulfillment.ts for the full rationale)
// The others (accept, markReadyForPickup, markReadyForDelivery,
// markOutForDelivery) are Healthcare-side flips gated on a live READ-ONLY
// re-check (getMarketplaceOrderStatusForHealthcare) — never a blind trust
// of the cached Firestore projection.
//
// IMPORTANT (Phase 7, 2026-07-23): pickingState now reaches 'done' at
// Preparing, not at Completed — markReadyOrOutForDelivery's own gate below
// was updated from 'assigned' to 'done' to match. Patient-facing status
// (TrustyDr-pwa) must derive its labels from fulfillmentStatus, never from
// this live Odoo pickingState — see marketplace_order_details_page.dart's
// own _liveStatusLabelKey. Odoo's pickingState stays an internal
// operational/ERP-sync signal only; TrustyDr's own fulfillmentStatus is the
// one customer/business-facing source of truth for order progress.
//
// Workflow refinement (2026-07-20): delivery orders now pass through a
// distinct 'readyForDelivery' stage between 'preparing' and 'outForDelivery'
// (pharmacies prepare first, THEN decide/dispatch — driver assignment was
// already allowed this early and remains so; only the hard "must have a
// valid driver" gate is tied to the readyForDelivery -> outForDelivery leg).
// Completion (markPharmacyOrderCompleted) now always requires a payment
// disposition in the same transaction as the status write — "Completed"
// means both handed over AND payment accounted for, for pickup and
// delivery alike.

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
    console.error(`[pharmacyOrderActions] network error reaching ${endpoint}:`, err);
    throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error(`[pharmacyOrderActions] could not parse ${endpoint} response:`, err);
    throw new HttpsError("internal", "Commerce Bridge returned an unreadable response.");
  }
  return { ok: response.ok, status: response.status, data };
}

// Same three-permission-key defaults as doctor_portal's own
// pharmacy_permission.dart PharmacyPermission.defaultsForRole() — only the
// 3 order-related keys are reproduced here (this file has no reason to
// know about billing/serviceCatalog/etc). Used ONLY when a pharmacy_members
// doc has no explicit `permissions` array stored — mirrors
// center_identity_provider.dart's own "stored array wins, else
// defaultsForRole" precedence exactly.
const ORDER_PERMISSION_DEFAULTS_BY_ROLE = {
  receptionist: ["orders"],
  pharmacist: ["orders", "orders_fulfillment"],
  billing: [],
  manager: ["orders", "orders_intake", "orders_fulfillment"],
};

// Mirrors resolveAccessContext.js's own established owner-fast-path /
// collectionGroup('pharmacy_members') staff-path pattern — never a new
// authorization scheme. pharmacy_providers/{uid} doc id IS the owner's
// uid (confirmed against resolveAccessContext.js:110), so pharmacyOwnerUid
// plugs directly into both paths below with no extra lookup.
async function authorizePharmacyStaff(db, callerUid, pharmacyOwnerUid, requiredPermission) {
  if (!pharmacyOwnerUid || typeof pharmacyOwnerUid !== "string") {
    throw new HttpsError("failed-precondition", "This order has no pharmacy scope.");
  }

  if (callerUid === pharmacyOwnerUid) {
    const ownerSnap = await db.collection("users").doc(callerUid).get();
    if (ownerSnap.exists && ownerSnap.data().role === "pharmacy_provider") {
      return { actorName: ownerSnap.data().name || "" };
    }
  }

  const memberSnap = await db
    .collection("pharmacy_providers")
    .doc(pharmacyOwnerUid)
    .collection("pharmacy_members")
    .doc(callerUid)
    .get();

  if (!memberSnap.exists || memberSnap.data().isActive !== true) {
    throw new HttpsError("permission-denied", "You are not an active member of this pharmacy.");
  }

  const memberData = memberSnap.data();
  const role = memberData.role || "";

  if (role === "pharmacy_admin") {
    return { actorName: memberData.name || "" };
  }

  const storedPermissions = Array.isArray(memberData.permissions) ? memberData.permissions : [];
  const permissions =
    storedPermissions.length > 0 ? storedPermissions : ORDER_PERMISSION_DEFAULTS_BY_ROLE[role] || [];

  if (!permissions.includes(requiredPermission)) {
    throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
  }

  return { actorName: memberData.name || "" };
}

// The ONE Firestore write path for every action below — transaction-
// guarded so two staff members racing on the same order can never both
// succeed (the second one's fromStatuses check fails and the whole
// transaction aborts with no write). `at` uses Timestamp.now(), not
// FieldValue.serverTimestamp() — Firestore forbids that sentinel inside an
// array element (fulfillmentStatusHistory).
async function applyFulfillmentTransition(
  db,
  orderRef,
  { fromStatuses, toStatus, actorUid, actorName, saleOrderState, pickingState, extraWrites, beforeWrite },
) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }
    const data = snap.data();
    if (!fromStatuses.includes(data.fulfillmentStatus)) {
      throw new HttpsError(
        "failed-precondition",
        "This order has already been updated — please refresh and try again.",
      );
    }
    // Business-rule hardening (2026-07-20) — an optional pre-write async
    // re-validation, run against THIS transaction's own consistent read of
    // `data` (never the pre-transaction snapshot the caller already had), so
    // a concurrent change (reassignment, driver deactivation) between the
    // caller's earlier check and this transaction's commit still aborts the
    // write with no partial mutation. Must throw to abort — same convention
    // as the fromStatuses check just above.
    if (typeof beforeWrite === "function") {
      await beforeWrite(tx, data);
    }
    const update = {
      fulfillmentStatus: toStatus,
      fulfillmentStatusHistory: admin.firestore.FieldValue.arrayUnion({
        status: toStatus,
        at: admin.firestore.Timestamp.now(),
        byUid: actorUid,
        byName: actorName || "",
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (saleOrderState !== undefined) update.saleOrderState = saleOrderState;
    if (pickingState !== undefined) update.pickingState = pickingState;
    tx.update(orderRef, update);
    // Milestone 7 — optional same-transaction side write (e.g. incrementing
    // a Delivery Person's completedDeliveries counter). Every existing
    // caller omits this and is completely unaffected.
    if (typeof extraWrites === "function") {
      extraWrites(tx, data);
    }
  });
}

async function loadOrderForAction(db, orderId) {
  if (!orderId || typeof orderId !== "string") {
    throw new HttpsError("invalid-argument", "orderId is required.");
  }
  const orderRef = db.collection("marketplace_orders").doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Order not found.");
  }
  return { orderRef, data: snap.data() };
}

function requireLinkedOdooOrder(data) {
  if (!data.order || !data.order.engineId) {
    throw new HttpsError("failed-precondition", "This order has no linked Odoo record.");
  }
  return data.order.engineId;
}

// ─── Accept ─────────────────────────────────────────────────────────────────
// No native Odoo write — a pure Healthcare-side flip, gated on a live
// read-only re-check (never a blind trust of the cached projection) that
// the order is still genuinely active before making it visible as
// "accepted" to the patient.
exports.acceptPharmacyOrder = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const { orderRef, data } = await loadOrderForAction(db, (request.data || {}).orderId);
  const { actorName } = await authorizePharmacyStaff(db, request.auth.uid, data.pharmacyOwnerUid, "orders_intake");

  if (data.fulfillmentStatus !== "new") {
    throw new HttpsError("failed-precondition", "This order can no longer be accepted.");
  }
  const engineId = requireLinkedOdooOrder(data);

  const statusResult = await callCommerce("getMarketplaceOrderStatusForHealthcare", { engineId });
  if (!statusResult.ok) {
    throw new HttpsError("internal", "Could not verify the order with the store system. Please try again.");
  }
  if (statusResult.data.state !== "sale") {
    throw new HttpsError("failed-precondition", "This order is no longer active in the store system.");
  }

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: ["new"],
    toStatus: "accepted",
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: statusResult.data.state,
    pickingState: statusResult.data.pickingState,
  });

  return { orderId: orderRef.id, fulfillmentStatus: "accepted" };
});

// ─── Reject ─────────────────────────────────────────────────────────────────
// Reuses the existing patient-cancellation Odoo write path — a rejected
// order is a real cancelled Odoo order (releases reserved stock), not a
// Healthcare-only label.
exports.rejectPharmacyOrder = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const { orderRef, data } = await loadOrderForAction(db, (request.data || {}).orderId);
  const { actorName } = await authorizePharmacyStaff(db, request.auth.uid, data.pharmacyOwnerUid, "orders_intake");

  if (data.fulfillmentStatus !== "new") {
    throw new HttpsError("failed-precondition", "This order can no longer be rejected.");
  }
  const engineId = requireLinkedOdooOrder(data);

  const cancelResult = await callCommerce("cancelMarketplaceOrderForHealthcare", {
    orgId: data.orgId,
    engineId,
    // The acting staff member's uid — Commerce's own cancel endpoint uses
    // this only as the audit-log actorUid, the same field patient-initiated
    // cancellation already forwards its own uid through.
    patientRef: request.auth.uid,
  });
  if (!cancelResult.ok) {
    throw new HttpsError("internal", cancelResult.data.error || "Could not reject the order. Please try again.");
  }
  if (cancelResult.data.state !== "cancel") {
    throw new HttpsError("internal", "This order could not be rejected. Please try again.");
  }

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: ["new"],
    toStatus: "rejected",
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: cancelResult.data.state,
  });

  return { orderId: orderRef.id, fulfillmentStatus: "rejected" };
});

// ─── Start Preparing ────────────────────────────────────────────────────────
exports.startPharmacyOrderPreparation = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const { orderRef, data } = await loadOrderForAction(db, (request.data || {}).orderId);
  const { actorName } = await authorizePharmacyStaff(
    db,
    request.auth.uid,
    data.pharmacyOwnerUid,
    "orders_fulfillment",
  );

  if (data.fulfillmentStatus !== "accepted") {
    throw new HttpsError("failed-precondition", "This order is not ready to start preparing.");
  }
  const engineId = requireLinkedOdooOrder(data);

  const result = await callCommerce("startOrderPreparationForHealthcare", { engineId });
  if (!result.ok) {
    throw new HttpsError(
      "internal",
      result.data.error || "Could not start preparing the order. Please try again.",
    );
  }
  if (result.data.saleOrderState !== "sale") {
    throw new HttpsError("failed-precondition", "This order is no longer active in the store system.");
  }

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: ["accepted"],
    toStatus: "preparing",
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: result.data.saleOrderState,
    pickingState: result.data.pickingState,
  });

  return { orderId: orderRef.id, fulfillmentStatus: "preparing" };
});

// ─── Delivery-person validation (Out for Delivery gate) ────────────────────
// Business-rule hardening (2026-07-20): a Home Delivery order must have a
// valid, active delivery person assigned before it can go out for delivery.
// The order's own assignedDeliveryPersonId is metadata written by
// assignPharmacyOrderDeliveryPerson — never trusted blindly here. Every
// check re-reads the actual delivery_personnel doc under THIS order's own
// pharmacyOwnerUid, the exact same scoping assignPharmacyOrderDeliveryPerson
// itself already uses (pharmacy_providers/{pharmacyOwnerUid}/
// delivery_personnel/{id}) — a stale, deactivated, or cross-pharmacy id can
// never pass, because a cross-pharmacy id simply cannot exist under this
// owner's own subcollection. Pickup orders (markPharmacyOrderReadyForPickup)
// never call this — this gate is delivery-only.
function isActiveDriverSnap(personSnap) {
  return personSnap.exists && personSnap.data().status === "active";
}

async function requireAssignedDeliveryPerson(db, pharmacyOwnerUid, assignedDeliveryPersonId) {
  if (!assignedDeliveryPersonId || typeof assignedDeliveryPersonId !== "string") {
    throw new HttpsError(
      "failed-precondition",
      "Assign a delivery person to this order before marking it out for delivery.",
      { reason: "driver_not_assigned" },
    );
  }
  const personSnap = await db
    .collection("pharmacy_providers")
    .doc(pharmacyOwnerUid)
    .collection("delivery_personnel")
    .doc(assignedDeliveryPersonId)
    .get();
  if (!isActiveDriverSnap(personSnap)) {
    throw new HttpsError(
      "failed-precondition",
      "The assigned delivery person is no longer active — assign a different one before marking this order out for delivery.",
      { reason: "driver_invalid" },
    );
  }
}

// ─── Mark Ready for Pickup / Ready for Delivery / Out for Delivery ─────────
// Same underlying Odoo signal ('assigned' picking state IS "ready" — no
// separate Odoo state exists for any of the three) — read-only re-verified
// live every time, distinguished by isDelivery (which the caller must match
// or the action is rejected outright, never silently relabeled) and by
// [fromStatus], the exact fulfillmentStatus this specific transition must
// start from. Workflow refinement (2026-07-20): delivery orders now pass
// through 'preparing' -> 'readyForDelivery' -> 'outForDelivery' (previously
// 'preparing' -> 'outForDelivery' directly) — [requireDriver] is only ever
// true for the readyForDelivery -> outForDelivery leg, so preparing a
// delivery order for dispatch never itself requires a driver (advance
// assignment from 'accepted'/'preparing' remains fully allowed, unchanged).
async function markReadyOrOutForDelivery(
  request,
  { expectedIsDelivery, fromStatus, toStatus, wrongTypeMessage, wrongStageMessage, requireDriver },
) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const { orderRef, data } = await loadOrderForAction(db, (request.data || {}).orderId);
  const { actorName } = await authorizePharmacyStaff(
    db,
    request.auth.uid,
    data.pharmacyOwnerUid,
    "orders_fulfillment",
  );

  const isDelivery = data.deliveryCarrierEngineId != null;
  if (isDelivery !== expectedIsDelivery) {
    throw new HttpsError("failed-precondition", wrongTypeMessage);
  }
  if (data.fulfillmentStatus !== fromStatus) {
    throw new HttpsError("failed-precondition", wrongStageMessage);
  }
  // Fail fast, before the Commerce round-trip, whenever this specific leg
  // requires a driver (only readyForDelivery -> outForDelivery today).
  // Re-validated again transactionally below (beforeWrite) to close the
  // race between this check and the actual write.
  if (requireDriver) {
    await requireAssignedDeliveryPerson(db, data.pharmacyOwnerUid, data.assignedDeliveryPersonId);
  }
  const engineId = requireLinkedOdooOrder(data);

  const statusResult = await callCommerce("getMarketplaceOrderStatusForHealthcare", { engineId });
  if (!statusResult.ok) {
    throw new HttpsError("internal", "Could not verify the order with the store system. Please try again.");
  }
  // Phase 7, 2026-07-23 reorder: the stock decrement now happens at
  // Preparing (startOrderPreparation), so by the time an order reaches
  // Ready/Out for Delivery its picking is already fully validated ('done'),
  // never merely 'assigned' — this gate checks the same underlying fact
  // (stock has actually moved) under the new timing, not a weaker one.
  if (statusResult.data.state !== "sale" || statusResult.data.pickingState !== "done") {
    throw new HttpsError(
      "failed-precondition",
      "This order is not yet ready — stock has not been fully prepared.",
    );
  }

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: [fromStatus],
    toStatus,
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: statusResult.data.state,
    pickingState: statusResult.data.pickingState,
    beforeWrite: requireDriver
      ? async (tx, current) => {
          const id = current.assignedDeliveryPersonId;
          if (!id || typeof id !== "string") {
            throw new HttpsError(
              "failed-precondition",
              "Assign a delivery person to this order before marking it out for delivery.",
              { reason: "driver_not_assigned" },
            );
          }
          const personSnap = await tx.get(
            db
              .collection("pharmacy_providers")
              .doc(current.pharmacyOwnerUid)
              .collection("delivery_personnel")
              .doc(id),
          );
          if (!isActiveDriverSnap(personSnap)) {
            throw new HttpsError(
              "failed-precondition",
              "The assigned delivery person is no longer active — assign a different one before marking this order out for delivery.",
              { reason: "driver_invalid" },
            );
          }
        }
      : undefined,
  });

  return { orderId: orderRef.id, fulfillmentStatus: toStatus };
}

exports.markPharmacyOrderReadyForPickup = onCall({ region: "us-central1" }, (request) =>
  markReadyOrOutForDelivery(request, {
    expectedIsDelivery: false,
    fromStatus: "preparing",
    toStatus: "readyForPickup",
    wrongTypeMessage: 'This is a delivery order — use "Mark Ready for Delivery" instead.',
    wrongStageMessage: "This order is not in preparation.",
    requireDriver: false,
  }),
);

exports.markPharmacyOrderReadyForDelivery = onCall({ region: "us-central1" }, (request) =>
  markReadyOrOutForDelivery(request, {
    expectedIsDelivery: true,
    fromStatus: "preparing",
    toStatus: "readyForDelivery",
    wrongTypeMessage: 'This is a pickup order — use "Mark Ready for Pickup" instead.',
    wrongStageMessage: "This order is not in preparation.",
    requireDriver: false,
  }),
);

exports.markPharmacyOrderOutForDelivery = onCall({ region: "us-central1" }, (request) =>
  markReadyOrOutForDelivery(request, {
    expectedIsDelivery: true,
    fromStatus: "readyForDelivery",
    toStatus: "outForDelivery",
    wrongTypeMessage: 'This is a pickup order — use "Mark Ready for Pickup" instead.',
    wrongStageMessage: "This order is not ready for delivery yet.",
    requireDriver: true,
  }),
);

// ─── Payment disposition (Completion gate) ─────────────────────────────────
// Workflow refinement (2026-07-20): "Completed" now always means BOTH the
// medication was handed over AND the pharmacy has recorded a payment
// disposition — never a hardcoded "cash received" assumption, since a
// pharmacy may collect cash, card, ZainCash, Qi Card, or (permission-
// controlled, reusing the SAME orders_fulfillment gate this whole action
// already requires — no new permission key invented for this) wave the
// order as a no-charge/complimentary order. 'paid_online'/'insurance' are
// explicitly future phases (per product spec) — PAYMENT_METHODS
// intentionally omits them so submitting either is rejected outright
// rather than silently accepted as a valid disposition today.
const PAYMENT_METHODS = ["cash", "card", "zaincash", "qi", "no_charge"];

function resolvePaymentDisposition(rawData) {
  const data = rawData && typeof rawData === "object" ? rawData : {};
  const paymentMethod = data.paymentMethod;
  if (typeof paymentMethod !== "string" || !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new HttpsError(
      "failed-precondition",
      "Select a payment disposition before completing this order.",
      { reason: "payment_method_required" },
    );
  }

  const receiptRefRaw = data.receiptRef;
  const receiptRef = typeof receiptRefRaw === "string" ? receiptRefRaw.trim().slice(0, 200) : "";
  const paymentNotesRaw = data.paymentNotes;
  const paymentNotes = typeof paymentNotesRaw === "string" ? paymentNotesRaw.trim().slice(0, 500) : "";

  // No-charge/complimentary — a genuine disposition, not a payment method:
  // no amount is collected, so amountPaid is deliberately never validated
  // or written for this case.
  if (paymentMethod === "no_charge") {
    return {
      paymentMethod,
      receiptRef: receiptRef || undefined,
      paymentNotes: paymentNotes || undefined,
    };
  }

  const amountPaid = data.amountPaid;
  if (typeof amountPaid !== "number" || !Number.isFinite(amountPaid) || amountPaid <= 0) {
    throw new HttpsError(
      "failed-precondition",
      "Enter a valid amount before completing this order.",
      { reason: "payment_amount_required" },
    );
  }

  return {
    paymentMethod,
    amountPaid,
    receiptRef: receiptRef || undefined,
    paymentNotes: paymentNotes || undefined,
  };
}

// ─── Mark Completed ─────────────────────────────────────────────────────────
exports.markPharmacyOrderCompleted = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const { orderRef, data } = await loadOrderForAction(db, (request.data || {}).orderId);
  const { actorName } = await authorizePharmacyStaff(
    db,
    request.auth.uid,
    data.pharmacyOwnerUid,
    "orders_fulfillment",
  );

  if (data.fulfillmentStatus !== "readyForPickup" && data.fulfillmentStatus !== "outForDelivery") {
    throw new HttpsError("failed-precondition", "This order is not ready to be completed.");
  }

  // Validated BEFORE the Odoo call and the transaction — fail fast, no
  // partial Odoo/Firestore mutation on a missing/invalid disposition (same
  // discipline as the Out for Delivery driver gate).
  const disposition = resolvePaymentDisposition(request.data);

  const engineId = requireLinkedOdooOrder(data);

  const result = await callCommerce("completeOrderFulfillmentForHealthcare", { engineId });
  if (!result.ok) {
    throw new HttpsError(
      "internal",
      result.data.error || "Could not mark the order completed. Please try again.",
    );
  }
  if (result.data.pickingState !== "done") {
    throw new HttpsError(
      "failed-precondition",
      "The store system could not confirm this order as fulfilled yet. Please try again.",
    );
  }

  const isDelivery = data.deliveryCarrierEngineId != null;

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: ["readyForPickup", "outForDelivery"],
    toStatus: "completed",
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: result.data.saleOrderState,
    pickingState: result.data.pickingState,
    // Milestone 7 / Workflow refinement — one same-transaction side write
    // covering both the pre-existing Delivery Person counter increment and
    // the new payment fields, never a second, separate write.
    extraWrites: (tx, current) => {
      const paymentUpdate = {
        paymentStatus: "paid",
        paymentMethod: disposition.paymentMethod,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paidByUserId: request.auth.uid,
      };
      if (disposition.amountPaid !== undefined) paymentUpdate.amountPaid = disposition.amountPaid;
      if (disposition.receiptRef !== undefined) paymentUpdate.receiptReference = disposition.receiptRef;
      if (disposition.paymentNotes !== undefined) paymentUpdate.paymentNotes = disposition.paymentNotes;
      // Delivery orders only — this completion IS reception confirming the
      // driver's phone/verbal report (drivers have no TrustyDr account this
      // phase and never touch this system themselves). Deliberately
      // separate from the generic fulfillmentStatusHistory entry above and
      // from the driver's own identity (assignedDeliveryPersonId/Name).
      if (isDelivery) {
        paymentUpdate.confirmedDeliveryAt = admin.firestore.FieldValue.serverTimestamp();
        paymentUpdate.confirmedDeliveryBy = request.auth.uid;
      }
      tx.update(orderRef, paymentUpdate);

      if (current.assignedDeliveryPersonId) {
        const personRef = db
          .collection("pharmacy_providers")
          .doc(current.pharmacyOwnerUid)
          .collection("delivery_personnel")
          .doc(current.assignedDeliveryPersonId);
        tx.set(
          personRef,
          {
            completedDeliveries: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    },
  });

  return { orderId: orderRef.id, fulfillmentStatus: "completed", paymentStatus: "paid" };
});

// ─── Mark Delivery Failed ───────────────────────────────────────────────────
// Milestone 7 (Simple Delivery Management). A genuine new terminal outcome —
// deliberately NOT folded into 'cancelled' (that means the pharmacy/patient
// cancelled before fulfillment; a failed delivery means the pharmacy
// actually attempted delivery and the courier could not complete it — a
// materially different operational event worth its own bucket in Reports
// and its own value here). Only reachable from 'outForDelivery' — pickup
// orders have no delivery leg to fail, and this must never be usable as a
// side-door out of 'preparing'/'readyForPickup'.
//
// Commerce Reverse Fulfillment Phase 9C (2026-07-27): this now DOES make a
// real Odoo write — processDeliveryFailureForHealthcare, a full-order
// stock.return.picking reversal (stock was already decremented back at
// Start Preparing and was never given back before this phase). Same
// "marketplace_orders is never updated before Odoo has confirmed success"
// law as every other action here: the Commerce call happens BEFORE the
// Firestore transition below, and this function aborts with no Firestore
// write at all if Commerce doesn't confirm. idempotencyKey is derived
// deterministically from this order's own Firestore doc id — a failed
// delivery is only ever reachable once per order (this function's own
// transactional fromStatuses guard prevents a second call), so a stable,
// order-scoped key is sufficient; it also protects against a genuine
// network-retry of this exact call ever double-returning the same stock.
// Refund/redelivery are still explicitly out of scope for V1 — restock is
// the only recovery this phase performs.
exports.markPharmacyOrderDeliveryFailed = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const { orderId, note } = request.data || {};
  const { orderRef, data } = await loadOrderForAction(db, orderId);
  const { actorName } = await authorizePharmacyStaff(
    db,
    request.auth.uid,
    data.pharmacyOwnerUid,
    "orders_fulfillment",
  );

  const isDelivery = data.deliveryCarrierEngineId != null;
  if (!isDelivery) {
    throw new HttpsError("failed-precondition", "This is a pickup order and has no delivery to fail.");
  }
  if (data.fulfillmentStatus !== "outForDelivery") {
    throw new HttpsError("failed-precondition", "This order is not out for delivery.");
  }
  const engineId = requireLinkedOdooOrder(data);

  const statusResult = await callCommerce("getMarketplaceOrderStatusForHealthcare", { engineId });
  if (!statusResult.ok) {
    throw new HttpsError("internal", "Could not verify the order with the store system. Please try again.");
  }
  if (statusResult.data.state !== "sale") {
    throw new HttpsError("failed-precondition", "This order is no longer active in the store system.");
  }

  const deliveryFailureResult = await callCommerce("processDeliveryFailureForHealthcare", {
    orgId: data.orgId,
    saleOrderEngineId: engineId,
    healthcareOrderRef: orderRef.id,
    actorUid: request.auth.uid,
    idempotencyKey: `delivery-failure-${orderRef.id}`,
  });
  if (!deliveryFailureResult.ok) {
    throw new HttpsError(
      "internal",
      deliveryFailureResult.data.error || "Could not process this delivery failure. Please try again.",
    );
  }

  // Optional free-text note (V1: no failure-reason taxonomy) — capped
  // defensively so a runaway client value can never bloat the history array.
  const trimmedNote = typeof note === "string" ? note.trim().slice(0, 500) : "";

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }
    const current = snap.data();
    if (current.fulfillmentStatus !== "outForDelivery") {
      throw new HttpsError(
        "failed-precondition",
        "This order has already been updated — please refresh and try again.",
      );
    }

    tx.update(orderRef, {
      fulfillmentStatus: "deliveryFailed",
      fulfillmentStatusHistory: admin.firestore.FieldValue.arrayUnion({
        status: "deliveryFailed",
        at: admin.firestore.Timestamp.now(),
        byUid: request.auth.uid,
        byName: actorName || "",
        ...(trimmedNote ? { note: trimmedNote } : {}),
      }),
      saleOrderState: statusResult.data.state,
      pickingState: statusResult.data.pickingState,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Preserves assignedDeliveryPersonId/Name on the order (never cleared —
    // "who was assigned when it failed" stays part of the record) and
    // increments that person's failedDeliveries counter transactionally.
    // set(..., {merge:true}) rather than update() — the personnel record is
    // never hard-deleted (firestore.rules: allow delete: if false) so this
    // should always target a real doc, but merge-set costs nothing extra
    // and can never abort the whole transaction on a NOT_FOUND.
    if (current.assignedDeliveryPersonId) {
      const personRef = db
        .collection("pharmacy_providers")
        .doc(current.pharmacyOwnerUid)
        .collection("delivery_personnel")
        .doc(current.assignedDeliveryPersonId);
      tx.set(
        personRef,
        {
          failedDeliveries: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });

  return { orderId: orderRef.id, fulfillmentStatus: "deliveryFailed" };
});

// ─── Assign / Reassign Delivery Person ──────────────────────────────────────
// Milestone 7 (Simple Delivery Management). Deliberately NOT built on
// applyFulfillmentTransition — assignment is order metadata, never a
// fulfillmentStatus change (explicit product direction: "I do NOT want
// assignment to become a fulfillment status"). This still appends to the
// SAME fulfillmentStatusHistory array (reusing the existing history/event
// architecture, not a parallel system) with a distinct `status` value
// ('driver_assigned' | 'driver_reassigned') the Flutter timeline special-
// cases for display. Gated on 'orders_fulfillment' — the same permission
// key that already gates every other fulfillment-adjacent action in this
// file.
exports.assignPharmacyOrderDeliveryPerson = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const { orderId, deliveryPersonId } = request.data || {};
  if (!deliveryPersonId || typeof deliveryPersonId !== "string") {
    throw new HttpsError("invalid-argument", "deliveryPersonId is required.");
  }

  const db = admin.firestore();
  const { orderRef, data } = await loadOrderForAction(db, orderId);
  const { actorName } = await authorizePharmacyStaff(
    db,
    request.auth.uid,
    data.pharmacyOwnerUid,
    "orders_fulfillment",
  );

  // Pickup orders have no delivery leg — a Delivery Person only makes sense
  // for Home Delivery orders. The Flutter picker already hides itself for
  // pickup orders; this is the server-side guard behind it.
  const isDelivery = data.deliveryCarrierEngineId != null;
  if (!isDelivery) {
    throw new HttpsError("failed-precondition", "This is a pickup order and cannot be assigned a delivery person.");
  }

  // Assignment only makes sense before delivery has concluded — mirrors the
  // "before delivery is completed" bound the product spec calls out
  // explicitly for reassignment. 'completed'/'deliveryFailed' (and any
  // earlier/other terminal status) are deliberately excluded. Advance
  // assignment from 'accepted'/'preparing' is explicit, confirmed product
  // direction (2026-07-20) — operationally there is no problem assigning a
  // driver early; only Out for Delivery itself hard-requires one.
  // 'readyForPickup' is dead weight for a delivery-only action (this
  // function already rejects non-delivery orders above) but kept for
  // symmetry with the pre-existing list, same as before this change.
  const assignableStatuses = [
    "accepted",
    "preparing",
    "readyForPickup",
    "readyForDelivery",
    "outForDelivery",
  ];
  if (!assignableStatuses.includes(data.fulfillmentStatus)) {
    throw new HttpsError("failed-precondition", "This order can no longer be assigned a delivery person.");
  }

  const personRef = db
    .collection("pharmacy_providers")
    .doc(data.pharmacyOwnerUid)
    .collection("delivery_personnel")
    .doc(deliveryPersonId);
  const personSnap = await personRef.get();
  if (!personSnap.exists) {
    throw new HttpsError("not-found", "Delivery person not found.");
  }
  const personData = personSnap.data();
  if (personData.status !== "active") {
    throw new HttpsError("failed-precondition", "This delivery person is not active.");
  }
  const driverName = personData.name || "";

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }
    const current = snap.data();
    if (!assignableStatuses.includes(current.fulfillmentStatus)) {
      throw new HttpsError(
        "failed-precondition",
        "This order has already been updated — please refresh and try again.",
      );
    }
    if (current.assignedDeliveryPersonId === deliveryPersonId) {
      // Already assigned to this same person — nothing to do, and not an
      // error (the UI may call this idempotently after a retry/race).
      return;
    }
    const eventStatus = current.assignedDeliveryPersonId ? "driver_reassigned" : "driver_assigned";
    tx.update(orderRef, {
      assignedDeliveryPersonId: deliveryPersonId,
      assignedDeliveryPersonName: driverName,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      fulfillmentStatusHistory: admin.firestore.FieldValue.arrayUnion({
        status: eventStatus,
        at: admin.firestore.Timestamp.now(),
        byUid: request.auth.uid,
        byName: actorName || "",
        driverId: deliveryPersonId,
        driverName,
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { orderId: orderRef.id, assignedDeliveryPersonId: deliveryPersonId, assignedDeliveryPersonName: driverName };
});

// Exported for focused unit testing, same convention as
// marketplaceCheckout.js's own exports at the bottom of that file.
exports.authorizePharmacyStaff = authorizePharmacyStaff;
exports.requireAssignedDeliveryPerson = requireAssignedDeliveryPerson;
exports.markReadyOrOutForDelivery = markReadyOrOutForDelivery;
exports.resolvePaymentDisposition = resolvePaymentDisposition;
