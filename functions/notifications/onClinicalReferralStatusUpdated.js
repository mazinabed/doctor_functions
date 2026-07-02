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
 *   - Pharmacy-only: sends patient push notifications on 3 transitions (non-fatal).
 *
 * Pharmacy notification transitions:
 *   sent      → received  : "[Pharmacy] received your prescription."
 *   preparing → ready     : "Your prescription is ready for pickup at [Pharmacy]."
 *   ready     → dispensed : "Your prescription was dispensed by [Pharmacy]."
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const STATUS_FIELDS = ['partnerStatus', 'status', 'patientReleaseStatus'];

// ─── FCM fan-out ──────────────────────────────────────────────────────────────
// Identical pattern to onClinicalReferralCreated.js.
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
  const titleMap = {
    en: notifContent.titleEn,
    ar: notifContent.titleAr,
    ku: notifContent.titleKu,
  };
  const bodyMap = {
    en: notifContent.bodyEn,
    ar: notifContent.bodyAr,
    ku: notifContent.bodyKu,
  };

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

    const patientId  = referralData.patientId;
    const pEn = referralData.partnerName_en || referralData.partnerName_ar || '';
    const pAr = referralData.partnerName_ar || referralData.partnerName_en || '';
    const pKu = referralData.partnerName_ku || referralData.partnerName_en || '';

    // ── Transition 1: sent → received ────────────────────────────────────────
    if (before.partnerStatus === 'sent' && after.partnerStatus === 'received') {
      const notifId  = `rx_received_${requestId}`;
      const notifRef = db.collection('users').doc(patientId)
        .collection('notifications').doc(notifId);
      const existing = await notifRef.get();
      if (!existing.exists) {
        const content = {
          titleEn: 'Prescription received',
          titleAr: 'تم استلام الوصفة الطبية',
          titleKu: 'نوسخەکە وەرگیرا',
          bodyEn:  `${pEn || 'The pharmacy'} received your prescription.`,
          bodyAr:  `استلم ${pAr || 'الصيدلية'} وصفتك الطبية.`,
          bodyKu:  `${pKu || 'دەرمانخانەکە'} نوسخەکەت وەرگرت.`,
        };
        await notifRef.set({
          type:              'rx_status',
          subtype:           'received',
          clinicalRequestId: requestId,
          ...content,
          isRead:    false,
          dismissed: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `onClinicalReferralStatusUpdated: wrote rx_received notification` +
          ` ${notifId} patient=${patientId}`,
        );
        try {
          const fcm = await sendFcmPush(db, patientId, {
            clinicalRequestId: requestId, ...content,
          });
          console.log(
            `onClinicalReferralStatusUpdated: rx_received fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
          );
        } catch (e) {
          console.error(`onClinicalReferralStatusUpdated: rx_received fcm non-fatal: ${e.message}`);
        }
      }
      return;
    }

    // ── Transition 2: preparing → ready ──────────────────────────────────────
    if (before.partnerStatus === 'preparing' && after.partnerStatus === 'ready') {
      const notifId  = `rx_ready_${requestId}`;
      const notifRef = db.collection('users').doc(patientId)
        .collection('notifications').doc(notifId);
      const existing = await notifRef.get();
      if (!existing.exists) {
        const content = {
          titleEn: 'Prescription ready',
          titleAr: 'الوصفة الطبية جاهزة',
          titleKu: 'نوسخەکە ئامادەیە',
          bodyEn:  `Your prescription is ready for pickup at ${pEn || 'the pharmacy'}.`,
          bodyAr:  `وصفتك الطبية جاهزة للاستلام من ${pAr || 'الصيدلية'}.`,
          bodyKu:  `نوسخەکەت ئامادەی وەرگرتنە لە ${pKu || 'دەرمانخانەکە'}.`,
        };
        await notifRef.set({
          type:              'rx_status',
          subtype:           'ready',
          clinicalRequestId: requestId,
          ...content,
          isRead:    false,
          dismissed: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `onClinicalReferralStatusUpdated: wrote rx_ready notification` +
          ` ${notifId} patient=${patientId}`,
        );
        try {
          const fcm = await sendFcmPush(db, patientId, {
            clinicalRequestId: requestId, ...content,
          });
          console.log(
            `onClinicalReferralStatusUpdated: rx_ready fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
          );
        } catch (e) {
          console.error(`onClinicalReferralStatusUpdated: rx_ready fcm non-fatal: ${e.message}`);
        }
      }
      return;
    }

    // ── Transition 3: ready → dispensed ──────────────────────────────────────
    if (before.partnerStatus === 'ready' && after.partnerStatus === 'dispensed') {
      const notifId  = `rx_dispensed_${requestId}`;
      const notifRef = db.collection('users').doc(patientId)
        .collection('notifications').doc(notifId);
      const existing = await notifRef.get();
      if (!existing.exists) {
        const content = {
          titleEn: 'Prescription dispensed',
          titleAr: 'تم صرف الوصفة الطبية',
          titleKu: 'نوسخەکە دابەشکرا',
          bodyEn:  `Your prescription was dispensed by ${pEn || 'the pharmacy'}.`,
          bodyAr:  `تم صرف وصفتك الطبية من ${pAr || 'الصيدلية'}.`,
          bodyKu:  `نوسخەکەت لە ${pKu || 'دەرمانخانەکە'} دابەشکرا.`,
        };
        await notifRef.set({
          type:              'rx_status',
          subtype:           'dispensed',
          clinicalRequestId: requestId,
          ...content,
          isRead:    false,
          dismissed: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `onClinicalReferralStatusUpdated: wrote rx_dispensed notification` +
          ` ${notifId} patient=${patientId}`,
        );
        try {
          const fcm = await sendFcmPush(db, patientId, {
            clinicalRequestId: requestId, ...content,
          });
          console.log(
            `onClinicalReferralStatusUpdated: rx_dispensed fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
          );
        } catch (e) {
          console.error(`onClinicalReferralStatusUpdated: rx_dispensed fcm non-fatal: ${e.message}`);
        }
      }
      return;
    }
  },
);
