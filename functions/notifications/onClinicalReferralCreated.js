'use strict';

/**
 * onClinicalReferralCreated
 *
 * Triggered when a doctor creates an external partner referral.
 *
 * Guards:
 *   requestDestination == 'partner'
 *   createdByRole      == 'doctor'
 *   patientId          exists
 *
 * Actions:
 *   1. Lookup doctor snapshot      (doctors/{doctorId})
 *   2. Lookup partner snapshot     (public_diagnostic_providers/{partnerProviderId})
 *   3. Write patient_referral_requests/{requestId}  — safe, result-free patient view
 *   4. Write users/{patientId}/notifications/referral_{requestId}  — deterministic ID
 *   5. FCM push fan-out to patient (non-fatal)
 *   6. [Pharmacy only] Write users/{partnerProviderId}/notifications/rx_created_{requestId}
 *   7. [Pharmacy only] FCM push fan-out to pharmacy owner (non-fatal)
 *
 * Idempotency: the referral doc is checked before writing; skipped if it already exists.
 * The notification doc uses a deterministic ID so retries never duplicate it.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// ─── FCM fan-out ──────────────────────────────────────────────────────────────
// Identical pattern to sendDailyReminders.js.
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

// ─── Notification content ──────────────────────────────────────────────────────
// isPharmacy=true  → prescription-specific patient message
// isPharmacy=false → generic lab referral message (unchanged)
function buildNotificationContent({
  doctorName,
  partnerNameEn, partnerNameAr, partnerNameKu,
  serviceNameEn, serviceNameAr, serviceNameKu,
  isPharmacy,
}) {
  const pEn = partnerNameEn || partnerNameAr || '';
  const pAr = partnerNameAr || partnerNameEn || '';
  const pKu = partnerNameKu || partnerNameEn || '';

  if (isPharmacy) {
    return {
      titleEn: 'New prescription',
      titleAr: 'وصفة طبية جديدة',
      titleKu: 'نوسخەی نوێ',
      bodyEn: `Your doctor sent a prescription to ${pEn || 'the pharmacy'}.`,
      bodyAr: `أرسل طبيبك وصفة طبية إلى ${pAr || 'الصيدلية'}.`,
      bodyKu: `پزیشکەکەت نوسخەیەکی نوێ ناردە بۆ ${pKu || 'دەرمانخانەکە'}.`,
    };
  }

  return {
    titleEn: 'You have a new referral',
    titleAr: 'لديك إحالة جديدة',
    titleKu: 'ناردنێکی نوێت هەیە',
    bodyEn: `Dr. ${doctorName} referred you to ${pEn}${serviceNameEn ? ' for ' + serviceNameEn : ''}.`,
    bodyAr: `د. ${doctorName} أحالك إلى ${pAr}${serviceNameAr ? ' لـ' + serviceNameAr : ''}.`,
    bodyKu: `د. ${doctorName} ناردت بۆ ${pKu}${serviceNameKu ? ' بۆ ' + serviceNameKu : ''}.`,
  };
}

// ─── Main trigger ─────────────────────────────────────────────────────────────
exports.onClinicalReferralCreated = onDocumentCreated(
  'clinical_requests/{requestId}',
  async (event) => {
    const db        = getFirestore();
    const requestId = event.params.requestId;
    const data      = event.data.data();

    // Guard: doctor-created external partner referrals only
    if (
      data.requestDestination !== 'partner' ||
      data.createdByRole      !== 'doctor'  ||
      !data.patientId
    ) {
      return;
    }

    const patientId         = data.patientId;
    const doctorId          = data.doctorId          || '';
    const partnerProviderId = data.partnerProviderId || '';
    const isPharmacy        = data.serviceCategory   === 'pharmacy';

    // Idempotent: skip if patient_referral_requests already written
    const referralRef = db.collection('patient_referral_requests').doc(requestId);
    const existingReferral = await referralRef.get();
    if (existingReferral.exists) {
      console.log(`onClinicalReferralCreated: ${requestId} already exists — skipping`);
      return;
    }

    // ── 1. Doctor snapshot ────────────────────────────────────────────────────
    let doctorNameEn       = data.doctorName || '';
    let doctorNameAr       = data.doctorName || '';
    let doctorNameKu       = data.doctorName || '';
    let doctorImage        = '';
    let doctorSpecialtyEn  = '';
    let doctorSpecialtyAr  = '';
    let doctorSpecialtyKu  = '';

    if (doctorId) {
      try {
        const doctorSnap = await db.collection('doctors').doc(doctorId).get();
        if (doctorSnap.exists) {
          const d = doctorSnap.data();
          doctorNameEn      = d.name_en    || d.name    || doctorNameEn;
          doctorNameAr      = d.name_ar    || d.name    || doctorNameAr;
          doctorNameKu      = d.name_ku    || d.name    || doctorNameKu;
          doctorSpecialtyEn = d.specialty_en || d.specialty || '';
          doctorSpecialtyAr = d.specialty_ar || d.specialty || '';
          doctorSpecialtyKu = d.specialty_ku || d.specialty || '';
          if (typeof d.imageUrl === 'string' && d.imageUrl.startsWith('http')) {
            doctorImage = d.imageUrl;
          }
        }
      } catch (e) {
        console.warn(`onClinicalReferralCreated: doctor lookup failed ${doctorId}: ${e.message}`);
      }
    }

    // ── 2. Partner provider snapshot ──────────────────────────────────────────
    let partnerNameEn  = data.partnerName_en || '';
    let partnerNameAr  = data.partnerName_ar || '';
    let partnerNameKu  = data.partnerName_ku || '';
    let partnerImage   = '';
    let partnerPhone   = '';
    let partnerAddress = '';
    let partnerCity    = '';
    let partnerProvince = '';

    if (partnerProviderId) {
      try {
        const provSnap = await db
          .collection('public_diagnostic_providers')
          .doc(partnerProviderId)
          .get();
        if (provSnap.exists) {
          const p = provSnap.data();
          partnerNameEn  = p.facilityName_en || partnerNameEn;
          partnerNameAr  = p.facilityName_ar || partnerNameAr;
          partnerNameKu  = p.facilityName_ku || partnerNameKu;
          partnerPhone   = p.phone           || '';
          partnerAddress = p.facilityAddress || '';
          partnerCity    = p.city_en         || '';
          partnerProvince = p.province_en    || '';
          if (typeof p.imageUrl === 'string' && p.imageUrl.startsWith('http')) {
            partnerImage = p.imageUrl;
          }
        }
      } catch (e) {
        console.warn(
          `onClinicalReferralCreated: provider lookup failed ${partnerProviderId}: ${e.message}`,
        );
      }
    }

    // ── 3. Service snapshot ───────────────────────────────────────────────────
    const subTypeItems  = Array.isArray(data.subTypeItems) ? data.subTypeItems : [];
    const firstItem     = subTypeItems[0] || {};
    const serviceNameEn = firstItem.nameEn || '';
    const serviceNameAr = firstItem.nameAr || '';
    const serviceNameKu = firstItem.nameKu || '';

    // ── 4. Write patient_referral_requests/{requestId} ────────────────────────
    await referralRef.set({
      clinicalRequestId: requestId,
      patientId,

      // Sender snapshot
      doctorId,
      doctorName_en:      doctorNameEn,
      doctorName_ar:      doctorNameAr,
      doctorName_ku:      doctorNameKu,
      doctorImage,
      doctorSpecialty_en: doctorSpecialtyEn,
      doctorSpecialty_ar: doctorSpecialtyAr,
      doctorSpecialty_ku: doctorSpecialtyKu,
      centerId:      data.centerId     || '',
      centerName_en: data.centerName_en || '',
      centerName_ar: data.centerName_ar || '',
      centerName_ku: data.centerName_ku || '',

      // Partner provider snapshot
      partnerProviderId,
      partnerName_en:      partnerNameEn,
      partnerName_ar:      partnerNameAr,
      partnerName_ku:      partnerNameKu,
      partnerImage,
      partnerPhone,
      partnerAddress,
      partnerCity,
      partnerProvince,
      partnerServiceGroup: data.partnerServiceGroup || data.serviceCategory || '',

      // Requested service snapshot
      serviceNameEn,
      serviceNameAr,
      serviceNameKu,
      serviceGroup: data.serviceCategory || data.partnerServiceGroup || '',

      // Clinical details
      instructions: data.instructions || '',
      urgency:      data.urgency      || '',

      // Live status — mirrored by onClinicalReferralStatusUpdated on change
      partnerStatus:        data.partnerStatus        || 'sent',
      status:               data.status               || 'pending',
      patientReleaseStatus: data.patientReleaseStatus || 'unreleased',

      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `onClinicalReferralCreated: wrote patient_referral_requests/${requestId}` +
      ` patient=${patientId} isPharmacy=${isPharmacy}`,
    );

    // ── 5. Build patient notification content ─────────────────────────────────
    const notifContent = buildNotificationContent({
      doctorName: data.doctorName || doctorNameEn,
      partnerNameEn,
      partnerNameAr,
      partnerNameKu,
      serviceNameEn,
      serviceNameAr,
      serviceNameKu,
      isPharmacy,
    });

    // ── 6. Write patient notification ─────────────────────────────────────────
    const notifId  = `referral_${requestId}`;
    const notifRef = db
      .collection('users')
      .doc(patientId)
      .collection('notifications')
      .doc(notifId);

    const existingNotif = await notifRef.get();
    if (!existingNotif.exists) {
      await notifRef.set({
        type:              isPharmacy ? 'rx_referral' : 'lab_referral',
        clinicalRequestId: requestId,
        doctorName:        data.doctorName || doctorNameEn,
        partnerName_en:    partnerNameEn,
        partnerName_ar:    partnerNameAr,
        partnerName_ku:    partnerNameKu,
        serviceNameEn,
        serviceNameAr,
        serviceNameKu,
        titleEn:   notifContent.titleEn,
        titleAr:   notifContent.titleAr,
        titleKu:   notifContent.titleKu,
        bodyEn:    notifContent.bodyEn,
        bodyAr:    notifContent.bodyAr,
        bodyKu:    notifContent.bodyKu,
        isRead:    false,
        dismissed: false,
        createdAt: FieldValue.serverTimestamp(),
      });
      console.log(
        `onClinicalReferralCreated: wrote notification ${notifId} patient=${patientId}`,
      );
    }

    // ── 7. FCM push to patient (non-fatal) ────────────────────────────────────
    try {
      const fcm = await sendFcmPush(db, patientId, {
        clinicalRequestId: requestId,
        ...notifContent,
      });
      console.log(
        `onClinicalReferralCreated: patient fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
      );
    } catch (e) {
      console.error(`onClinicalReferralCreated: patient fcm non-fatal: ${e.message}`);
    }

    // ── 8. Pharmacy staff notification (prescription only) ────────────────────
    if (!isPharmacy || !partnerProviderId) return;

    const doctorDisplayName  = data.doctorName || doctorNameEn || '';
    const rxStaffNotifId     = `rx_created_${requestId}`;
    const rxStaffNotifRef    = db
      .collection('users')
      .doc(partnerProviderId)
      .collection('notifications')
      .doc(rxStaffNotifId);

    const rxStaffNotifExists = await rxStaffNotifRef.get();
    if (!rxStaffNotifExists.exists) {
      const rxStaffContent = {
        titleEn: 'New prescription',
        titleAr: 'وصفة طبية جديدة',
        titleKu: 'نوسخەی نوێ',
        bodyEn:  `New prescription received from Dr. ${doctorDisplayName}.`,
        bodyAr:  `وصفة طبية جديدة من د. ${doctorDisplayName}.`,
        bodyKu:  `نوسخەیەکی نوێ لە د. ${doctorDisplayName} گەیشتووە.`,
      };

      await rxStaffNotifRef.set({
        type:              'rx_new_prescription',
        clinicalRequestId: requestId,
        patientId,
        doctorName:        doctorDisplayName,
        titleEn:           rxStaffContent.titleEn,
        titleAr:           rxStaffContent.titleAr,
        titleKu:           rxStaffContent.titleKu,
        bodyEn:            rxStaffContent.bodyEn,
        bodyAr:            rxStaffContent.bodyAr,
        bodyKu:            rxStaffContent.bodyKu,
        isRead:    false,
        dismissed: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      console.log(
        `onClinicalReferralCreated: wrote pharmacy staff notification` +
        ` ${rxStaffNotifId} pharmacy=${partnerProviderId}`,
      );

      try {
        const fcm = await sendFcmPush(db, partnerProviderId, {
          clinicalRequestId: requestId,
          ...rxStaffContent,
        });
        console.log(
          `onClinicalReferralCreated: pharmacy fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`,
        );
      } catch (e) {
        console.error(`onClinicalReferralCreated: pharmacy fcm non-fatal: ${e.message}`);
      }
    }
  },
);
