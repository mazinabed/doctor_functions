'use strict';

/**
 * onClinicalReferralStatusUpdated
 *
 * Mirrors safe status fields from clinical_requests into patient_referral_requests
 * whenever partnerStatus, status, or patientReleaseStatus changes.
 *
 * Design:
 *   - Only processes documents that have a patient_referral_requests counterpart.
 *   - Early-exits if none of the three status fields changed (no unnecessary writes).
 *   - Writes only the three safe status fields + updatedAt, plus `dispensedAt`
 *     when the pharmacy has set it (never clinical/result fields, and never
 *     `dispensedByUid` — that is staff identity, not patient information).
 *   - Pharmacy-only: emits patient notifications on 3 transitions via the
 *     TrustyDr Workflow & Notification Platform's shared Notification Engine
 *     (see NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root -- Phase 3
 *     migration). This file still owns NO notification content/Firestore/FCM
 *     logic itself; it only detects the transition and calls emitWorkflowEvent,
 *     which resolves the registered "prescription" WorkflowDefinition
 *     (lib/notificationPlatform/workflows/prescriptionWorkflow.js) and updates
 *     ONE stable notification document per request (`wf_prescription_{requestId}`)
 *     -- previously each of the 3 transitions below wrote its OWN separate
 *     document (rx_received_/rx_ready_/rx_dispensed_<id>), the same "one
 *     notification per stage" pattern Marketplace had before its own Phase 1 fix.
 *
 * Pharmacy notification transitions (selected by destination status, so a
 * skipped intermediate state such as received->ready still notifies):
 *   sent      → received  : "[Pharmacy] received your prescription."
 *   preparing → ready     : "Your prescription is ready for pickup at [Pharmacy]."
 *   ready     → dispensed : "Your prescription was dispensed by [Pharmacy]."
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { emitWorkflowEvent } = require('../lib/notificationPlatform/notificationEngine');
// Required for its side effect: registers the 'prescription'
// WorkflowDefinition with the Workflow Registry.
require('../lib/notificationPlatform/workflows/prescriptionWorkflow');

/// partnerStatus -> prescription workflow stage.
///
/// Keyed by DESTINATION so a pharmacy that skips a step still notifies; any
/// status not listed here (scheduled, checkedIn, noShow - the lab/imaging
/// vocabulary) is deliberately absent and produces no patient notification.
const STATUS_TO_STAGE = {
  sent: 'sent',
  received: 'received',
  preparing: 'preparing',
  ready: 'ready',
  dispensed: 'dispensed',
  cancelled: 'cancelled',
};

/// The stage a transition should emit, or null when it should not notify.
function stageForTransition(beforeStatus, afterStatus) {
  if (!afterStatus || afterStatus === beforeStatus) return null;
  return STATUS_TO_STAGE[afterStatus] || null;
}

const STATUS_FIELDS = ['partnerStatus', 'status', 'patientReleaseStatus'];

exports.onClinicalReferralStatusUpdated = onDocumentUpdated(
  'clinical_requests/{requestId}',
  async (event) => {
    const db        = getFirestore();
    const requestId = event.params.requestId;
    const before    = event.data.before.data();
    const after     = event.data.after.data();

    // Early-exit: skip if none of the three status fields changed
    const changed = STATUS_FIELDS.some((f) => before[f] !== after[f]);
    if (!changed) return;

    // Only process if a patient_referral_requests doc exists for this request
    const referralRef  = db.collection('patient_referral_requests').doc(requestId);
    const referralSnap = await referralRef.get();
    if (!referralSnap.exists) return;

    // Mirror only safe status fields — never clinical or result fields
    const mirrored = {
      partnerStatus:        after.partnerStatus        ?? before.partnerStatus        ?? 'sent',
      status:               after.status               ?? before.status               ?? 'pending',
      patientReleaseStatus: after.patientReleaseStatus ?? before.patientReleaseStatus ?? 'unreleased',
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Durable fulfillment fact: WHEN the prescription was dispensed.
    //
    // The pharmacy writes `dispensedAt` on clinical_requests at dispense time,
    // but the mirror copied only the three status fields, so the patient-safe
    // projection knew a prescription was dispensed and never when. Combined
    // with partnerProviderId and partnerName_{en,ar,ku} — both already
    // projected at creation — the patient copy now holds the complete
    // "filled by X on date Y" record that fulfillment history will need.
    //
    // Copied only when present, so a status change that is not a dispense
    // never overwrites an existing timestamp with null.
    //
    // `dispensedByUid` is deliberately NOT mirrored: it identifies the
    // individual pharmacy employee, the patient has no use for it, and the
    // projection is patient-readable.
    if (after.dispensedAt) {
      mirrored.dispensedAt = after.dispensedAt;
    }

    await referralRef.update(mirrored);

    console.log(
      `onClinicalReferralStatusUpdated: mirrored ${requestId}` +
      ` partnerStatus=${before.partnerStatus}→${after.partnerStatus}` +
      ` status=${before.status}→${after.status}` +
      ` patientReleaseStatus=${before.patientReleaseStatus}→${after.patientReleaseStatus}`,
    );

    // ── Pharmacy-only patient notifications ───────────────────────────────────
    // Gate: only run for pharmacy prescriptions. serviceGroup is written by
    // onClinicalReferralCreated and mirrors data.serviceCategory.
    const referralData = referralSnap.data();
    if (referralData.serviceGroup !== 'pharmacy' || !referralData.patientId) return;

    const patientId = referralData.patientId;

    // Selected by DESTINATION status, not by (before, after) pairs.
    //
    // The pairwise form missed real transitions: a pharmacy with the stock on
    // hand goes received -> ready without passing through `preparing`, and the
    // old `before === 'preparing'` guard meant the patient was never told the
    // prescription was ready. It also had no branch at all for `preparing` or
    // `cancelled`, both of which the portal writes.
    //
    // Mapping on the destination means every meaningful state notifies once,
    // however the pharmacy got there. Re-entry is safe: emitWorkflowEvent
    // skips when the workflow document is already at this stage, so a retried
    // trigger or an unrelated field update never re-notifies.
    const toStage = stageForTransition(before.partnerStatus, after.partnerStatus);

    if (!toStage) return;

    await emitWorkflowEvent(db, {
      workflowType: 'prescription',
      entityId: requestId,
      recipientUid: patientId,
      toStage,
      contentContext: {
        partnerNameEn: referralData.partnerName_en || referralData.partnerName_ar || '',
        partnerNameAr: referralData.partnerName_ar || referralData.partnerName_en || '',
        partnerNameKu: referralData.partnerName_ku || referralData.partnerName_en || '',
        toStage,
      },
    });

    console.log(
      `onClinicalReferralStatusUpdated: emitted prescription/${requestId} ` +
      `${before.partnerStatus}->${after.partnerStatus}`,
    );
  },
);

// Exported for unit tests; the trigger export above is unchanged.
module.exports.STATUS_TO_STAGE = STATUS_TO_STAGE;
module.exports.stageForTransition = stageForTransition;
