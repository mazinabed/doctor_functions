// TrustyDr Commerce Bridge — Milestone 2A (Healthcare Commerce Activation).
//
// Read-only identity resolution for TrustyDr Commerce. Verifies a Healthcare
// Firebase ID token and returns the minimum identity/eligibility fields
// Commerce needs to decide pharmacy-owner Commerce activation — nothing more
// (Minimum Data Exchange Principle, HEALTHCARE_COMMERCE_CONTRACT.md §7).
//
// Deliberately mirrors the LIVE doctor_portal accessContextProvider
// composition (users/{uid}.role, pharmacy_members collection group,
// pharmacy_providers/{uid}.status) confirmed by reading:
//   - core/access/access_context_provider.dart
//   - core/identity/identity_provider.dart
//   - core/membership/membership_provider.dart
//   - core/profile/provider_profile_provider.dart
// NOT the older aspirational AccessContext shape (version/orgType/
// subscriptionStatus) from earlier Commerce planning docs — those fields do
// not exist in this codebase.
//
// Never returns clinical data. Never writes to Firestore. Never issues a
// credential of any kind. No Healthcare schema or rules change — this file
// only reads existing collections.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

// Mirrors provider_profile_provider.dart's _normalizeStatus exactly.
const VALID_STATUSES = ["legalConsent", "onboarding", "pending", "active", "suspended"];
function normalizeStatus(value) {
  if (value === null || value === undefined) return "onboarding";
  const s = String(value).trim();
  return VALID_STATUSES.includes(s) ? s : "onboarding";
}

// Cross-project JSON transport — every Commerce billing Timestamp field is
// forwarded as an ISO string, never a raw Firestore Timestamp object.
function isoOrNull(timestamp) {
  return timestamp ? timestamp.toDate().toISOString() : null;
}

exports.resolveAccessContext = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }

    const idToken = req.body && req.body.idToken;
    if (!idToken || typeof idToken !== "string") {
      res.status(400).json({ error: "idToken is required." });
      return;
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ error: "Invalid or expired ID token." });
      return;
    }

    const uid = decoded.uid;
    const db = admin.firestore();

    try {
      const userDoc = await db.collection("users").doc(uid).get();
      const role = userDoc.exists ? (userDoc.data().role || "doctor") : "doctor";

      // Only pharmacy_members matters for Milestone 2A's owner-only rule —
      // center/lab membership is irrelevant to pharmacy Commerce activation.
      const pharmacyMembershipSnap = await db
        .collectionGroup("pharmacy_members")
        .where("uid", "==", uid)
        .where("isActive", "==", true)
        .limit(1)
        .get();
      const isPharmacyStaff = !pharmacyMembershipSnap.empty;
      // The pharmacy_providers doc id the staff member actually belongs to —
      // NOT the same as their own uid. Needed by Commerce's
      // getCommercePharmacyStatus/syncPharmacyStaffOdooAccess so a staff
      // caller resolves the OWNER's orgId (hc_pharmacy_{pharmacyId}), not a
      // nonexistent org keyed by their own uid.
      const pharmacyStaffPharmacyId = isPharmacyStaff
        ? pharmacyMembershipSnap.docs[0].ref.parent.parent.id
        : null;
      // Read directly off the SAME membership doc already fetched above —
      // no extra query. Commerce's staff session bootstrap (Phase 1D) gates
      // entirely on this: a staff caller without store_access must never
      // establish a Commerce session, exactly as one without an active
      // membership must never resolve isPharmacyStaff true.
      const pharmacyStaffStoreAccess = isPharmacyStaff
        ? (pharmacyMembershipSnap.docs[0].data().permissions || []).includes(
            "store_access",
          )
        : false;
      // Same normalized value syncPharmacyStaffOdooAccess used as the Odoo
      // `login` when it created/synced this staff member's ERP user (see
      // resolveStaffStoreAccess.js's own phoneNumber field) — sourced from
      // the SAME membership doc, so it is guaranteed to match byte-for-byte
      // unless the phone number was edited in Healthcare after the Odoo
      // user was first created (a separate, known gap — not handled here).
      // Lets Commerce resolve the staff member's OWN Odoo login
      // server-side, from their OWN verified uid, with zero client input.
      const pharmacyStaffPhoneNumber = isPharmacyStaff
        ? pharmacyMembershipSnap.docs[0].data().phoneNumber || null
        : null;

      let pharmacyProviderStatus = null;
      if (role === "pharmacy_provider") {
        const providerDoc = await db.collection("pharmacy_providers").doc(uid).get();
        pharmacyProviderStatus = providerDoc.exists
          ? normalizeStatus(providerDoc.data().status)
          : null;
      }

      // Phase 1B (Commerce Billing) — billing itself is owned by
      // medical_centers/{centerId}, never pharmacy_providers (see the
      // Phase 1B billing-ownership audit). Resolve the SAME centerId both
      // Commerce ERP functions already resolve for staff/owner: for an
      // owner, their own users/{uid}.centerId; for staff, the OWNER's
      // users/{pharmacyStaffPharmacyId}.centerId (one extra read, only when
      // a pharmacy membership was already found above).
      let pharmacyCommerceSubscriptionStatus = null;
      let pharmacyCommerceTrialStart = null;
      let pharmacyCommerceTrialEnds = null;
      let pharmacyCommerceGracePeriodEnds = null;
      let pharmacyCommerceTrialCompleted = false;
      let pharmacyCommercePlanId = null;
      let pharmacyCommercePlanVersion = null;
      let pharmacyCommerceBillingCycle = null;
      let pharmacyCommerceSubscriptionStart = null;
      let pharmacyCommerceSubscriptionEnd = null;
      let pharmacyCommerceNextBillingDate = null;
      let pharmacyCommerceLastPaymentAt = null;
      // Phase 1B optimization — lets Commerce's getCommercePharmacyStatus
      // detect "has anything changed since we last actually synced Odoo"
      // via a plain equality check, without ever caching the billing
      // DECISION itself (pharmacyCommerceSubscriptionStatus above is always
      // read fresh, every call, and is what the decision is always based
      // on). Written by both startCommerceTrial.js and the scheduled
      // expireCenters.js pass whenever commerceSubscriptionStatus changes.
      let pharmacyCommerceSubscriptionStatusSyncedAt = null;

      let ownerCenterId = null;
      if (role === "pharmacy_provider") {
        ownerCenterId = userDoc.exists ? userDoc.data().centerId || null : null;
      } else if (isPharmacyStaff && pharmacyStaffPharmacyId) {
        const ownerUserSnap = await db
          .collection("users")
          .doc(pharmacyStaffPharmacyId)
          .get();
        ownerCenterId = ownerUserSnap.exists
          ? ownerUserSnap.data().centerId || null
          : null;
      }

      if (ownerCenterId) {
        const centerSnap = await db
          .collection("medical_centers")
          .doc(ownerCenterId)
          .get();
        if (centerSnap.exists) {
          const centerData = centerSnap.data();
          pharmacyCommerceSubscriptionStatus =
            centerData.commerceSubscriptionStatus || null;
          pharmacyCommerceTrialStart = isoOrNull(centerData.commerceTrialStart);
          pharmacyCommerceTrialEnds = isoOrNull(centerData.commerceTrialEnds);
          pharmacyCommerceGracePeriodEnds = isoOrNull(centerData.commerceGracePeriodEnds);
          pharmacyCommerceTrialCompleted = centerData.commerceTrialCompleted === true;
          pharmacyCommercePlanId = centerData.commercePlanId || null;
          pharmacyCommercePlanVersion =
            typeof centerData.commercePlanVersion === "number"
              ? centerData.commercePlanVersion
              : null;
          pharmacyCommerceBillingCycle = centerData.commerceBillingCycle || null;
          pharmacyCommerceSubscriptionStart = isoOrNull(centerData.commerceSubscriptionStart);
          pharmacyCommerceSubscriptionEnd = isoOrNull(centerData.commerceSubscriptionEnd);
          pharmacyCommerceNextBillingDate = isoOrNull(centerData.commerceNextBillingDate);
          pharmacyCommerceLastPaymentAt = isoOrNull(centerData.commerceLastPaymentAt);
          pharmacyCommerceSubscriptionStatusSyncedAt = isoOrNull(
            centerData.commerceSubscriptionStatusSyncedAt,
          );
        }
      }

      res.status(200).json({
        uid,
        role,
        isPharmacyStaff,
        pharmacyProviderStatus,
        pharmacyStaffPharmacyId,
        pharmacyStaffStoreAccess,
        pharmacyStaffPhoneNumber,
        pharmacyCommerceSubscriptionStatus,
        pharmacyCommerceTrialStart,
        pharmacyCommerceTrialEnds,
        pharmacyCommerceGracePeriodEnds,
        pharmacyCommerceTrialCompleted,
        pharmacyCommercePlanId,
        pharmacyCommercePlanVersion,
        pharmacyCommerceBillingCycle,
        pharmacyCommerceSubscriptionStart,
        pharmacyCommerceSubscriptionEnd,
        pharmacyCommerceNextBillingDate,
        pharmacyCommerceLastPaymentAt,
        pharmacyCommerceSubscriptionStatusSyncedAt,
      });
    } catch (err) {
      console.error("[resolveAccessContext] internal error:", err);
      res.status(500).json({ error: "Internal error." });
    }
  },
);
