'use strict';

const { registerWorkflow } = require('../workflowRegistry');
const { PRIORITY, CHANNEL, ACTION } = require('../constants');

// Marketplace Order Workflow -- Phase 1 pilot of the TrustyDr Workflow &
// Notification Platform (see NOTIFICATION_PLATFORM_PROGRESS.md at the
// ecosystem root). This is the FIRST WorkflowDefinition registered;
// Prescription/Lab/Appointment/B2B follow the exact same shape in a later
// phase -- nothing about the engine or the Workflow Registry is
// Marketplace-specific.
//
// Stage content is migrated verbatim from the previous
// notifications/onMarketplaceOrderFulfillmentUpdated.js CONTENT_BUILDERS --
// same copy, same languages, same fallback behavior. `deliveryFailed` is
// NEW here: the prior implementation had no content builder for it at all,
// so that real status transition silently produced zero notification (a gap
// found during the notification architecture audit) -- fixed as part of
// this same pass since it touches the exact code being rewritten.

function storeNames(ctx) {
  return { en: (ctx && ctx.storeNameEn) || '', ar: (ctx && ctx.storeNameAr) || '' };
}

registerWorkflow({
  workflowType: 'marketplace_order',
  entityCollection: 'marketplace_orders',

  navigationTarget: (orderId) => ({
    route: 'marketplace_order_details',
    params: { orderId },
  }),

  // Back-compat fields so the CURRENT patient app (which reads `type` /
  // `subtype` / `marketplaceOrderId` / `storeNameEn` / `storeNameAr`
  // directly, with no knowledge of this platform yet) keeps rendering
  // correctly with zero app changes -- it just sees ONE row update in place
  // instead of a new row per stage.
  legacyFields: (orderId, ctx) => ({
    type: 'marketplace_order',
    subtype: ctx.toStage,
    marketplaceOrderId: orderId,
    storeNameEn: (ctx && ctx.storeNameEn) || '',
    storeNameAr: (ctx && ctx.storeNameAr) || '',
  }),

  stages: {
    accepted: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      actions: [ACTION.VIEW_ORDER],
      buildContent: (ctx) => {
        const { en, ar } = storeNames(ctx);
        return {
          titleEn: 'Your order was accepted',
          titleAr: 'تم قبول طلبك',
          titleKu: 'داواکارییەکەت وەرگیرا',
          bodyEn: `${en || 'The pharmacy'} accepted your order.`,
          bodyAr: `قبلت ${ar || 'الصيدلية'} طلبك.`,
          bodyKu: `${ar || 'دەرمانخانە'} داواکارییەکەتی وەرگرت.`,
        };
      },
    },
    rejected: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      actions: [ACTION.VIEW_ORDER],
      buildContent: (ctx) => {
        const { en, ar } = storeNames(ctx);
        return {
          titleEn: 'Your order could not be accepted',
          titleAr: 'تعذّر قبول طلبك',
          titleKu: 'نەتوانرا داواکارییەکەت وەربگیرێت',
          bodyEn: `${en || 'The pharmacy'} was unable to accept your order.`,
          bodyAr: `تعذّر على ${ar || 'الصيدلية'} قبول طلبك.`,
          bodyKu: `${ar || 'دەرمانخانە'} نەیتوانی داواکارییەکەت وەربگرێت.`,
        };
      },
    },
    preparing: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      actions: [ACTION.VIEW_ORDER],
      buildContent: (ctx) => {
        const { en, ar } = storeNames(ctx);
        return {
          titleEn: 'Your order is being prepared',
          titleAr: 'طلبك قيد التحضير',
          titleKu: 'داواکارییەکەت ئامادە دەکرێت',
          bodyEn: `${en || 'Your pharmacy'} has started preparing your order.`,
          bodyAr: `بدأت ${ar || 'الصيدلية'} بتحضير طلبك.`,
          bodyKu: `${ar || 'دەرمانخانەکەت'} دەستی بە ئامادەکردنی داواکارییەکەت کرد.`,
        };
      },
    },
    readyForPickup: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      actions: [ACTION.VIEW_ORDER],
      buildContent: () => ({
        titleEn: 'Your order is ready for pickup',
        titleAr: 'طلبك جاهز للاستلام',
        titleKu: 'داواکارییەکەت ئامادەیە بۆ وەرگرتن',
        bodyEn: 'Your order is ready for pickup.',
        bodyAr: 'طلبك جاهز الآن للاستلام من الصيدلية.',
        bodyKu: 'داواکارییەکەت ئێستا ئامادەیە بۆ وەرگرتن لە دەرمانخانەوە.',
      }),
    },
    outForDelivery: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      actions: [ACTION.TRACK_DELIVERY],
      buildContent: () => ({
        titleEn: 'Your order is out for delivery',
        titleAr: 'طلبك في الطريق إليك',
        titleKu: 'داواکارییەکەت لە ڕێگای گەیاندندایە',
        bodyEn: 'Your order is out for delivery.',
        bodyAr: 'طلبك الآن في طريقه إليك.',
        bodyKu: 'داواکارییەکەت ئێستا لە ڕێگای گەیاندنە بۆ لات.',
      }),
    },
    completed: {
      priority: PRIORITY.NORMAL,
      channels: [CHANNEL.PUSH],
      isCompleted: true,
      terminal: true,
      actions: [ACTION.VIEW_ORDER],
      buildContent: (ctx) => {
        const { en, ar } = storeNames(ctx);
        return {
          titleEn: 'Your order is complete',
          titleAr: 'اكتمل طلبك',
          titleKu: 'داواکارییەکەت تەواو بوو',
          bodyEn: `Your order from ${en || 'the pharmacy'} is complete. Thank you!`,
          bodyAr: `اكتمل طلبك من ${ar || 'الصيدلية'}. شكراً لك!`,
          bodyKu: `داواکارییەکەت لە ${ar || 'دەرمانخانە'} تەواو بوو. سوپاس!`,
        };
      },
    },
    cancelled: {
      priority: PRIORITY.HIGH,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      actions: [ACTION.VIEW_ORDER],
      buildContent: (ctx) => {
        const { en, ar } = storeNames(ctx);
        return {
          titleEn: 'Order cancelled',
          titleAr: 'تم إلغاء الطلب',
          titleKu: 'داواکارییەکە هەڵوەشێنرایەوە',
          bodyEn: `Your order from ${en || 'the pharmacy'} was cancelled.`,
          bodyAr: `تم إلغاء طلبك من ${ar || 'الصيدلية'}.`,
          bodyKu: `داواکارییەکەت لە ${ar || 'دەرمانخانە'} هەڵوەشێنرایەوە.`,
        };
      },
    },
    // NEW -- see file header. Previously silent (no content builder existed
    // for this transition at all).
    deliveryFailed: {
      priority: PRIORITY.CRITICAL,
      channels: [CHANNEL.PUSH],
      isCancelled: true,
      terminal: true,
      actions: [ACTION.VIEW_ORDER],
      buildContent: (ctx) => {
        const { en, ar } = storeNames(ctx);
        return {
          titleEn: 'Delivery attempt failed',
          titleAr: 'فشلت محاولة التوصيل',
          titleKu: 'هەوڵی گەیاندن سەرکەوتوو نەبوو',
          bodyEn: `Delivery of your order from ${en || 'the pharmacy'} was unsuccessful. We're looking into it.`,
          bodyAr: `فشلت محاولة توصيل طلبك من ${ar || 'الصيدلية'}. سنتابع الأمر.`,
          bodyKu: `گەیاندنی داواکارییەکەت لە ${ar || 'دەرمانخانە'} سەرکەوتوو نەبوو. چاوی لێدەکەین.`,
        };
      },
    },
  },
});

// Required for its side effect above (registration) -- no exports needed.
module.exports = {};
