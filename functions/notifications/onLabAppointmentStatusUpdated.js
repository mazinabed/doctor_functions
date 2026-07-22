'use strict';

/**
 * onLabAppointmentStatusUpdated
 *
 * TrustyDr Workflow & Notification Platform, Phase 3 migration (see
 * NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root). Triggered when
 * a patient-booked lab/imaging clinical_request is updated. This file no
 * longer builds notification content or writes Firestore/FCM directly -- it
 * only detects the transition and calls the shared Notification Engine's
 * emitWorkflowEvent, which resolves the registered "lab_order"
 * WorkflowDefinition (lib/notificationPlatform/workflows/labOrderWorkflow.js)
 * and updates ONE stable notification document per request
 * (`wf_lab_order_{requestId}`).
 *
 * Guards (evaluated against the BEFORE snapshot):
 *   requestDestination == 'partner'
 *   source             == 'scheduled'
 *   createdByRole      == 'patient'
 *   patientId          exists
 *
 * Early-exit: if partnerStatus did not change, nothing to notify.
 *
 * Handled transitions:
 *   pendingApproval → scheduled   stage='scheduled'  (subtype='confirmed')
 *   any             → cancelled   stage='cancelled'  (subtype='cancelled')
 *   any             → rejected    stage='rejected'   (subtype='cancelled', same content as cancelled)
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { emitWorkflowEvent } = require('../lib/notificationPlatform/notificationEngine');
// Required for its side effect: registers the 'lab_order' WorkflowDefinition
// with the Workflow Registry.
require('../lib/notificationPlatform/workflows/labOrderWorkflow');

exports.onLabAppointmentStatusUpdated = onDocumentUpdated(
  'clinical_requests/{requestId}',
  async (event) => {
    const db        = getFirestore();
    const requestId = event.params.requestId;
    const before    = event.data.before.data();
    const after     = event.data.after.data();

    // Guard: patient self-booked lab/imaging appointments only.
    // Check both before and after to catch edge-cases where the field itself changed.
    if (
      before.requestDestination !== 'partner' ||
      before.source             !== 'scheduled' ||
      before.createdByRole      !== 'patient'   ||
      !before.patientId
    ) {
      return;
    }

    // Early-exit: only act when partnerStatus actually changed
    if (before.partnerStatus === after.partnerStatus) return;

    const patientId  = after.patientId || before.patientId;
    const nameEn     = after.providerName_en || before.providerName_en || '';
    const nameAr     = after.providerName_ar || before.providerName_ar || '';
    const nameKu     = after.providerName_ku || before.providerName_ku || '';
    const newStatus  = after.partnerStatus || '';
    const prevStatus = before.partnerStatus || '';

    let toStage = null;
    if (prevStatus === 'pendingApproval' && newStatus === 'scheduled') {
      toStage = 'scheduled';
    } else if (
      prevStatus !== 'cancelled' &&
      prevStatus !== 'rejected'  &&
      (newStatus === 'cancelled' || newStatus === 'rejected')
    ) {
      toStage = newStatus; // 'cancelled' or 'rejected'
    }

    // No relevant transition — nothing to notify
    if (!toStage) {
      console.log(
        `onLabAppointmentStatusUpdated: no notification for` +
        ` ${requestId} ${prevStatus}→${newStatus}`,
      );
      return;
    }

    const reason = after.cancellationReason || after.cancelledReason || '';

    await emitWorkflowEvent(db, {
      workflowType: 'lab_order',
      entityId: requestId,
      recipientUid: patientId,
      toStage,
      contentContext: {
        providerNameEn: nameEn,
        providerNameAr: nameAr,
        providerNameKu: nameKu,
        reason,
        toStage,
      },
    });

    console.log(
      `onLabAppointmentStatusUpdated: emitted lab_order/${requestId} ${prevStatus}->${newStatus}`,
    );
  },
);
