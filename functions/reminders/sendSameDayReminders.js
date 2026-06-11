'use strict';

/**
 * sendSameDayReminders
 *
 * Fires every hour at minute 0 (0 * * * *).
 * Creates same-day reminders for appointments starting in 1–2 hours.
 *
 * Window logic:
 *   windowStart = now + 1 hour
 *   windowEnd   = now + 2 hours
 *   The 1-hour wide window aligns with the hourly schedule so each appointment
 *   falls in exactly one run. The deterministic doc ID provides safety against
 *   edge-case overlap (clock drift, cold-start delay, etc.).
 *
 * Uses appointmentAt (Timestamp) — this is the canonical slot start time
 * written by AppointmentBuilder.create() in the patient app.
 *
 * Recipient: bookedByUserId when it differs from patientId, otherwise patientId.
 * Deterministic doc ID: reminder_{appointmentId}_same_day
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const SKIP_STATUSES = new Set(['cancelled', 'completed']);

exports.sendSameDayReminders = onSchedule(
  { schedule: '0 * * * *', timeZone: 'UTC' },
  async (_event) => {
    const db = getFirestore();
    const now = new Date();

    const windowStart = new Date(now.getTime() + 60 * 60 * 1000);      // +1 h
    const windowEnd   = new Date(now.getTime() + 2 * 60 * 60 * 1000);  // +2 h

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

    let created = 0;
    let skipped = 0;

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
    }

    console.log(
      `sendSameDayReminders: done — created=${created} skipped=${skipped}`,
    );
  },
);
