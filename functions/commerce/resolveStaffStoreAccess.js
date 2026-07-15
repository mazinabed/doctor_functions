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
//   2. That caller must actually be the pharmacy owner (uid === pharmacyId)
//      OR an ACTIVE pharmacy_admin member of THAT SAME pharmacy — checked
//      fresh against Firestore, not inferred from anything the client sent.
//   3. The target staff member must have an ACTIVE membership doc in THE
//      SAME pharmacy's pharmacy_members subcollection (a collection-scoped
//      query, not a global lookup) — confirms "employee belongs to that
//      pharmacy" rather than trusting the client's own claim.
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

exports.resolveStaffStoreAccess = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
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
      const callerIsAdmin = await isCallerPharmacyAdmin(db, pharmacyId, decoded.uid);
      if (!callerIsAdmin) {
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
        storePermissions,
        pharmacyCommerceSubscriptionStatus,
        pharmacyCommerceTrialEnds,
        pharmacyCommerceGracePeriodEnds,
      });
    } catch (err) {
      console.error("[resolveStaffStoreAccess] internal error:", err);
      res.status(500).json({ error: "Internal error." });
    }
  },
);
