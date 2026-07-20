'use strict';

// Pharmacy Operations Dashboard — Phase 1, Increment 2 (Accept, Reject,
// Start Preparing, Mark Ready for Pickup / Out for Delivery, Mark
// Completed).
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
// pickup"/"out for delivery" concept (see pharmacy_order_status.dart's own
// mapping table in doctor_portal for the full state design). Only 3 of the
// 6 actions here make a real Odoo write:
//   - rejectPharmacyOrder            -> reuses cancelMarketplaceOrderForHealthcare
//   - startPharmacyOrderPreparation  -> startOrderPreparationForHealthcare (action_assign)
//   - markPharmacyOrderCompleted     -> completeOrderFulfillmentForHealthcare (button_validate)
// The other 3 (accept, markReadyForPickup, markOutForDelivery) are
// Healthcare-side flips gated on a live READ-ONLY re-check
// (getMarketplaceOrderStatusForHealthcare) — never a blind trust of the
// cached Firestore projection.

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
  { fromStatuses, toStatus, actorUid, actorName, saleOrderState, pickingState },
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

// ─── Mark Ready for Pickup / Mark Out for Delivery ─────────────────────────
// Same underlying Odoo signal ('assigned' picking state IS "ready" — no
// separate Odoo state exists for the two) — read-only re-verified live,
// distinguished only by isDelivery, which the caller must match or the
// action is rejected outright (never silently relabeled).
async function markReadyOrOutForDelivery(request, { expectedIsDelivery, toStatus, wrongTypeMessage }) {
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
  if (data.fulfillmentStatus !== "preparing") {
    throw new HttpsError("failed-precondition", "This order is not in preparation.");
  }
  const engineId = requireLinkedOdooOrder(data);

  const statusResult = await callCommerce("getMarketplaceOrderStatusForHealthcare", { engineId });
  if (!statusResult.ok) {
    throw new HttpsError("internal", "Could not verify the order with the store system. Please try again.");
  }
  if (statusResult.data.state !== "sale" || statusResult.data.pickingState !== "assigned") {
    throw new HttpsError(
      "failed-precondition",
      "This order is not yet ready — stock has not been fully reserved.",
    );
  }

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: ["preparing"],
    toStatus,
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: statusResult.data.state,
    pickingState: statusResult.data.pickingState,
  });

  return { orderId: orderRef.id, fulfillmentStatus: toStatus };
}

exports.markPharmacyOrderReadyForPickup = onCall({ region: "us-central1" }, (request) =>
  markReadyOrOutForDelivery(request, {
    expectedIsDelivery: false,
    toStatus: "readyForPickup",
    wrongTypeMessage: 'This is a delivery order — use "Mark Out for Delivery" instead.',
  }),
);

exports.markPharmacyOrderOutForDelivery = onCall({ region: "us-central1" }, (request) =>
  markReadyOrOutForDelivery(request, {
    expectedIsDelivery: true,
    toStatus: "outForDelivery",
    wrongTypeMessage: 'This is a pickup order — use "Mark Ready for Pickup" instead.',
  }),
);

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

  await applyFulfillmentTransition(db, orderRef, {
    fromStatuses: ["readyForPickup", "outForDelivery"],
    toStatus: "completed",
    actorUid: request.auth.uid,
    actorName,
    saleOrderState: result.data.saleOrderState,
    pickingState: result.data.pickingState,
  });

  return { orderId: orderRef.id, fulfillmentStatus: "completed" };
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

  // Assignment only makes sense before delivery has concluded — mirrors the
  // "before delivery is completed" bound the product spec calls out
  // explicitly for reassignment.
  const assignableStatuses = ["accepted", "preparing", "readyForPickup", "outForDelivery"];
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
