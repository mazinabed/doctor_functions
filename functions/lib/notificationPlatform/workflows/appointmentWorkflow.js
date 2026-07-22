'use strict';

const { registerWorkflow } = require('../workflowRegistry');
const { PRIORITY, CHANNEL } = require('../constants');

// Appointment Workflow -- Phase 4 of the TrustyDr Workflow & Notification
// Platform (see NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root).
// Fourth WorkflowDefinition registered (after marketplace_order,
// prescription, lab_order) -- again, zero changes needed to
// notificationEngine.js or workflowRegistry.js to support it.
//
// IMPORTANT, unlike the first three migrations: no Cloud Function trigger or
// notification content existed for appointment status/visitStatus changes
// before this phase -- confirmed by an exhaustive audit (no
// onDocumentUpdated/onDocumentCreated on 'appointments/' anywhere in this
// repo, no notifications-collection write tied to an appointment status
// transition, prior to this phase). This is genuinely NEW notification-
// emitting capability, not a refactor of existing logic -- but it follows
// the identical architectural pattern (thin adapter -> emitWorkflowEvent ->
// registered WorkflowDefinition) and reuses ONLY the real, already-
// implemented status values (BookingStatus / VisitStatus in doctor_portal's
// lib/core/constants/appointment_status.dart) -- no new status values
// invented.
//
// Stages map directly onto the existing state machine:
//   status:      pending -> confirmed -> completed | cancelled
//   visitStatus:              waiting -> in_service -> done | no_show
// ('done' also flips status to 'completed' in the SAME write --
// appointment_lifecycle_controller.dart's updateVisitStatus -- the adapter
// (onAppointmentStatusUpdated.js) only ever derives ONE stage per trigger
// invocation, never both.)
//
// 'waiting' is a real VisitStatus value but is only ever observed as an
// INITIAL value set at appointment creation (center_repo.dart's booking
// flow uses .add(), not .update(), so no onDocumentUpdated trigger fires on
// it) -- never reached via a genuine update transition anywhere in the
// current codebase. It is intentionally not wired as a notifying stage
// here: nothing invented, simply nothing to trigger on yet. A future flow
// that genuinely transitions INTO 'waiting' via update can add it as a
// stage the same way any future workflow stage is added, without touching
// the engine or this adapter's overall shape.
function names(ctx) {
  return {
    en: (ctx && ctx.doctorNameEn) || '',
    ar: (ctx && ctx.doctorNameAr) || '',
    ku: (ctx && ctx.doctorNameKu) || '',
  };
}

registerWorkflow({
  workflowType: 'appointment',
  entityCollection: 'appointments',

  navigationTarget: (appointmentId) => ({
    route: 'appointment_detail',
    params: { appointmentId },
  }),

  // No prior notification type existed for this domain, so there is no old
  // client behavior to "preserve" the way Marketplace/Prescription/Lab
  // needed to. These fields exist so this NEW type slots into the SAME
  // generic shape (type/subtype/appointmentId/doctorName_*) the
  // Notification Center already renders, reusing the exact field names
  // `appointment_reminder` notifications already use for doctor name and
  // appointmentId-based routing (see notifications.dart).
  legacyFields: (appointmentId, ctx) => ({
    type: 'appointment_status',
    subtype: ctx.toStage,
    appointmentId,
    doctorName_en: (ctx && ctx.doctorNameEn) || '',
    doctorName_ar: (ctx && ctx.doctorNameAr) || '',
    doctorName_ku: (ctx && ctx.doctorNameKu) || '',
  }),

  stages: {
    confirmed: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = names(ctx);
        return {
          titleEn: 'Appointment confirmed',
          titleAr: 'تم تأكيد الموعد',
          titleKu: 'کاتی چاوپێکەوتن پشتڕاستکرایەوە',
          bodyEn: `Your appointment with ${en || 'the doctor'} has been confirmed.`,
          bodyAr: `تم تأكيد موعدك مع ${ar || 'الطبيب'}.`,
          bodyKu: `کاتی چاوپێکەوتنت لەگەڵ ${ku || 'پزیشک'} پشتڕاستکرایەوە.`,
        };
      },
    },
    in_service: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = names(ctx);
        return {
          titleEn: 'Your visit has started',
          titleAr: 'بدأت زيارتك',
          titleKu: 'سەردانەکەت دەستی پێکرد',
          bodyEn: `You're now being seen by ${en || 'the doctor'}.`,
          bodyAr: `أنت الآن قيد الفحص من قبل ${ar || 'الطبيب'}.`,
          bodyKu: `تۆ ئێستا لەلایەن ${ku || 'پزیشک'} دەبینرێیت.`,
        };
      },
    },
    done: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      isCompleted: true,
      terminal: true,
      buildContent: (ctx) => {
        const { en, ar, ku } = names(ctx);
        return {
          titleEn: 'Visit completed',
          titleAr: 'اكتملت الزيارة',
          titleKu: 'سەردان تەواو بوو',
          bodyEn: `Your visit with ${en || 'the doctor'} is complete. Thank you!`,
          bodyAr: `اكتملت زيارتك مع ${ar || 'الطبيب'}. شكراً لك!`,
          bodyKu: `سەردانەکەت لەگەڵ ${ku || 'پزیشک'} تەواو بوو. سوپاس!`,
        };
      },
    },
    no_show: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      buildContent: (ctx) => {
        const { en, ar, ku } = names(ctx);
        return {
          titleEn: 'Marked as no-show',
          titleAr: 'تم تسجيلك كغياب عن الموعد',
          titleKu: 'وەک نەهاتوو تۆمارکرا',
          bodyEn: `You were marked as a no-show for your appointment with ${en || 'the doctor'}.`,
          bodyAr: `تم تسجيلك كغياب عن موعدك مع ${ar || 'الطبيب'}.`,
          bodyKu: `تۆ وەک نەهاتوو بۆ کاتی چاوپێکەوتنت لەگەڵ ${ku || 'پزیشک'} تۆمارکرایت.`,
        };
      },
    },
    cancelled: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      buildContent: (ctx) => {
        const { en, ar, ku } = names(ctx);
        return {
          titleEn: 'Appointment cancelled',
          titleAr: 'تم إلغاء الموعد',
          titleKu: 'کاتی چاوپێکەوتن هەڵوەشێنرایەوە',
          bodyEn: `Your appointment with ${en || 'the doctor'} was cancelled.`,
          bodyAr: `تم إلغاء موعدك مع ${ar || 'الطبيب'}.`,
          bodyKu: `کاتی چاوپێکەوتنت لەگەڵ ${ku || 'پزیشک'} هەڵوەشێنرایەوە.`,
        };
      },
    },
  },
});

module.exports = {};
