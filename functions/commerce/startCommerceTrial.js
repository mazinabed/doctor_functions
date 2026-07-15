// TrustyDr Commerce Bridge — Phase 1B (Commerce Billing).
//
// The FIRST write-capable Commerce↔Healthcare bridge function. Every other
// bridge function in this directory (resolveAccessContext, resolveStaffStoreAccess)
// is read-only by design. This one exists because billing itself is owned by
// Healthcare (medical_centers/{centerId} — see the Phase 1B billing-ownership
// audit), so the moment Commerce's own "Enable Store" flow completes, it must
// ask Healthcare to actually start the Commerce trial clock — Commerce itself
// has no write access to Healthcare's Firestore project.
//
// Security (mirrors activateCommerceForOrganization's own owner-only guard,
// doctor_functions equivalent of that Commerce-side rule):
//   1. idToken must verify to a real Healthcare user.
//   2. That user's users/{uid}.role must be 'pharmacy_provider' — a staff
//      idToken is rejected before any Firestore read. Staff must never be
//      able to start or reset a pharmacy's Commerce trial clock.
//   3. The owner must already have a medical_centers doc (users/{uid}.centerId)
//      — Commerce trial start does not create a facility; per the finalized
//      architecture, facility creation stays a separate, manual, unchanged
//      "Create Facility" step.
//
// Idempotent: if commerceTrialStart is already set, OR the pharmacy has
// already left the 'none' state (migration-grandfathered pharmacies land
// directly on 'active' with no trial dates at all), this is a no-op that
// just returns the current values — a retried "Enable Store" call, or a
// disable/re-enable cycle for an already-active pharmacy, can never reset
// or downgrade the clock.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const TRIAL_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
// Fixed 7-day grace period — a system computation, never admin-set, per
// the finalized Commerce billing decisions. Precomputed here (and again at
// the moment a paid renewal sets commerceSubscriptionEnd, in the payment-
// approval flow) rather than derived reactively by the scheduled expiry
// job — the grace end is a deterministic function of whichever anchor date
// was just set, known immediately.
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

exports.startCommerceTrial = onRequest(
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
      const userSnap = await db.collection("users").doc(uid).get();
      const role = userSnap.exists ? userSnap.data().role : null;

      // Owner-only — mirrors activateCommerceForOrganization's own rule.
      // Staff never resolve role === 'pharmacy_provider' for themselves.
      if (role !== "pharmacy_provider") {
        res.status(403).json({
          error: "Only the pharmacy owner can start the Commerce trial.",
        });
        return;
      }

      const centerId = userSnap.data().centerId;
      if (!centerId) {
        // Store can only ever be enabled from a dashboard that already
        // required a facility to exist (Store tab lives inside
        // CenterDashboardPage, gated on hasCenter) — this should be
        // unreachable in practice, not a normal-path branch.
        res.status(409).json({
          error: "Pharmacy has no facility yet. Create Facility first.",
        });
        return;
      }

      const centerRef = db.collection("medical_centers").doc(centerId);
      const centerSnap = await centerRef.get();
      if (!centerSnap.exists) {
        res.status(404).json({ error: "Facility document not found." });
        return;
      }

      const data = centerSnap.data();
      const alreadyStarted =
        data.commerceTrialStart != null ||
        (data.commerceSubscriptionStatus != null &&
          data.commerceSubscriptionStatus !== "none");

      if (alreadyStarted) {
        res.status(200).json({
          centerId,
          commerceSubscriptionStatus: data.commerceSubscriptionStatus || null,
          commerceTrialStart: data.commerceTrialStart || null,
          commerceTrialEnds: data.commerceTrialEnds || null,
          commerceGracePeriodEnds: data.commerceGracePeriodEnds || null,
          commerceTrialCompleted: data.commerceTrialCompleted === true,
          created: false,
        });
        return;
      }

      const now = admin.firestore.Timestamp.now();
      const trialEnds = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + TRIAL_DURATION_MS,
      );
      const gracePeriodEnds = admin.firestore.Timestamp.fromMillis(
        trialEnds.toMillis() + GRACE_PERIOD_MS,
      );

      await centerRef.update({
        commerceSubscriptionStatus: "trial",
        commerceTrialStart: now,
        commerceTrialEnds: trialEnds,
        commerceGracePeriodEnds: gracePeriodEnds,
        commerceTrialCompleted: false,
        commerceSubscriptionStatusSyncedAt: now,
      });

      res.status(200).json({
        centerId,
        commerceSubscriptionStatus: "trial",
        commerceTrialStart: now,
        commerceTrialEnds: trialEnds,
        commerceGracePeriodEnds: gracePeriodEnds,
        commerceTrialCompleted: false,
        created: true,
      });
    } catch (err) {
      console.error("[startCommerceTrial] internal error:", err);
      res.status(500).json({ error: "Internal error." });
    }
  },
);
