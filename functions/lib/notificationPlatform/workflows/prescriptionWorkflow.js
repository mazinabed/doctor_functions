'use strict';

const { registerWorkflow } = require('../workflowRegistry');
const { PRIORITY, CHANNEL } = require('../constants');

// Prescription Workflow -- Phase 3 migration of the TrustyDr Workflow &
// Notification Platform (see NOTIFICATION_PLATFORM_PROGRESS.md at the
// ecosystem root). Second WorkflowDefinition registered (after
// marketplace_order in Phase 1), proving the engine/Workflow Registry are
// genuinely domain-agnostic -- nothing in notificationEngine.js or
// workflowRegistry.js changed to support this.
//
// Stage content migrated verbatim from the previous
// notifications/onClinicalReferralStatusUpdated.js inline transition
// blocks (sent->received, preparing->ready, ready->dispensed), then
// completed: `sent`, `preparing` and `cancelled` were added, because the
// pharmacy writes those statuses from the portal and the patient was never
// told. Transitions are now selected by DESTINATION status rather than by
// (before, after) pairs, so a pharmacy that skips a step - received->ready
// for stock on hand - still produces the Ready notification. Under the
// old scheme each transition wrote its OWN notification document
// (rx_received_<id>, rx_ready_<id>, rx_dispensed_<id>) -- up to 3 separate
// notifications per prescription, the same "one doc per stage" pattern
// Marketplace had. This migration collapses them into one stable,
// evolving document, same as Phase 1's Marketplace fix.
//
// No action buttons yet (deliberately) -- tap-to-navigate to
// ReferralDetailPage already existed for this type before the platform, so
// no new capability is needed here. A "Request Refill" action is a natural
// future fit once a refill-request flow actually exists in the app; adding
// the action key now with nothing behind it would be a dead button.

function partnerNames(ctx) {
  return {
    en: (ctx && ctx.partnerNameEn) || '',
    ar: (ctx && ctx.partnerNameAr) || '',
    ku: (ctx && ctx.partnerNameKu) || '',
  };
}

registerWorkflow({
  workflowType: 'prescription',
  entityCollection: 'clinical_requests',

  navigationTarget: (requestId) => ({
    route: 'referral_detail',
    params: { referralId: requestId },
  }),

  // Back-compat: the current app already routes 'rx_status' notifications
  // to ReferralDetailPage via `clinicalRequestId` (see notifications.dart) --
  // keeping these fields means zero app changes are needed to keep that
  // working under the new stable-ID scheme.
  legacyFields: (requestId, ctx) => ({
    type: 'rx_status',
    subtype: ctx.toStage,
    clinicalRequestId: requestId,
  }),

  stages: {
    // The fulfillment story opens here. Before this stage existed, the
    // "sent to pharmacy" announcement was a SEPARATE notification document
    // (`referral_{requestId}`) titled "New prescription" - the same title the
    // clinical issue notification uses - so the patient received two
    // notifications that read identically and neither told them which was
    // which. Seeding the workflow at `sent` gives fulfillment exactly one
    // evolving document, and leaves "New prescription" to mean the clinical
    // record alone.
    sent: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = partnerNames(ctx);
        return {
          titleEn: 'Prescription sent to pharmacy',
          titleAr: 'تم إرسال الوصفة إلى الصيدلية',
          titleKu: 'نوسخەکە نێردرا بۆ دەرمانخانە',
          bodyEn: `Your doctor sent your prescription to ${en || 'the pharmacy'}.`,
          bodyAr: `أرسل طبيبك وصفتك الطبية إلى ${ar || 'الصيدلية'}.`,
          bodyKu: `پزیشکەکەت نوسخەکەتی ناردە بۆ ${ku || 'دەرمانخانەکە'}.`,
        };
      },
    },
    received: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = partnerNames(ctx);
        return {
          titleEn: 'Prescription received',
          titleAr: 'تم استلام الوصفة الطبية',
          titleKu: 'نوسخەکە وەرگیرا',
          bodyEn: `${en || 'The pharmacy'} received your prescription.`,
          bodyAr: `استلم ${ar || 'الصيدلية'} وصفتك الطبية.`,
          bodyKu: `${ku || 'دەرمانخانەکە'} نوسخەکەت وەرگرت.`,
        };
      },
    },
    // The pharmacy writes this status from the portal, but nothing notified
    // on it - the patient could only discover it by opening the screen.
    preparing: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = partnerNames(ctx);
        return {
          titleEn: 'Prescription being prepared',
          titleAr: 'جارٍ تجهيز الوصفة الطبية',
          titleKu: 'نوسخەکە ئامادە دەکرێت',
          bodyEn: `${en || 'The pharmacy'} started preparing your prescription.`,
          bodyAr: `بدأت ${ar || 'الصيدلية'} بتجهيز وصفتك الطبية.`,
          bodyKu: `${ku || 'دەرمانخانەکە'} دەستی کرد بە ئامادەکردنی نوسخەکەت.`,
        };
      },
    },
    ready: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      buildContent: (ctx) => {
        const { en, ar, ku } = partnerNames(ctx);
        return {
          titleEn: 'Prescription ready',
          titleAr: 'الوصفة الطبية جاهزة',
          titleKu: 'نوسخەکە ئامادەیە',
          bodyEn: `Your prescription is ready for pickup at ${en || 'the pharmacy'}.`,
          bodyAr: `وصفتك الطبية جاهزة للاستلام من ${ar || 'الصيدلية'}.`,
          bodyKu: `نوسخەکەت ئامادەی وەرگرتنە لە ${ku || 'دەرمانخانەکە'}.`,
        };
      },
    },
    dispensed: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      isCompleted: true,
      terminal: true,
      buildContent: (ctx) => {
        const { en, ar, ku } = partnerNames(ctx);
        return {
          titleEn: 'Prescription dispensed',
          titleAr: 'تم صرف الوصفة الطبية',
          titleKu: 'نوسخەکە دابەشکرا',
          bodyEn: `Your prescription was dispensed by ${en || 'the pharmacy'}.`,
          bodyAr: `تم صرف وصفتك الطبية من ${ar || 'الصيدلية'}.`,
          bodyKu: `نوسخەکەت لە ${ku || 'دەرمانخانەکە'} دابەشکرا.`,
        };
      },
    },
    // Neutral by instruction: the pharmacy records no reason today, and
    // inventing one in the patient's copy would be guessing at clinical or
    // commercial facts. The patient is told the request did not complete and
    // to contact the pharmacy - which is the actionable part either way.
    cancelled: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      buildContent: (ctx) => {
        const { en, ar, ku } = partnerNames(ctx);
        return {
          titleEn: 'Prescription not completed',
          titleAr: 'لم يكتمل صرف الوصفة الطبية',
          titleKu: 'نوسخەکە تەواو نەکرا',
          bodyEn: `${en || 'The pharmacy'} could not complete your prescription. Please contact the pharmacy or your doctor.`,
          bodyAr: `تعذّر على ${ar || 'الصيدلية'} إكمال صرف وصفتك الطبية. يرجى التواصل مع الصيدلية أو طبيبك.`,
          bodyKu: `${ku || 'دەرمانخانەکە'} نەیتوانی نوسخەکەت تەواو بکات. تکایە پەیوەندی بە دەرمانخانە یان پزیشکەکەتەوە بکە.`,
        };
      },
    },
  },
});

module.exports = {};
