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
 *   - Writes only the three safe status fields + updatedAt (never clinical/result fields).
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
 * Pharmacy notification transitions:
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
    await referralRef.update({
      partnerStatus:        after.partnerStatus        ?? before.partnerStatus        ?? 'sent',
      status:               after.status               ?? before.status               ?? 'pending',
      patientReleaseStatus: after.patientReleaseStatus ?? before.patientReleaseStatus ?? 'unreleased',
      updatedAt: FieldValue.serverTimestamp(),
    });

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

    let toStage = null;
    if (before.partnerStatus === 'sent' && after.partnerStatus === 'received') {
      toStage = 'received';
    } else if (before.partnerStatus === 'preparing' && after.partnerStatus === 'ready') {
      toStage = 'ready';
    } else if (before.partnerStatus === 'ready' && after.partnerStatus === 'dispensed') {
      toStage = 'dispensed';
    }

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
