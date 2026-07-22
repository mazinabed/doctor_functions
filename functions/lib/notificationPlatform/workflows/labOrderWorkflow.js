'use strict';

const { registerWorkflow } = require('../workflowRegistry');
const { PRIORITY, CHANNEL } = require('../constants');

// Laboratory Workflow -- Phase 3 migration of the TrustyDr Workflow &
// Notification Platform (see NOTIFICATION_PLATFORM_PROGRESS.md at the
// ecosystem root). Third WorkflowDefinition registered (after
// marketplace_order in Phase 1 and prescription earlier in Phase 3).
//
// Stage content migrated verbatim from the previous
// notifications/onLabAppointmentStatusUpdated.js buildConfirmedContent/
// buildCancelledContent. `cancelled` and `rejected` are kept as two
// distinct stage keys (both terminal/isCancelled, both sharing the same
// content) rather than normalized into one -- this preserves the real
// underlying partnerStatus value in `currentStage` instead of losing that
// distinction, while still not duplicating the notification copy.
function providerNames(ctx) {
  return {
    en: (ctx && ctx.providerNameEn) || '',
    ar: (ctx && ctx.providerNameAr) || '',
    ku: (ctx && ctx.providerNameKu) || '',
  };
}

function buildCancelledContent(ctx) {
  const { en, ar, ku } = providerNames(ctx);
  const reason = (ctx && ctx.reason) || '';
  const reasonEn = reason ? ` Reason: ${reason}` : '';
  const reasonAr = reason ? ` السبب: ${reason}` : '';
  const reasonKu = reason ? ` هۆکار: ${reason}` : '';
  return {
    titleEn: 'Laboratory appointment cancelled',
    titleAr: 'تم إلغاء موعد المختبر',
    titleKu: 'نیشتەجێبوونی تاقیگەکەت هەڵوەشێنرایەوە',
    bodyEn: `Your appointment at ${en || 'the laboratory'} has been cancelled.${reasonEn}`,
    bodyAr: `تم إلغاء موعدك في ${ar || 'المختبر'}.${reasonAr}`,
    bodyKu: `نیشتەجێبوونەکەت لە ${ku || 'تاقیگەکە'} هەڵوەشێنرایەوە.${reasonKu}`,
  };
}

registerWorkflow({
  workflowType: 'lab_order',
  entityCollection: 'clinical_requests',

  navigationTarget: (requestId) => ({
    route: 'lab_appointment_detail',
    params: { clinicalRequestId: requestId },
  }),

  // Back-compat: the current app routes 'lab_appointment' notifications to
  // LabAppointmentDetailPage via `clinicalRequestId` (see notifications.dart).
  legacyFields: (requestId, ctx) => ({
    type: 'lab_appointment',
    subtype: ctx.toStage === 'scheduled' ? 'confirmed' : 'cancelled',
    clinicalRequestId: requestId,
    providerName_en: (ctx && ctx.providerNameEn) || '',
    providerName_ar: (ctx && ctx.providerNameAr) || '',
    providerName_ku: (ctx && ctx.providerNameKu) || '',
  }),

  stages: {
    scheduled: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = providerNames(ctx);
        return {
          titleEn: 'Your laboratory appointment has been confirmed',
          titleAr: 'تم تأكيد موعدك في المختبر',
          titleKu: 'نیشتەجێبوونی تاقیگەکەت پشتڕاستکرایەوە',
          bodyEn: `Your appointment at ${en || 'the laboratory'} has been confirmed.`,
          bodyAr: `تم تأكيد موعدك في ${ar || 'المختبر'}.`,
          bodyKu: `نیشتەجێبوونەکەت لە ${ku || 'تاقیگەکە'} پشتڕاستکرایەوە.`,
        };
      },
    },
    cancelled: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      buildContent: buildCancelledContent,
    },
    rejected: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      buildContent: buildCancelledContent,
    },
  },
});

module.exports = {};
