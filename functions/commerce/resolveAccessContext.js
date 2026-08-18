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
const { getLegalConfig } = require("../legal/legalConfig");

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

// Phone-verification bridge correction (2026-08-18) — pure extraction (same
// discipline as resolveHealthcareLegalCoverage below) so this one-line
// decision is unit-testable without an emulator or a real ID token. `decoded`
// is the ALREADY-VERIFIED result of admin.auth().verifyIdToken() — Firebase
// Phone Auth only ever populates phone_number on a token after a real OTP
// verification, so this is authoritative by construction, never a
// client-supplied or Firestore-cached value.
function resolveVerifiedPhoneNumber(decoded) {
  return (decoded && decoded.phone_number) || null;
}

exports.resolveVerifiedPhoneNumber = resolveVerifiedPhoneNumber;

// Legal Consent Modernization (Phase 3 — Healthcare→Commerce bridge
// entitlement). Read-only, resolved FRESH on every call directly from the
// same facility doc Phase 2's acceptFacilityLegalAgreement writes to
// (functions/legal/facilityLegalConsent.js) — this is NOT a second consent
// system. Healthcare's legalAcceptances/legalHistory on the facility doc
// remain the sole source of truth; only a computed current/not-current
// boolean ever crosses the bridge, and it is never cached or duplicated
// into Commerce (matches the same "the DECISION is always read fresh,
// every call, never cached" discipline this file already uses for
// pharmacyCommerceSubscriptionStatus).
//
// Resolved against the REAL facility doc per type — deliberately NOT
// through the medical_centers/centerId indirection the pharmacy billing
// fields above rely on. That indirection is known-unreliable for pharmacy/
// lab owners (_createFacilityForProvider fails or orphans its target doc
// for those two provider kinds — see the org-architecture audit), so this
// bridge would silently under-report coverage for exactly the population
// most likely to need it if it reused that path:
//   medical_center → medical_centers/{centerId}   (ownerId field)
//   pharmacy       → pharmacy_providers/{uid}      (identity == facility)
//   lab            → diagnostic_providers/{uid}    (identity == facility)
//
// Scope note: only pharmacy owner/staff origination is a LIVE Commerce
// activation path today (this file's own Milestone 2A header). Medical
// center and lab resolution are included now so the bridge is correct and
// complete per facility type the moment Commerce supports them, without a
// second migration later — but are owner-only for now (no lab_members/
// center members staff-delegation query added here yet, since no live
// Commerce caller exercises that path).
function buildLegalCoverage(facilityType, facilitySnap, currentVersion, acceptanceKey) {
  if (!facilitySnap || !facilitySnap.exists) {
    return { facilityType, current: false, version: currentVersion };
  }
  const acceptances = facilitySnap.data().legalAcceptances || {};
  const record = acceptances[acceptanceKey];
  const current = !!record && record.accepted === true && record.version === currentVersion;
  return { facilityType, current, version: currentVersion };
}

async function resolveHealthcareLegalCoverage({
  db,
  uid,
  role,
  isPharmacyStaff,
  pharmacyStaffPharmacyId,
  // Phase 4B.2 (2026-08-17) — optional, pre-resolved owned-center snapshot.
  // The main handler now resolves this ONCE (it also needs ownedCenterId/
  // doctorClinicName for Commerce activation eligibility, not just legal
  // coverage) and passes it in here so this function never re-queries
  // medical_centers a second time for the same caller. Omitted entirely by
  // any other caller of this function (none exist today) falls back to the
  // original inline query, preserving this function's own standalone
  // correctness.
  ownedCenterSnap: precomputedOwnedCenterSnap,
}) {
  const legalConfig = await getLegalConfig();

  if (role === "pharmacy_provider" || (isPharmacyStaff && pharmacyStaffPharmacyId)) {
    const pharmacyId = role === "pharmacy_provider" ? uid : pharmacyStaffPharmacyId;
    const snap = await db.collection("pharmacy_providers").doc(pharmacyId).get();
    return buildLegalCoverage(
      "pharmacy",
      snap,
      legalConfig.pharmacyAgreementVersion,
      "pharmacyAgreement",
    );
  }

  if (role === "diagnostic_provider") {
    const snap = await db.collection("diagnostic_providers").doc(uid).get();
    return buildLegalCoverage("lab", snap, legalConfig.labAgreementVersion, "labAgreement");
  }

  // Doctor / center-affiliated roles: resolve the center this caller OWNS,
  // if any — a direct ownerId query, not the possibly-stale
  // users/{uid}.centerId field, so this never depends on that field being
  // populated correctly.
  const ownedCenterSnap =
    precomputedOwnedCenterSnap !== undefined
      ? precomputedOwnedCenterSnap
      : await db.collection("medical_centers").where("ownerId", "==", uid).limit(1).get();
  if (!ownedCenterSnap.empty) {
    return buildLegalCoverage(
      "medical_center",
      ownedCenterSnap.docs[0],
      legalConfig.medicalCenterAgreementVersion,
      "medicalCenterAgreement",
    );
  }

  // No Healthcare-origin facility resolved for this caller — Commerce
  // treats this as "no Healthcare legal coverage applies" and falls back
  // to its own normal Commerce Merchant Agreement flow for that org.
  return { facilityType: null, current: false, version: null };
}

exports.resolveHealthcareLegalCoverage = resolveHealthcareLegalCoverage;

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
    // Commerce uses this (see trustydr-commerce/functions/src/activation.ts)
    // to reconcile the SAME verified phone onto the bridged Commerce Auth
    // user, so a Healthcare-origin provider's phone-verification gate
    // reflects an identity Healthcare has actually verified, not a client
    // claim.
    const phoneNumber = resolveVerifiedPhoneNumber(decoded);
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
      // Store Activation State Audit — Checkpoint (2026-07-27): the pharmacy's
      // real registered business name, so Commerce's activateCommerceForOrganization
      // can name the new Odoo tenant company correctly instead of a generic
      // placeholder. English only (Odoo's res.company.name has no per-language
      // variants) — matches provisionOwnerUser's own precedent of resolving one
      // definite value per field, with localization handled separately (the
      // `lang` param) rather than threaded through this one.
      //
      // Regression fix (2026-07-27): this originally read clinicName_en, which
      // only ever exists on the doctors/{uid} draft — pharmacy_providers/{uid}
      // (the document actually being read here) stores the pharmacy's business
      // name as facilityName_en (written by the doctor-to-pharmacy onboarding
      // conversion in doctor_portal's doctor_onboarding_controller.dart). The
      // wrong field name meant this was always null, silently falling back to
      // the "My Pharmacy" placeholder for every pharmacy.
      let pharmacyClinicName = null;
      if (role === "pharmacy_provider") {
        const providerDoc = await db.collection("pharmacy_providers").doc(uid).get();
        pharmacyProviderStatus = providerDoc.exists
          ? normalizeStatus(providerDoc.data().status)
          : null;
        pharmacyClinicName = providerDoc.exists
          ? providerDoc.data().facilityName_en || null
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

      // Phase 4B.2 (Healthcare <-> Commerce Bridge Generalization,
      // 2026-08-17) — resolved once here (not duplicated inside
      // resolveHealthcareLegalCoverage below) for the two NEW roles the
      // bridge now supports: diagnostic_provider (lab) and doctor
      // (medical_center owner). Both null/false for a pharmacy_provider or
      // pharmacy-staff caller — these fields are only ever meaningful for
      // their own role.
      let labProviderStatus = null;
      let labFacilityName = null;
      if (role === "diagnostic_provider") {
        const labDoc = await db.collection("diagnostic_providers").doc(uid).get();
        labProviderStatus = labDoc.exists ? normalizeStatus(labDoc.data().status) : null;
        labFacilityName = labDoc.exists ? labDoc.data().facilityName_en || null : null;
      }

      let doctorIsVerified = false;
      let doctorClinicName = null;
      let ownedCenterId = null;
      let ownedCenterSnap = undefined;
      if (role === "doctor") {
        const doctorDoc = await db.collection("doctors").doc(uid).get();
        doctorIsVerified = doctorDoc.exists && doctorDoc.data().isVerified === true;
        doctorClinicName = doctorDoc.exists
          ? doctorDoc.data().clinicName_en || doctorDoc.data().clinicName || null
          : null;

        // Same "the center this caller OWNS" ownerId query
        // resolveHealthcareLegalCoverage below would otherwise run itself —
        // resolved ONCE here and passed down, so a doctor caller never
        // costs two medical_centers queries for one request.
        ownedCenterSnap = await db
          .collection("medical_centers")
          .where("ownerId", "==", uid)
          .limit(1)
          .get();
        ownedCenterId = !ownedCenterSnap.empty ? ownedCenterSnap.docs[0].id : null;
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

      const healthcareLegalCoverage = await resolveHealthcareLegalCoverage({
        db,
        uid,
        role,
        isPharmacyStaff,
        pharmacyStaffPharmacyId,
        ownedCenterSnap,
      });

      res.status(200).json({
        uid,
        role,
        phoneNumber,
        isPharmacyStaff,
        pharmacyProviderStatus,
        pharmacyClinicName,
        pharmacyStaffPharmacyId,
        pharmacyStaffStoreAccess,
        pharmacyStaffPhoneNumber,
        labProviderStatus,
        labFacilityName,
        doctorIsVerified,
        doctorClinicName,
        ownedCenterId,
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
        healthcareLegalCoverageFacilityType: healthcareLegalCoverage.facilityType,
        healthcareLegalCoverageCurrent: healthcareLegalCoverage.current,
        healthcareLegalCoverageVersion: healthcareLegalCoverage.version,
      });
    } catch (err) {
      console.error("[resolveAccessContext] internal error:", err);
      res.status(500).json({ error: "Internal error." });
    }
  },
);
