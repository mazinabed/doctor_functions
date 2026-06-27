'use strict';

/**
 * onLabAppointmentCreated
 *
 * Triggered when a patient self-books a lab/imaging appointment.
 *
 * Guards:
 *   requestDestination == 'partner'
 *   source             == 'scheduled'
 *   createdByRole      == 'patient'
 *   patientId          exists
 *
 * Actions:
 *   1. Write users/{patientId}/notifications/lab_appt_created_{requestId}
 *      type='lab_appointment', subtype='request_sent'
 *   2. FCM push fan-out (non-fatal)
 *
 * Idempotency: deterministic notif ID prevents duplicates on retries.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// ─── FCM fan-out ──────────────────────────────────────────────────────────────
// Identical pattern to sendDailyReminders.js / onClinicalReferralCreated.js.
// Groups tokens by language; cleans up invalid tokens automatically.
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
        data: { clinicalRequestId: notifContent.clinicalRequestId || '' },
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

// ─── Main trigger ─────────────────────────────────────────────────────────────
exports.onLabAppointmentCreated = onDocumentCreated(
  'clinical_requests/{requestId}',
  async (event) => {
    const db        = getFirestore();
    const requestId = event.params.requestId;
    const data      = event.data.data();

    // Guard: patient self-booked lab/imaging appointments only
    if (
      data.requestDestination !== 'partner' ||
      data.source             !== 'scheduled' ||
      data.createdByRole      !== 'patient'   ||
      !data.patientId
    ) {
      return;
    }

    const patientId   = data.patientId;
    const isHomeVisit = data.visitType === 'homeVisit';

    const notifId  = `lab_appt_created_${requestId}`;
    const notifRef = db
      .collection('users')
      .doc(patientId)
      .collection('notifications')
      .doc(notifId);

    // Idempotent: skip if already written
    const existing = await notifRef.get();
    if (existing.exists) {
      console.log(`onLabAppointmentCreated: ${notifId} already exists — skipping`);
      return;
    }

    const content = isHomeVisit
      ? {
          titleEn: 'Home visit appointment request sent',
          titleAr: 'تم إرسال طلب الزيارة المنزلية',
          titleKu: 'داواکاری سەردانی ماڵ نێردرا',
          bodyEn:  'Your home visit request has been sent and is awaiting confirmation.',
          bodyAr:  'تم إرسال طلب الزيارة المنزلية وهو في انتظار التأكيد.',
          bodyKu:  'داواکاری سەردانی ماڵەکەت نێردرا و چاوەڕوانی پشتڕاستکردنەوەیە.',
        }
      : {
          titleEn: 'Laboratory appointment request sent',
          titleAr: 'تم إرسال طلب موعد المختبر',
          titleKu: 'داواکاری نیشتەجێبوونی تاقیگە نێردرا',
          bodyEn:  'Your request has been sent and is awaiting confirmation.',
          bodyAr:  'تم إرسال طلبك وهو في انتظار التأكيد.',
          bodyKu:  'داواکاریەکەت نێردرا و چاوەڕوانی پشتڕاستکردنەوەیە.',
        };

    await notifRef.set({
      type:              'lab_appointment',
      subtype:           'request_sent',
      clinicalRequestId: requestId,
      providerName_en:   data.providerName_en || '',
      providerName_ar:   data.providerName_ar || '',
      providerName_ku:   data.providerName_ku || '',
      titleEn:   content.titleEn,
      titleAr:   content.titleAr,
      titleKu:   content.titleKu,
      bodyEn:    content.bodyEn,
      bodyAr:    content.bodyAr,
      bodyKu:    content.bodyKu,
      isRead:    false,
      dismissed: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `onLabAppointmentCreated: wrote ${notifId} patient=${patientId}` +
      ` provider=${data.providerName_en || '(unnamed)'}` +
      ` visitType=${data.visitType || 'inPerson'}`,
    );

    // FCM push — non-fatal; Firestore notification already written.
    try {
      const fcm = await sendFcmPush(db, patientId, {
        clinicalRequestId: requestId,
        ...content,
      });
      console.log(
        `onLabAppointmentCreated: fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
      );
    } catch (e) {
      console.error(`onLabAppointmentCreated: fcm non-fatal: ${e.message}`);
    }
  },
);
