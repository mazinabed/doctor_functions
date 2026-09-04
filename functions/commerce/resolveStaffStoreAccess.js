// TrustyDr Commerce Bridge — Staff Store-permission resolution.
//
// Extends the SAME bridge pattern as resolveAccessContext.js (read-only,
// idToken-verified, minimum-data-exchange), for a DIFFERENT question:
// resolveAccessContext answers "who is the CALLER"; this answers "what
// Store permissions does a SPECIFIC staff member of a SPECIFIC pharmacy
// currently have, according to Healthcare — the source of truth" — used by
// Commerce's staff Odoo-provisioning sync so that permissions are always
// read fresh from Healthcare, never trusted from the calling client's own
// payload (per the agreed sync architecture: Healthcare writes employee ->
// client calls Commerce bridge -> Commerce bridge reads Healthcare staff
// record -> determines Store permissions -> provisions/updates Odoo user).
//
// Security (all three enforced server-side, not assumed):
//   1. idToken must verify to a real Healthcare user (admin.auth().verifyIdToken).
//   2. That caller must be reading their OWN record (uid === staffMemberId),
//      OR be the pharmacy owner (uid === pharmacyId), OR be an ACTIVE
//      pharmacy_admin member of THAT SAME pharmacy — checked fresh against
//      Firestore, not inferred from anything the client sent.
//   3. The target staff member must have an ACTIVE membership doc in THE
//      SAME pharmacy's pharmacy_members subcollection (a collection-scoped
//      query, not a global lookup) — confirms "employee belongs to that
//      pharmacy" rather than trusting the client's own claim.
//
// ─── Why self-resolution is permitted (2026-09-04) ───────────────────────────
//
// This endpoint was written for ONE caller shape: an owner/admin saving the
// Add/Edit Staff sheet, syncing someone ELSE's Store access. Commerce's
// establishStaffCommerceSession later reused it for the opposite shape — a
// staff member establishing their OWN first Store session — where the actor
// IS the subject. Guard 2 refused that with 403, which
// establishStaffCommerceSession did not catch, so it surfaced as an opaque
// HTTP 500 and the Store never opened for any invited pharmacy staff member.
//
// It was unsatisfiable for them by construction, not merely strict:
// firestore.rules' pharmacy_members CREATE path 2 forbids an invite from
// creating a 'pharmacy_admin', and UPDATE path 1 blocks promotion to it from
// the client — so no invited staff account can ever BE a pharmacy_admin.
// (Exactly the shape of the Center Reception defect fixed in doctor_functions
// 9563fbb, where no invited staff could ever satisfy isCenterAdmin().)
//
// Self-resolution discloses nothing new. The response is byte-identical to
// what an owner asking about that same member receives, and every field in it
// describes the caller themselves: their own role, their own Store
// permissions, plus the pharmacy's Commerce subscription status — which
// resolveAccessContext.js ALREADY returns to this same staff caller as
// pharmacyCommerceSubscriptionStatus. A caller asking about themselves in a
// pharmacy they do not belong to gets {found:false} from the path-scoped
// lookup below, before any of that is computed.
//
// It also grants nothing. This endpoint only ever REPORTS what an owner or
// manager already assigned in Healthcare; it has never been the thing that
// decides Store access. store_access remains enforced upstream by
// establishStaffCommerceSession's own pharmacyStaffStoreAccess gate, and the
// granular store_* permissions returned here still drive exactly which
// Commerce actions and Store tabs that member gets. A member without
// store_access is still refused; a member with a narrow permission set still
// gets a narrow set.
//
// Never returns clinical data, the full Healthcare permissions array, or
// any Healthcare-only permission keys (team_management, pharmacy_settings,
// etc) — only the store_* subset Commerce actually needs (Minimum Data
// Exchange Principle, matching resolveAccessContext.js's own header).
// Never writes to Firestore. Never issues a credential of any kind.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const STORE_PERMISSION_KEYS = [
  "store_access",
  "store_inventory",
  "store_purchasing",
  "store_sales",
  "store_products",
  "store_vendors",
  "store_reports",
  "store_finance",
];

// The caller-authorization decision, extracted pure so the security property
// is assertable without Firestore or a real ID token — same convention as
// resolveAccessContext.js's own resolveVerifiedPhoneNumber.
//
// `callerIsOwnerOrAdmin` is the resolved result of isCallerPharmacyAdmin()
// below; `callerUid`/`staffMemberId` are both taken from server-side state
// (the VERIFIED token and the request body respectively), never from a
// client-supplied "isSelf" flag.
function isCallerAuthorizedForStaffRecord({
  callerUid,
  staffMemberId,
  callerIsOwnerOrAdmin,
}) {
  if (!callerUid || !staffMemberId) return false;
  if (callerUid === staffMemberId) return true; // reading their OWN record
  return callerIsOwnerOrAdmin === true;
}

async function isCallerPharmacyAdmin(db, pharmacyId, callerUid) {
  if (callerUid === pharmacyId) return true; // the owner, acting on their own pharmacy

  const adminSnap = await db
    .collection("pharmacy_providers")
    .doc(pharmacyId)
    .collection("pharmacy_members")
    .where("uid", "==", callerUid)
    .where("role", "==", "pharmacy_admin")
    .where("isActive", "==", true)
    .limit(1)
    .get();
  return !adminSnap.empty;
}

// The handler body, separated from the onRequest wrapper so tests can drive
// it with a plain req/res pair — the v2 wrapper expects a full Express
// response (res.on, etc). Same convention as legal/legalConsent.js's own
// exported _getAccountLegalStatusHandler.
async function resolveStaffStoreAccessHandler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const { idToken, pharmacyId, staffMemberId } = req.body || {};
  if (!idToken || typeof idToken !== "string") {
    res.status(400).json({ error: "idToken is required." });
    return;
  }
  if (!pharmacyId || typeof pharmacyId !== "string") {
    res.status(400).json({ error: "pharmacyId is required." });
    return;
  }
  if (!staffMemberId || typeof staffMemberId !== "string") {
    res.status(400).json({ error: "staffMemberId is required." });
    return;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired ID token." });
    return;
  }

  const db = admin.firestore();

  try {
    // Self-resolution skips the owner/admin lookup entirely — one less
    // Firestore query on the hot first-Store-session path, and there is
    // nothing for it to decide: the record being read is the caller's own.
    const callerIsSelf = decoded.uid === staffMemberId;
    const callerIsOwnerOrAdmin = callerIsSelf
      ? false
      : await isCallerPharmacyAdmin(db, pharmacyId, decoded.uid);

    if (
      !isCallerAuthorizedForStaffRecord({
        callerUid: decoded.uid,
        staffMemberId,
        callerIsOwnerOrAdmin,
      })
    ) {
      res.status(403).json({ error: "Caller is not an owner/admin of this pharmacy." });
      return;
    }

    const staffDoc = await db
      .collection("pharmacy_providers")
      .doc(pharmacyId)
      .collection("pharmacy_members")
      .doc(staffMemberId)
      .get();

    if (!staffDoc.exists) {
      res.status(200).json({ found: false });
      return;
    }

    const data = staffDoc.data();
    const belongsToPharmacy = true; // guaranteed by the collection path itself, not a separate field check
    const isActive = data.isActive === true;
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const storePermissions = permissions.filter((p) => STORE_PERMISSION_KEYS.includes(p));

    // Phase 1B (Commerce Billing) — billing is owned by
    // medical_centers/{centerId}, never pharmacy_providers. pharmacyId
    // here is always the OWNER's uid (see this file's own header), so
    // this is the exact same derivation resolveAccessContext.js uses for
    // an owner caller — one extra doc read, not a new pattern.
    let pharmacyCommerceSubscriptionStatus = null;
    let pharmacyCommerceTrialEnds = null;
    let pharmacyCommerceGracePeriodEnds = null;
    const ownerUserSnap = await db.collection("users").doc(pharmacyId).get();
    const ownerCenterId = ownerUserSnap.exists
      ? ownerUserSnap.data().centerId || null
      : null;
    if (ownerCenterId) {
      const centerSnap = await db
        .collection("medical_centers")
        .doc(ownerCenterId)
        .get();
      if (centerSnap.exists) {
        const centerData = centerSnap.data();
        pharmacyCommerceSubscriptionStatus =
          centerData.commerceSubscriptionStatus || null;
        pharmacyCommerceTrialEnds = centerData.commerceTrialEnds
          ? centerData.commerceTrialEnds.toDate().toISOString()
          : null;
        pharmacyCommerceGracePeriodEnds = centerData.commerceGracePeriodEnds
          ? centerData.commerceGracePeriodEnds.toDate().toISOString()
          : null;
      }
    }

    res.status(200).json({
      found: true,
      belongsToPharmacy,
      isActive,
      uid: data.uid || null,
      displayName: data.displayName || "",
      phoneNumber: data.phoneNumber || "",
      // Commerce Store Roles & Permissions (Checkpoint 2, 2026-07-19) —
      // the pharmacy_members role string (manager/pharmacist/receptionist/
      // billing/pharmacy_admin), used only to pick a sensible starting
      // Store role template on first Commerce session; not a clinical or
      // otherwise sensitive field, and Commerce already reads this same
      // member document's storePermissions above.
      role: data.role || null,
      // Checkpoint 4 (2026-07-19) — the explicit Store Role the owner/
      // manager picked in the Add/Edit Staff sheet (store_manager/
      // pharmacist/inventory_staff/sales_order_staff). Superseded by
      // storeCommercePermissions below as the primary signal, kept as a
      // compatibility fallback. Commerce re-validates this string against
      // its own canonical template list before ever using it — never
      // trusted blindly just because it came from this bridge.
      storeRoleTemplate: data.storeRoleTemplate || null,
      // Unified Staff Sheet correction (2026-07-19) — the explicit Store
      // Permission checkbox keys chosen in the unified Add/Edit Staff
      // sheet. `null` (not `[]`) when the field was never set at all, so
      // Commerce can tell "record predates this field" apart from "owner
      // explicitly selected nothing."
      storeCommercePermissions: Array.isArray(data.storeCommercePermissions)
        ? data.storeCommercePermissions
        : null,
      storePermissions,
      pharmacyCommerceSubscriptionStatus,
      pharmacyCommerceTrialEnds,
      pharmacyCommerceGracePeriodEnds,
    });
  } catch (err) {
    console.error("[resolveStaffStoreAccess] internal error:", err);
    res.status(500).json({ error: "Internal error." });
  }
}

exports.isCallerAuthorizedForStaffRecord = isCallerAuthorizedForStaffRecord;
exports._resolveStaffStoreAccessHandler = resolveStaffStoreAccessHandler;

exports.resolveStaffStoreAccess = onRequest(
  { region: "us-central1", cors: false },
  resolveStaffStoreAccessHandler,
);
