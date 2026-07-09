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

      let pharmacyProviderStatus = null;
      if (role === "pharmacy_provider") {
        const providerDoc = await db.collection("pharmacy_providers").doc(uid).get();
        pharmacyProviderStatus = providerDoc.exists
          ? normalizeStatus(providerDoc.data().status)
          : null;
      }

      res.status(200).json({ uid, role, isPharmacyStaff, pharmacyProviderStatus });
    } catch (err) {
      console.error("[resolveAccessContext] internal error:", err);
      res.status(500).json({ error: "Internal error." });
    }
  },
);
