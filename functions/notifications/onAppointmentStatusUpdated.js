'use strict';

/**
 * onAppointmentStatusUpdated
 *
 * TrustyDr Workflow & Notification Platform, Phase 4 (see
 * NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root). This is a NEW
 * trigger -- no equivalent notification logic existed for appointment
 * status/visitStatus changes before this phase (confirmed by audit: no
 * onDocumentUpdated/onDocumentCreated on 'appointments/' anywhere in this
 * repo, no notifications-collection write tied to an appointment status
 * transition, prior to this file). It reuses ONLY the real, already-
 * implemented status values (see
 * lib/notificationPlatform/workflows/appointmentWorkflow.js's own header for
 * the full mapping) -- no new statuses invented. This file never writes
 * back to `appointments` itself; it only reads the document and calls
 * emitWorkflowEvent, which resolves the registered "appointment"
 * WorkflowDefinition and updates ONE stable notification document per
 * appointment (`wf_appointment_{appointmentId}`).
 *
 * Booking, reception/check-in, waiting-room, visit-completion, and
 * cancellation/no-show logic all remain exactly as they are (in
 * doctor_portal's center_repo.dart / appointment_lifecycle_controller.dart
 * and wherever patient self-booking/cancellation lives) -- this file is a
 * pure downstream listener, per the platform's Workflow/Notification
 * separation principle.
 *
 * Recipient resolution matches the existing convention already used by
 * reminders/sendDailyReminders.js and reminders/sendSameDayReminders.js:
 * bookedByUserId when it differs from patientId (family/staff booking),
 * otherwise patientId.
 *
 * Appointment REMINDERS (2-day/1-day/same-day) are a separate, independent,
 * scheduled system and are explicitly NOT touched or folded into this
 * workflow -- they remain their own event notifications, untouched.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { emitWorkflowEvent } = require('../lib/notificationPlatform/notificationEngine');
// Required for its side effect: registers the 'appointment'
// WorkflowDefinition with the Workflow Registry.
require('../lib/notificationPlatform/workflows/appointmentWorkflow');

// Priority order matters: a single trigger invocation can carry more than
// one field change at once (e.g. visitStatus 'done' also flips status to
// 'completed' in the SAME write -- appointment_lifecycle_controller.dart's
// updateVisitStatus) -- exactly ONE stage is ever derived and emitted per call.
function deriveToStage(before, after) {
  if (before.status !== 'cancelled' && after.status === 'cancelled') return 'cancelled';
  if (before.visitStatus !== 'no_show' && after.visitStatus === 'no_show') return 'no_show';
  if (before.visitStatus !== 'done' && after.visitStatus === 'done') return 'done';
  if (before.visitStatus !== 'in_service' && after.visitStatus === 'in_service') return 'in_service';
  if (before.status !== 'confirmed' && after.status === 'confirmed') return 'confirmed';
  return null;
}
// Exported for the offline unit test (scripts/test_notification_engine.js)
// only -- not part of the public Cloud Functions surface.
exports._deriveToStage = deriveToStage;

exports.onAppointmentStatusUpdated = onDocumentUpdated(
  'appointments/{appointmentId}',
  async (event) => {
    const db            = getFirestore();
    const appointmentId = event.params.appointmentId;
    const before         = event.data.before.data();
    const after          = event.data.after.data();

    // Early-exit: neither field this workflow cares about changed.
    if (before.status === after.status && before.visitStatus === after.visitStatus) return;

    const toStage = deriveToStage(before, after);
    if (!toStage) return;

    const patientId       = after.patientId || before.patientId;
    const bookedByUserId   = after.bookedByUserId || before.bookedByUserId;
    const recipientUid =
      bookedByUserId && bookedByUserId !== patientId ? bookedByUserId : patientId;
    if (!recipientUid) return;

    const doctorNameEn =
      after.doctorName_en || before.doctorName_en || after.doctorName || before.doctorName || '';
    const doctorNameAr =
      after.doctorName_ar || before.doctorName_ar || after.doctorName || before.doctorName || '';
    const doctorNameKu =
      after.doctorName_ku || before.doctorName_ku || after.doctorName || before.doctorName || '';

    await emitWorkflowEvent(db, {
      workflowType: 'appointment',
      entityId: appointmentId,
      recipientUid,
      toStage,
      contentContext: { doctorNameEn, doctorNameAr, doctorNameKu, toStage },
    });

    console.log(
      `onAppointmentStatusUpdated: emitted appointment/${appointmentId} -> ${toStage} recipient=${recipientUid}`,
    );
  },
);
