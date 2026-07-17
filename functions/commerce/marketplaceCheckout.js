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
// only ever holds one orgId at a time) for the common case, but this
// function does NOT trust that: every submitted productEngineId is
// independently verified server-side to belong to the submitted orgId's
// own Odoo company (or be a genuinely shared record) — enforced in
// trustydr-commerce/functions/src/marketplaceCheckout.ts's
// isLineFromWrongStore, using each product's live company_id, never the
// Flutter cart's or the cached Marketplace projection's say-so. A patient
// submitting orgId=Store A with a product belonging to Store B is rejected
// with a "wrong_store" reason, the same 409 path as a stale price/stock
// mismatch.
//
// Commerce billing operational gate: resolveCommerceSubscriptionStatus
// below reads medical_centers/{centerId}.commerceSubscriptionStatus
// DIRECTLY from this project's own Firestore (never a cached eligibility
// value, never inferred from the catalog or Marketplace sync having run
// recently) immediately before every placeMarketplaceOrder call, and
// rejects fast (before ever reserving an idempotency slot or calling
// Commerce) if the store isn't currently operational. The SAME
// freshly-resolved value is also forwarded to Commerce's
// placeMarketplaceOrderForHealthcare, which independently re-applies the
// canonical isCommerceBillingOperational definition as the authoritative
// enforcement point (it's the one about to call Odoo) — defense in depth,
// not a single trusted check.
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

// Must match trustydr-commerce/functions/src/activation.ts's own
// PHARMACY_ORG_ID_PREFIX exactly — duplicated here because the two are
// separate repos/languages with no shared package, same as this bridge's
// hardcoded COMMERCE_BASE_URL above.
const PHARMACY_ORG_ID_PREFIX = "hc_pharmacy_";

// pharmacy_providers/{uid} doc id IS the owner's uid (confirmed against
// resolveAccessContext.js's own read pattern) — so this is also exactly
// the id the Pharmacy Operations dashboard (doctor_portal) scopes its
// marketplace_orders reads by by, and the same id firestore.rules'
// existing isPharmacyMember/isPharmacyOwner helpers expect. Returns null
// for a non-pharmacy orgId (never throws) — callers treat null as "no
// pharmacy scoping possible," matching resolveCommerceSubscriptionStatus's
// own existing null-on-mismatch convention below.
function pharmacyOwnerUidFromOrgId(orgId) {
  return orgId.startsWith(PHARMACY_ORG_ID_PREFIX)
    ? orgId.slice(PHARMACY_ORG_ID_PREFIX.length)
    : null;
}

// The SAME three-state definition as trustydr-commerce's own
// isCommerceBillingOperational (lib/healthcareBridge.ts) — Commerce is
// usable during 'trial'/'active'/'grace' only. Duplicated, not imported
// (separate repos/languages); if either definition ever changes, the other
// must be updated to match.
function isCommerceBillingOperational(status) {
  return status === "trial" || status === "active" || status === "grace";
}

// TrustyDr app locale ('en'/'ar'/'ku', the same three easy_localization
// codes used across every other Flutter->Healthcare bridge) -> Odoo
// res.lang code. Resolved server-side from a client-submitted locale hint,
// never a client-submitted raw Odoo lang string — the client only ever
// gets to pick one of the app's own three supported locales, same trust
// boundary as everything else in this file. No Kurdish res.lang record
// exists on the connected Odoo instance (confirmed live 2026-07-14, see
// TrustyDr-pwa/lib/core/providers/marketplace_providers.dart's own note),
// so 'ku' maps to Arabic, matching that same file's Kurdish-falls-to-Arabic
// convention.
const ODOO_LANG_BY_LOCALE = { en: "en_US", ar: "ar_001", ku: "ar_001" };
function resolveOdooLang(locale) {
  return ODOO_LANG_BY_LOCALE[locale] || undefined;
}

// Reads commerceSubscriptionStatus DIRECTLY from this project's own
// Firestore — no bridge call needed, since Healthcare already owns this
// data (medical_centers/{centerId}, the confirmed billing owner, exactly
// where startCommerceTrial.js/expireCenters.js write it). Returns null if
// orgId doesn't resolve to a real Healthcare-origin pharmacy with a
// facility on file — treated as NOT operational by the caller.
async function resolveCommerceSubscriptionStatus(db, orgId) {
  const pharmacyOwnerUid = pharmacyOwnerUidFromOrgId(orgId);
  if (!pharmacyOwnerUid) return null;

  const userSnap = await db.collection("users").doc(pharmacyOwnerUid).get();
  const centerId = userSnap.exists ? userSnap.data().centerId : null;
  if (!centerId) return null;

  const centerSnap = await db.collection("medical_centers").doc(centerId).get();
  if (!centerSnap.exists) return null;

  return centerSnap.data().commerceSubscriptionStatus || null;
}

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

// Milestone 6 checkout gaps — server-side resolution of the authenticated
// patient's real profile for checkout prefill. Never trusts a client-
// submitted identity: reads users/{uid} directly with request.auth.uid,
// the same trust boundary placeMarketplaceOrder below now uses for the
// Odoo customer record itself. homeAddress (province/city/full/note) is
// TrustyDr-pwa's own existing saved-address shape (home_address_page.dart)
// — returned as-is so the Flutter checkout form can prefill its delivery
// fields, but this is only a DEFAULT: the patient may still edit the
// address for this specific order (see EngineDeliveryAddress in
// trustydr-commerce), the profile's saved address itself is never
// overwritten by a checkout edit.
exports.getMarketplaceCheckoutProfile = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const db = admin.firestore();
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const data = userSnap.exists ? userSnap.data() : {};

  const homeAddress =
    data.homeAddress && typeof data.homeAddress === "object"
      ? {
          province: data.homeAddress.province || "",
          city: data.homeAddress.city || "",
          full: data.homeAddress.full || "",
          note: data.homeAddress.note || "",
        }
      : null;

  return {
    name: typeof data.name === "string" ? data.name : "",
    phone: typeof data.phoneNumber === "string" ? data.phoneNumber : "",
    homeAddress,
  };
});

exports.placeMarketplaceOrder = onCall({ region: "us-central1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to place an order.");
  }
  const patientId = request.auth.uid;

  const {
    orgId,
    idempotencyKey,
    lines,
    deliveryCarrierEngineId,
    deliveryAddress,
    locale,
    storeNameEn,
    storeNameAr,
  } = request.data || {};

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
  if (deliveryCarrierEngineId) {
    const addr = deliveryAddress;
    if (
      !addr ||
      typeof addr !== "object" ||
      !addr.province ||
      !addr.city ||
      !addr.full
    ) {
      throw new HttpsError(
        "invalid-argument",
        "A delivery address (province, city, and full address) is required for home delivery.",
      );
    }
  }

  const db = admin.firestore();

  // Identity is resolved SERVER-SIDE from the authenticated user's own
  // profile — never from client-submitted patientName/patientPhone (that
  // field pair no longer exists in the request payload at all). This is
  // the fix for the "generic User" Odoo customer bug: a stale or empty
  // client-submitted name can never reach Odoo again. The patient may
  // still edit per-order DELIVERY contact info via deliveryAddress.name/
  // .phone below — that's a shipping-address detail, not the identity
  // bound to res.partner.ref.
  const patientProfileSnap = await db.collection("users").doc(patientId).get();
  const patientProfile = patientProfileSnap.exists ? patientProfileSnap.data() : {};
  const resolvedName = typeof patientProfile.name === "string" ? patientProfile.name.trim() : "";
  if (!resolvedName) {
    throw new HttpsError(
      "failed-precondition",
      "Please complete your profile name before placing an order.",
    );
  }
  const resolvedPhone =
    typeof patientProfile.phoneNumber === "string" && patientProfile.phoneNumber
      ? patientProfile.phoneNumber
      : undefined;

  // GUARD 1 — Commerce billing operational gate, checked BEFORE reserving
  // an idempotency slot or calling Commerce at all: a non-operational store
  // must fail fast and cheap, never consume a real idempotency attempt.
  const commerceSubscriptionStatus = await resolveCommerceSubscriptionStatus(db, orgId);
  if (!isCommerceBillingOperational(commerceSubscriptionStatus)) {
    throw new HttpsError("failed-precondition", "This store is not currently available for orders.", {
      code: "store_unavailable",
    });
  }

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
        // Snapshotted here (immutable receipt architecture) — this order's
        // actual delivery destination, which may differ from the patient's
        // saved users/{uid}.homeAddress. Null for pickup orders.
        deliveryAddress: deliveryCarrierEngineId ? deliveryAddress : null,
        // Store name and patient contact snapshots — resolved/validated
        // below (patientName/patientPhone come from the SERVER-resolved
        // profile, never the client) but written here inside the same
        // reservation for the My Orders / Order Details pages to render
        // without a runtime join to another collection (firestore-safety.md
        // §7 — a UI widget must not read from more than one collection to
        // render a single record). storeName is display-only, sourced from
        // the same Marketplace projection the cart itself already trusts
        // for display purposes.
        storeNameEn: typeof storeNameEn === "string" ? storeNameEn : null,
        storeNameAr: typeof storeNameAr === "string" ? storeNameAr : null,
        patientName: resolvedName,
        patientPhone: resolvedPhone || null,
        order: null,
        // Pharmacy Operations Dashboard (Phase 1) — pharmacyOwnerUid scopes
        // this doc for a staff-side read (firestore.rules' existing
        // isPharmacyMember/isPharmacyOwner helpers), written unconditionally
        // here (even on a since-failed attempt) so support/diagnostics can
        // always resolve which pharmacy an attempt belonged to.
        // fulfillmentStatus stays null until the order is ACTUALLY confirmed
        // in Odoo below — a pending/failed attempt must never appear in a
        // pharmacy's Order Queue. This is a NEW, separate field from
        // `status` above (order-creation success) — see marketplace_orders
        // schema notes in the Pharmacy Operations Dashboard plan; `status`
        // keeps its existing, already-deployed meaning unchanged.
        pharmacyOwnerUid: pharmacyOwnerUidFromOrgId(orgId),
        fulfillmentStatus: null,
        saleOrderState: null,
        pickingState: null,
        fulfillmentStatusHistory: [],
        staffNote: null,
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
    patientName: resolvedName,
    patientPhone: resolvedPhone,
    idempotencyKey,
    lines,
    deliveryCarrierEngineId: deliveryCarrierEngineId || undefined,
    deliveryAddress: deliveryCarrierEngineId ? deliveryAddress : undefined,
    lang: resolveOdooLang(locale),
    // Freshly resolved above, forwarded so Commerce's own authoritative
    // re-check (the function actually about to call Odoo) never has to
    // trust this bridge's fail-fast check alone — defense in depth against
    // a billing-status change in the narrow window between the two reads.
    pharmacyCommerceSubscriptionStatus: commerceSubscriptionStatus,
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
    if (result.status === 403) {
      throw new HttpsError(
        "failed-precondition",
        result.data.message || "This store is not currently available for orders.",
        { code: "store_unavailable" },
      );
    }
    if (result.status === 400 && result.data.error === "delivery_address_required") {
      throw new HttpsError(
        "invalid-argument",
        result.data.message || "A delivery address is required for home delivery.",
        { code: "delivery_address_required" },
      );
    }
    throw new HttpsError("internal", result.data.error || "Could not place the order. Please try again.");
  }

  // Pharmacy Operations Dashboard (Phase 1) — the order only becomes
  // visible in a pharmacy's Order Queue once it's genuinely confirmed in
  // Odoo (never on the pending/failed attempt above). saleOrderState is
  // seeded from Commerce's own confirmed response (EnginePatientOrderResult
  // .status, already read live from Odoo by createPatientOrder — never
  // re-guessed here); pickingState starts null (no fulfillment action has
  // happened yet). fulfillmentStatusHistory entries use Timestamp.now(),
  // NOT FieldValue.serverTimestamp() — Firestore does not allow the server-
  // timestamp sentinel inside an array element.
  await orderRef.update({
    status: "confirmed",
    order: result.data.order,
    fulfillmentStatus: "new",
    saleOrderState: (result.data.order && result.data.order.status) || null,
    fulfillmentStatusHistory: admin.firestore.FieldValue.arrayUnion({
      status: "new",
      at: admin.firestore.Timestamp.now(),
      byUid: patientId,
      byName: resolvedName,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { orderId: idempotencyKey, order: result.data.order };
});

// Cancellation boundary (business rule owned here, not by Odoo or
// Commerce): a patient may cancel through Odoo's 'assigned' picking state
// (stock reserved for the delivery, but nothing physically moved yet) —
// only 'done' (physical fulfillment: packed/shipped/delivered) blocks it.
// Odoo's stock.picking has no separate "packing"/"ready"/"shipped" states
// beyond assigned/done — 'assigned' IS "ready," and this milestone's
// decision is that reserving stock alone does not yet count as fulfillment
// starting. Re-checked LIVE against Odoo on every call, never against the
// locally-cached marketplace_orders projection. The actual stock-unreserve
// on cancellation is Odoo's own native behavior (cancelSalesOrder cancels
// the linked picking(s) first, which is what releases the reservation) —
// no custom inventory adjustment happens on this side.
const CANCELLABLE_PICKING_STATES = new Set([null, "draft", "waiting", "confirmed", "assigned"]);

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

  // LIVE-CONFIRMED (2026-07-16): a non-throwing response from
  // cancelMarketplaceOrderForHealthcare does NOT guarantee Odoo actually
  // cancelled the order — sale.order.action_cancel() has been observed to
  // return HTTP 200 while leaving state as "sale" (root cause not yet
  // understood; the linked picking DOES correctly reach "cancel" — only
  // the sale.order's own state fails to flip). Never mark the patient-
  // facing record cancelled on trust alone: only state === "cancel" is
  // treated as a real cancellation. Anything else surfaces as a clear
  // error, and marketplace_orders stays "confirmed" — a false "Cancelled"
  // shown to a patient while the pharmacy could still fulfill the order
  // is a worse failure mode than an honest "couldn't cancel, try again."
  if (cancelResult.data.state !== "cancel") {
    console.error(
      JSON.stringify({
        msg: "cancelMarketplaceOrder.odoo_state_not_cancelled",
        orderId,
        engineId: data.order.engineId,
        returnedState: cancelResult.data.state,
      }),
    );
    throw new HttpsError(
      "internal",
      "This order could not be cancelled. Please contact the pharmacy directly.",
    );
  }

  // Pharmacy Operations Dashboard (Phase 1) — a patient-cancelled order
  // must also leave the pharmacy's active Order Queue, regardless of what
  // fulfillment stage the pharmacy had it at (preparing/ready/etc.).
  await orderRef.update({
    status: "cancelled",
    fulfillmentStatus: "cancelled",
    fulfillmentStatusHistory: admin.firestore.FieldValue.arrayUnion({
      status: "cancelled",
      at: admin.firestore.Timestamp.now(),
      byUid: patientId,
      byName: data.patientName || "",
    }),
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

// Fixed, reviewed EN/AR/KU labels — never derived from Odoo's raw English
// carrier name (today just one real record, "Standard delivery," English-
// only; confirmed live 2026-07-16). Keyed by the stable semantic
// deliveryType Commerce returns (or "pickup", synthesized entirely here —
// Odoo has no native pickup marker), so a future Odoo rename/second carrier
// never breaks the patient-facing label. The Flutter client localizes
// purely by reading name_en/name_ar/name_ku off the deliveryType-matched
// entry — it never inspects English text to guess a translation.
const DELIVERY_METHOD_LABELS = {
  pickup: { name_en: "Store Pickup", name_ar: "الاستلام من المتجر", name_ku: "وەرگرتن لە فرۆشگا" },
  delivery: { name_en: "Home Delivery", name_ar: "التوصيل إلى المنزل", name_ku: "گەیاندن بۆ ماڵەوە" },
};

// Public, unauthenticated — delivery methods are non-sensitive general
// store info (same public-browse posture as getMarketplaceCatalog.js), not
// a protected/patient-identity-bound action. Needed by the pickup/delivery
// picker step of checkout, called before a patient necessarily signs in.
//
// Response shape (one entry per option, pickup always first):
//   { carrierEngineId: string|null, deliveryType: 'pickup'|'delivery',
//     name_en, name_ar, name_ku, fee: number, freeOverThreshold: number|null,
//     currency: string|null, estimatedDeliveryMinutesMin: number|null,
//     estimatedDeliveryMinutesMax: number|null, note_en/ar/ku: string|null }
// freeOverThreshold (null for pickup) is a DISPLAY ESTIMATE only — Odoo's
// delivery.carrier.free_over/amount, confirmed live 2026-07-16 — the
// authoritative delivery amount is always recomputed server-side at
// order-confirmation time, never trusted from this pre-checkout read.
// carrierEngineId is null for pickup (no Odoo delivery.carrier — Phase-1
// no-carrier-selected checkout path, see marketplaceCheckout.ts's own
// deliveryCarrierEngineId: null branch, which requires no shipping address).
exports.getMarketplaceDeliveryMethods = onCall({ region: "us-central1" }, async (request) => {
  const { orgId } = request.data || {};
  if (!orgId || typeof orgId !== "string") {
    throw new HttpsError("invalid-argument", "orgId is required.");
  }

  const result = await callCommerce("getMarketplaceDeliveryMethodsForHealthcare", { orgId });
  if (!result.ok) {
    throw new HttpsError("internal", "Could not read delivery methods. Please try again.");
  }
  const rawMethods = Array.isArray(result.data.methods) ? result.data.methods : [];

  const pickup = {
    carrierEngineId: null,
    deliveryType: "pickup",
    ...DELIVERY_METHOD_LABELS.pickup,
    fee: 0,
    freeOverThreshold: null,
    currency: null,
    estimatedDeliveryMinutesMin: null,
    estimatedDeliveryMinutesMax: null,
    note_en: null,
    note_ar: null,
    note_ku: null,
  };

  const deliveryMethods = rawMethods
    .filter((m) => m && m.active !== false)
    .map((m) => ({
      carrierEngineId: m.engineId,
      deliveryType: "delivery",
      ...DELIVERY_METHOD_LABELS.delivery,
      fee: typeof m.fixedPrice === "number" ? m.fixedPrice : 0,
      freeOverThreshold: typeof m.freeOverThreshold === "number" ? m.freeOverThreshold : null,
      // listDeliveryMethods() (trustydr-commerce) doesn't return a
      // per-carrier currency today — the order's own confirmed currencyName
      // (EnginePatientOrderResult, read at order-confirmation time) is the
      // authoritative currency for display; this field is reserved for a
      // future multi-currency carrier but always null right now.
      currency: null,
      // Store-owned display fields (organizations/{orgId}.storeSettings.
      // delivery), passed straight through from the enriched Commerce
      // response — never derived or guessed here.
      estimatedDeliveryMinutesMin:
        typeof m.estimatedDeliveryMinutesMin === "number" ? m.estimatedDeliveryMinutesMin : null,
      estimatedDeliveryMinutesMax:
        typeof m.estimatedDeliveryMinutesMax === "number" ? m.estimatedDeliveryMinutesMax : null,
      note_en: typeof m.note_en === "string" ? m.note_en : null,
      note_ar: typeof m.note_ar === "string" ? m.note_ar : null,
      note_ku: typeof m.note_ku === "string" ? m.note_ku : null,
    }));

  return { methods: [pickup, ...deliveryMethods] };
});

// Exported for focused unit testing (tests/marketplace_checkout_guards.test.js)
// — pure/near-pure guard logic, independent of the onCall wrapper.
exports.isCommerceBillingOperational = isCommerceBillingOperational;
exports.resolveCommerceSubscriptionStatus = resolveCommerceSubscriptionStatus;
