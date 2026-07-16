'use strict';

/**
 * onMarketplaceOrderFulfillmentUpdated
 *
 * Pharmacy Operations Dashboard (Phase 1). Triggered whenever a
 * marketplace_orders document's `fulfillmentStatus` changes. Sends a
 * friendly, transition-specific push notification to the patient —
 * never a generic "Status changed."
 *
 * `fulfillmentStatus` is written ONLY after Odoo has confirmed the
 * underlying action succeeded (see marketplaceCheckout.js /
 * pharmacyOrderActions.js) — this trigger fires strictly downstream of
 * that, matching the required order:
 *   TrustyDr UI -> Commerce -> Odoo success -> Firestore projection -> notify
 *
 * No notification on `null -> 'new'` (order creation) — the checkout
 * success screen already surfaces that inline; a push here would be
 * redundant. Increment 1 builds and registers this trigger, but nothing
 * yet calls the pharmacy actions that produce transitions past 'new'
 * (that's Increment 2) — validated in the interim via a manual test write.
 *
 * Deterministic notification IDs (order_fulfillment_<status>_<orderId>)
 * prevent duplicates on retries, same convention as
 * onLabAppointmentStatusUpdated.js.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// ─── FCM fan-out (identical pattern to onLabAppointmentStatusUpdated.js) ──────
async function sendFcmPush(db, recipientUid, notifContent) {
  const tokensSnap = await db
    .collection('users')
    .doc(recipientUid)
    .collection('fcmTokens')
    .get();

  if (tokensSnap.empty) return { sent: 0, cleaned: 0 };

  const byLang = {};
  for (const doc of tokensSnap.docs) {
    const { token, language } = doc.data();
    if (!token) continue;
    const lang = language || 'ar';
    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push({ docId: doc.id, token });
  }

  const messaging = getMessaging();
  const titleMap = { en: notifContent.titleEn, ar: notifContent.titleAr, ku: notifContent.titleKu };
  const bodyMap  = { en: notifContent.bodyEn,  ar: notifContent.bodyAr,  ku: notifContent.bodyKu };

  let sent = 0;
  let cleaned = 0;

  for (const [lang, tokenDocs] of Object.entries(byLang)) {
    const title  = titleMap[lang]  || titleMap.ar;
    const body   = bodyMap[lang]   || bodyMap.ar;
    const tokens = tokenDocs.map((t) => t.token);

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { marketplaceOrderId: notifContent.orderId || '' },
        webpush: {
          notification: {
            icon:  '/icons/Icon-192.png',
            badge: '/icons/Icon-192.png',
          },
        },
      });

      sent += response.successCount;

      for (let i = 0; i < response.responses.length; i++) {
        if (!response.responses[i].success) {
          const code =
            response.responses[i].error && response.responses[i].error.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            try {
              await db
                .collection('users')
                .doc(recipientUid)
                .collection('fcmTokens')
                .doc(tokenDocs[i].docId)
                .delete();
              cleaned++;
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.error(
        `sendFcmPush: multicast error uid=${recipientUid} lang=${lang}: ${e.message}`,
      );
    }
  }

  return { sent, cleaned };
}

// ─── Notification content builders ────────────────────────────────────────────
// Each builder takes (storeNameEn, storeNameAr) and returns all three
// language variants at once — Kurdish falls back to the Arabic store name
// (no separate Kurdish store-name field), matching this app's established
// Kurdish-falls-to-Arabic convention.
//
// One friendly, transition-specific sentence per real fulfillmentStatus
// value (never a generic "Status changed."). Deliberately short — this is
// a push notification, not the Order Details page.
const CONTENT_BUILDERS = {
  accepted: (storeEn, storeAr) => ({
    titleEn: 'Your order was accepted',
    titleAr: 'تم قبول طلبك',
    titleKu: 'داواکارییەکەت وەرگیرا',
    bodyEn: `${storeEn || 'The pharmacy'} accepted your order.`,
    bodyAr: `قبلت ${storeAr || 'الصيدلية'} طلبك.`,
    bodyKu: `${storeAr || 'دەرمانخانە'} داواکارییەکەتی وەرگرت.`,
  }),
  rejected: (storeEn, storeAr) => ({
    titleEn: 'Your order could not be accepted',
    titleAr: 'تعذّر قبول طلبك',
    titleKu: 'نەتوانرا داواکارییەکەت وەربگیرێت',
    bodyEn: `${storeEn || 'The pharmacy'} was unable to accept your order.`,
    bodyAr: `تعذّر على ${storeAr || 'الصيدلية'} قبول طلبك.`,
    bodyKu: `${storeAr || 'دەرمانخانە'} نەیتوانی داواکارییەکەت وەربگرێت.`,
  }),
  preparing: (storeEn, storeAr) => ({
    titleEn: 'Your order is being prepared',
    titleAr: 'طلبك قيد التحضير',
    titleKu: 'داواکارییەکەت ئامادە دەکرێت',
    bodyEn: `${storeEn || 'Your pharmacy'} has started preparing your order.`,
    bodyAr: `بدأت ${storeAr || 'الصيدلية'} بتحضير طلبك.`,
    bodyKu: `${storeAr || 'دەرمانخانەکەت'} دەستی بە ئامادەکردنی داواکارییەکەت کرد.`,
  }),
  readyForPickup: () => ({
    titleEn: 'Your order is ready for pickup',
    titleAr: 'طلبك جاهز للاستلام',
    titleKu: 'داواکارییەکەت ئامادەیە بۆ وەرگرتن',
    bodyEn: 'Your order is ready for pickup.',
    bodyAr: 'طلبك جاهز الآن للاستلام من الصيدلية.',
    bodyKu: 'داواکارییەکەت ئێستا ئامادەیە بۆ وەرگرتن لە دەرمانخانەوە.',
  }),
  outForDelivery: () => ({
    titleEn: 'Your order is out for delivery',
    titleAr: 'طلبك في الطريق إليك',
    titleKu: 'داواکارییەکەت لە ڕێگای گەیاندندایە',
    bodyEn: 'Your order is out for delivery.',
    bodyAr: 'طلبك الآن في طريقه إليك.',
    bodyKu: 'داواکارییەکەت ئێستا لە ڕێگای گەیاندنە بۆ لات.',
  }),
  completed: (storeEn, storeAr) => ({
    titleEn: 'Your order is complete',
    titleAr: 'اكتمل طلبك',
    titleKu: 'داواکارییەکەت تەواو بوو',
    bodyEn: `Your order from ${storeEn || 'the pharmacy'} is complete. Thank you!`,
    bodyAr: `اكتمل طلبك من ${storeAr || 'الصيدلية'}. شكراً لك!`,
    bodyKu: `داواکارییەکەت لە ${storeAr || 'دەرمانخانە'} تەواو بوو. سوپاس!`,
  }),
  cancelled: (storeEn, storeAr) => ({
    titleEn: 'Order cancelled',
    titleAr: 'تم إلغاء الطلب',
    titleKu: 'داواکارییەکە هەڵوەشێنرایەوە',
    bodyEn: `Your order from ${storeEn || 'the pharmacy'} was cancelled.`,
    bodyAr: `تم إلغاء طلبك من ${storeAr || 'الصيدلية'}.`,
    bodyKu: `داواکارییەکەت لە ${storeAr || 'دەرمانخانە'} هەڵوەشێنرایەوە.`,
  }),
};

// ─── Main trigger ─────────────────────────────────────────────────────────────
exports.onMarketplaceOrderFulfillmentUpdated = onDocumentUpdated(
  'marketplace_orders/{orderId}',
  async (event) => {
    const db      = getFirestore();
    const orderId = event.params.orderId;
    const before  = event.data.before.data();
    const after   = event.data.after.data();

    const prevStatus = before.fulfillmentStatus || null;
    const newStatus  = after.fulfillmentStatus || null;

    // No relevant transition, or the (excluded) initial 'new' state.
    if (prevStatus === newStatus || !newStatus || newStatus === 'new') return;

    const patientId = after.patientId || before.patientId;
    if (!patientId) return;

    const buildContent = CONTENT_BUILDERS[newStatus];
    if (!buildContent) {
      console.log(
        `onMarketplaceOrderFulfillmentUpdated: no content builder for status "${newStatus}" (${orderId}) — skipping`,
      );
      return;
    }

    const storeNameEn = after.storeNameEn || before.storeNameEn || '';
    const storeNameAr = after.storeNameAr || before.storeNameAr || '';
    const content = buildContent(storeNameEn, storeNameAr);

    const notifId = `order_fulfillment_${newStatus}_${orderId}`;
    const notifRef = db
      .collection('users')
      .doc(patientId)
      .collection('notifications')
      .doc(notifId);

    // Idempotent: skip if already written (matches onLabAppointmentStatusUpdated.js).
    const existing = await notifRef.get();
    if (existing.exists) {
      console.log(`onMarketplaceOrderFulfillmentUpdated: ${notifId} already exists — skipping`);
      return;
    }

    await notifRef.set({
      type: 'marketplace_order',
      subtype: newStatus,
      marketplaceOrderId: orderId,
      storeNameEn,
      storeNameAr,
      titleEn: content.titleEn,
      titleAr: content.titleAr,
      titleKu: content.titleKu,
      bodyEn: content.bodyEn,
      bodyAr: content.bodyAr,
      bodyKu: content.bodyKu,
      isRead: false,
      dismissed: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `onMarketplaceOrderFulfillmentUpdated: wrote ${notifId} patient=${patientId} ${prevStatus}->${newStatus}`,
    );

    // FCM push — non-fatal; Firestore notification already written.
    try {
      const fcm = await sendFcmPush(db, patientId, { orderId, ...content });
      console.log(
        `onMarketplaceOrderFulfillmentUpdated: fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
      );
    } catch (e) {
      console.error(`onMarketplaceOrderFulfillmentUpdated: fcm non-fatal: ${e.message}`);
    }
  },
);
