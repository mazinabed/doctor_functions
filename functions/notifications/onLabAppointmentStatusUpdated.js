'use strict';

/**
 * onLabAppointmentStatusUpdated
 *
 * Triggered when a patient-booked lab/imaging clinical_request is updated.
 * Sends a push notification when the lab confirms or cancels the appointment.
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
 *   pendingApproval → scheduled   subtype='confirmed'
 *   any             → cancelled   subtype='cancelled'
 *   any             → rejected    subtype='cancelled'  (treated identically)
 *
 * Deterministic notification IDs prevent duplicates on retries.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// ─── FCM fan-out ──────────────────────────────────────────────────────────────
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

// ─── Notification content builders ────────────────────────────────────────────
function buildConfirmedContent(nameEn, nameAr, nameKu) {
  return {
    titleEn: 'Your laboratory appointment has been confirmed',
    titleAr: 'تم تأكيد موعدك في المختبر',
    titleKu: 'نیشتەجێبوونی تاقیگەکەت پشتڕاستکرایەوە',
    bodyEn: `Your appointment at ${nameEn || 'the laboratory'} has been confirmed.`,
    bodyAr: `تم تأكيد موعدك في ${nameAr || 'المختبر'}.`,
    bodyKu: `نیشتەجێبوونەکەت لە ${nameKu || 'تاقیگەکە'} پشتڕاستکرایەوە.`,
  };
}

function buildCancelledContent(nameEn, nameAr, nameKu, reason) {
  const reasonEn = reason ? ` Reason: ${reason}` : '';
  const reasonAr = reason ? ` السبب: ${reason}` : '';
  const reasonKu = reason ? ` هۆکار: ${reason}` : '';

  return {
    titleEn: 'Laboratory appointment cancelled',
    titleAr: 'تم إلغاء موعد المختبر',
    titleKu: 'نیشتەجێبوونی تاقیگەکەت هەڵوەشێنرایەوە',
    bodyEn: `Your appointment at ${nameEn || 'the laboratory'} has been cancelled.${reasonEn}`,
    bodyAr: `تم إلغاء موعدك في ${nameAr || 'المختبر'}.${reasonAr}`,
    bodyKu: `نیشتەجێبوونەکەت لە ${nameKu || 'تاقیگەکە'} هەڵوەشێنرایەوە.${reasonKu}`,
  };
}

// ─── Main trigger ─────────────────────────────────────────────────────────────
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

    let notifId = null;
    let content = null;

    // ── Confirmed ────────────────────────────────────────────────────────────
    if (prevStatus === 'pendingApproval' && newStatus === 'scheduled') {
      notifId = `lab_appt_confirmed_${requestId}`;
      content = buildConfirmedContent(nameEn, nameAr, nameKu);

    // ── Cancelled / rejected ─────────────────────────────────────────────────
    } else if (
      prevStatus !== 'cancelled' &&
      prevStatus !== 'rejected'  &&
      (newStatus === 'cancelled' || newStatus === 'rejected')
    ) {
      notifId = `lab_appt_cancelled_${requestId}`;
      const reason = after.cancellationReason || after.cancelledReason || '';
      content = buildCancelledContent(nameEn, nameAr, nameKu, reason);
    }

    // No relevant transition — nothing to notify
    if (!notifId || !content) {
      console.log(
        `onLabAppointmentStatusUpdated: no notification for` +
        ` ${requestId} ${prevStatus}→${newStatus}`,
      );
      return;
    }

    const notifRef = db
      .collection('users')
      .doc(patientId)
      .collection('notifications')
      .doc(notifId);

    // Idempotent: skip if already written
    const existing = await notifRef.get();
    if (existing.exists) {
      console.log(`onLabAppointmentStatusUpdated: ${notifId} already exists — skipping`);
      return;
    }

    await notifRef.set({
      type:              'lab_appointment',
      subtype:           newStatus === 'scheduled' ? 'confirmed' : 'cancelled',
      clinicalRequestId: requestId,
      providerName_en:   nameEn,
      providerName_ar:   nameAr,
      providerName_ku:   nameKu,
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
      `onLabAppointmentStatusUpdated: wrote ${notifId}` +
      ` patient=${patientId} ${prevStatus}→${newStatus}`,
    );

    // FCM push — non-fatal; Firestore notification already written.
    try {
      const fcm = await sendFcmPush(db, patientId, {
        clinicalRequestId: requestId,
        ...content,
      });
      console.log(
        `onLabAppointmentStatusUpdated: fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
      );
    } catch (e) {
      console.error(`onLabAppointmentStatusUpdated: fcm non-fatal: ${e.message}`);
    }
  },
);
