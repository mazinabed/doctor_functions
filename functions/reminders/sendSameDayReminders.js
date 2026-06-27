'use strict';

/**
 * sendSameDayReminders
 *
 * Fires every hour at minute 0 (0 * * * *).
 * Creates same-day reminders for appointments starting in 1–2 hours —
 * for both doctor appointments (appointments collection) and patient-self-booked
 * lab/imaging appointments (clinical_requests collection).
 *
 * Window logic:
 *   windowStart = now + 1 hour
 *   windowEnd   = now + 2 hours
 *   The 1-hour wide window aligns with the hourly schedule so each appointment
 *   falls in exactly one run. The deterministic doc ID provides safety against
 *   edge-case overlap (clock drift, cold-start delay, etc.).
 *
 * Doctor appointments use appointmentAt (Timestamp) as the canonical slot start.
 * Lab appointments  use slotStartAt   (Timestamp) as the canonical slot start.
 *
 * Recipient:
 *   Doctor: bookedByUserId when it differs from patientId, otherwise patientId.
 *   Lab:    always patientId (self-booked).
 *
 * Deterministic doc IDs: reminder_{id}_same_day
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const SKIP_STATUSES = new Set(['cancelled', 'completed']);

// Lab appointment partnerStatus values that should not receive reminders.
const LAB_SKIP_PARTNER_STATUSES = new Set(['cancelled', 'completed', 'noshow', 'rejected']);

// ─── FCM fan-out ──────────────────────────────────────────────────────────────
// dataPayload overrides the default { appointmentId } — pass
// { clinicalRequestId } for lab appointment reminders.
async function sendFcmPush(db, recipientUid, notifContent, dataPayload) {
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
        data: dataPayload !== undefined
          ? dataPayload
          : { appointmentId: notifContent.appointmentId || '' },
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
          const code = response.responses[i].error && response.responses[i].error.code;
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
        `sendFcmPush: multicast error for uid=${recipientUid} lang=${lang}: ${e.message}`,
      );
    }
  }

  return { sent, cleaned };
}

exports.sendSameDayReminders = onSchedule(
  { schedule: '0 * * * *', timeZone: 'UTC' },
  async (_event) => {
    const db = getFirestore();
    const now = new Date();

    const windowStart = new Date(now.getTime() + 60 * 60 * 1000);      // +1 h
    const windowEnd   = new Date(now.getTime() + 2 * 60 * 60 * 1000);  // +2 h

    let created = 0;
    let skipped = 0;

    // ── Doctor appointments ────────────────────────────────────────────────────
    const snap = await db
      .collection('appointments')
      .where('appointmentAt', '>=', Timestamp.fromDate(windowStart))
      .where('appointmentAt', '<=', Timestamp.fromDate(windowEnd))
      .get();

    const active = snap.docs.filter((d) => !SKIP_STATUSES.has(d.data().status));

    console.log(
      `sendSameDayReminders: window=[${windowStart.toISOString()}, ` +
        `${windowEnd.toISOString()}] fetched=${snap.size} active=${active.length}`,
    );

    for (const doc of active) {
      const appt = doc.data();
      const appointmentId = doc.id;

      const recipientUid =
        appt.bookedByUserId && appt.bookedByUserId !== appt.patientId
          ? appt.bookedByUserId
          : appt.patientId;

      if (!recipientUid) {
        console.warn(`sendSameDayReminders: missing recipientUid on ${appointmentId}`);
        continue;
      }

      const reminderId = `reminder_${appointmentId}_same_day`;
      const notifRef = db
        .collection('users')
        .doc(recipientUid)
        .collection('notifications')
        .doc(reminderId);

      const existing = await notifRef.get();
      if (existing.exists) {
        skipped++;
        continue;
      }

      const nameEn = appt.doctorName_en || appt.doctorName || '';
      const nameAr = appt.doctorName_ar || appt.doctorName || '';
      const nameKu = appt.doctorName_ku || appt.doctorName || '';

      await notifRef.set({
        type: 'appointment_reminder',
        subtype: 'same_day',
        appointmentId,
        doctorName: appt.doctorName || '',
        doctorName_en: nameEn,
        doctorName_ar: nameAr,
        doctorName_ku: nameKu,
        appointmentAt: appt.appointmentAt || appt.slotStartAt || null,
        dateKey: appt.dateKey || '',
        titleEn: 'Appointment in About 2 Hours',
        titleAr: 'موعدك بعد ساعتين تقريباً',
        titleKu: 'نوبەتت لە نزیکەی ٢ کاتژمێردا',
        bodyEn: `Your appointment with Dr. ${nameEn} starts in approximately 2 hours.`,
        bodyAr: `موعدك مع الدكتور ${nameAr} يبدأ بعد ساعتين تقريباً.`,
        bodyKu: `نوبەتت لەگەڵ د. ${nameKu} لە نزیکەی ٢ کاتژمێردا دەستپێدەکات.`,
        isRead: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      created++;

      // Fan out FCM push — non-fatal; Firestore notification already written.
      try {
        const fcm = await sendFcmPush(db, recipientUid, {
          appointmentId,
          titleEn: 'Appointment in About 2 Hours',
          titleAr: 'موعدك بعد ساعتين تقريباً',
          titleKu: 'نوبەتت لە نزیکەی ٢ کاتژمێردا',
          bodyEn: `Your appointment with Dr. ${nameEn} starts in approximately 2 hours.`,
          bodyAr: `موعدك مع الدكتور ${nameAr} يبدأ بعد ساعتين تقريباً.`,
          bodyKu: `نوبەتت لەگەڵ د. ${nameKu} لە نزیکەی ٢ کاتژمێردا دەستپێدەکات.`,
        });
        console.log(
          `sendSameDayReminders: fcm appt=${appointmentId}` +
          ` sent=${fcm.sent} cleaned=${fcm.cleaned}`,
        );
      } catch (e) {
        console.error(
          `sendSameDayReminders: fcm non-fatal appt=${appointmentId}: ${e.message}`,
        );
      }
    }

    // ── Lab/imaging appointments (clinical_requests) ───────────────────────────
    // Patient self-booked lab appointments use slotStartAt (Timestamp) as the
    // canonical slot time. Filter client-side for patient-booked ones only.
    const labSnap = await db
      .collection('clinical_requests')
      .where('slotStartAt', '>=', Timestamp.fromDate(windowStart))
      .where('slotStartAt', '<=', Timestamp.fromDate(windowEnd))
      .get();

    const labActive = labSnap.docs.filter((d) => {
      const r = d.data();
      return (
        r.source             === 'scheduled' &&
        r.createdByRole      === 'patient'   &&
        r.requestDestination === 'partner'   &&
        !!r.patientId        &&
        !LAB_SKIP_PARTNER_STATUSES.has(r.partnerStatus) &&
        !SKIP_STATUSES.has(r.status)
      );
    });

    console.log(
      `sendSameDayReminders lab: window=[${windowStart.toISOString()}, ` +
      `${windowEnd.toISOString()}] fetched=${labSnap.size} active=${labActive.length}`,
    );

    for (const doc of labActive) {
      const req       = doc.data();
      const requestId = doc.id;

      // Lab appointments are always self-booked — recipient is the patient.
      const recipientUid = req.patientId;

      const labReminderId = `reminder_${requestId}_same_day`;
      const labNotifRef   = db
        .collection('users')
        .doc(recipientUid)
        .collection('notifications')
        .doc(labReminderId);

      // Idempotent: skip if already written
      const labExisting = await labNotifRef.get();
      if (labExisting.exists) {
        skipped++;
        continue;
      }

      const nameEn = req.providerName_en || req.providerName || '';
      const nameAr = req.providerName_ar || req.providerName || '';
      const nameKu = req.providerName_ku || req.providerName || '';

      await labNotifRef.set({
        type:              'lab_appointment',
        subtype:           'same_day',
        clinicalRequestId: requestId,
        providerName_en:   req.providerName_en || '',
        providerName_ar:   req.providerName_ar || '',
        providerName_ku:   req.providerName_ku || '',
        appointmentAt:     req.slotStartAt || null,
        dateKey:           req.dateKey || '',
        titleEn: 'Lab Appointment in About 2 Hours',
        titleAr: 'موعد المختبر بعد ساعتين تقريباً',
        titleKu: 'نیشتەجێبوونی تاقیگە لە نزیکەی ٢ کاتژمێردا',
        bodyEn: `Your lab appointment at ${nameEn || 'the laboratory'} starts in approximately 2 hours.`,
        bodyAr: `موعد مختبرك في ${nameAr || 'المختبر'} يبدأ بعد ساعتين تقريباً.`,
        bodyKu: `نیشتەجێبوونی تاقیگەکەت لە ${nameKu || 'تاقیگەکە'} لە نزیکەی ٢ کاتژمێردا دەستپێدەکات.`,
        isRead:    false,
        dismissed: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      created++;

      // Fan out FCM push — non-fatal; Firestore notification already written.
      try {
        const fcm = await sendFcmPush(
          db,
          recipientUid,
          {
            titleEn: 'Lab Appointment in About 2 Hours',
            titleAr: 'موعد المختبر بعد ساعتين تقريباً',
            titleKu: 'نیشتەجێبوونی تاقیگە لە نزیکەی ٢ کاتژمێردا',
            bodyEn: `Your lab appointment at ${nameEn || 'the laboratory'} starts in approximately 2 hours.`,
            bodyAr: `موعد مختبرك في ${nameAr || 'المختبر'} يبدأ بعد ساعتين تقريباً.`,
            bodyKu: `نیشتەجێبوونی تاقیگەکەت لە ${nameKu || 'تاقیگەکە'} لە نزیکەی ٢ کاتژمێردا دەستپێدەکات.`,
          },
          { clinicalRequestId: requestId },
        );
        console.log(
          `sendSameDayReminders lab: fcm req=${requestId}` +
          ` sent=${fcm.sent} cleaned=${fcm.cleaned}`,
        );
      } catch (e) {
        console.error(
          `sendSameDayReminders lab: fcm non-fatal req=${requestId}: ${e.message}`,
        );
      }
    }

    console.log(
      `sendSameDayReminders: done — created=${created} skipped=${skipped}`,
    );
  },
);
