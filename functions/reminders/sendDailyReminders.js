'use strict';

/**
 * sendDailyReminders
 *
 * Fires daily at 09:00 Baghdad time (06:00 UTC).
 * Creates 2-day and 1-day appointment reminder notifications.
 *
 * Design:
 *   - Queries appointments by dateKey ('YYYY-MM-DD' in Baghdad time, UTC+3)
 *   - Filters cancelled/completed client-side to avoid requiring a composite index
 *   - Recipient: bookedByUserId when it differs from patientId (family/staff booking),
 *     otherwise patientId
 *   - Deterministic doc ID: reminder_{appointmentId}_{subtype}
 *     — existence check prevents duplicates on re-runs
 *   - After writing a NEW notification doc, fans out FCM push to stored device tokens
 *   - FCM failure is non-fatal — the Firestore notification is always written first
 *   - Admin SDK bypasses Firestore security rules
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const SKIP_STATUSES = new Set(['cancelled', 'completed']);

const SUBTYPES = [
  { offset: 2, subtype: '2_day' },
  { offset: 1, subtype: '1_day' },
];

// Returns YYYY-MM-DD offset from today in Baghdad local time (UTC+3).
function baghdadDateKey(offsetDays) {
  const now = new Date();
  const baghdad = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  baghdad.setUTCDate(baghdad.getUTCDate() + offsetDays);
  const y = baghdad.getUTCFullYear();
  const m = String(baghdad.getUTCMonth() + 1).padStart(2, '0');
  const d = String(baghdad.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildContent(subtype, appt) {
  const nameEn = appt.doctorName_en || appt.doctorName || '';
  const nameAr = appt.doctorName_ar || appt.doctorName || '';
  const nameKu = appt.doctorName_ku || appt.doctorName || '';

  if (subtype === '2_day') {
    return {
      titleEn: 'Appointment in 2 Days',
      titleAr: 'موعدك بعد يومين',
      titleKu: 'نوبەتت لە ٢ ڕۆژدا',
      bodyEn: `Your appointment with Dr. ${nameEn} is in 2 days.`,
      bodyAr: `موعدك مع الدكتور ${nameAr} بعد يومين.`,
      bodyKu: `نوبەتت لەگەڵ د. ${nameKu} لە ٢ ڕۆژدایە.`,
    };
  }
  return {
    titleEn: 'Appointment Tomorrow',
    titleAr: 'موعدك غداً',
    titleKu: 'نوبەتت بەیانی',
    bodyEn: `Your appointment with Dr. ${nameEn} is tomorrow.`,
    bodyAr: `موعدك مع الدكتور ${nameAr} غداً.`,
    bodyKu: `نوبەتت لەگەڵ د. ${nameKu} بەیانییە.`,
  };
}

// ─── FCM fan-out ──────────────────────────────────────────────────────────────
// Sends push notifications to all stored FCM tokens for a recipient.
// Groups tokens by language so each device receives its preferred locale.
// Cleans up invalid/expired tokens automatically.
// Non-fatal: caller continues on any error.
async function sendFcmPush(db, recipientUid, notifContent) {
  const tokensSnap = await db
    .collection('users')
    .doc(recipientUid)
    .collection('fcmTokens')
    .get();

  if (tokensSnap.empty) return { sent: 0, cleaned: 0 };

  // Group token docs by language preference.
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
        data: { appointmentId: notifContent.appointmentId || '' },
        webpush: {
          notification: {
            icon:  '/icons/Icon-192.png',
            badge: '/icons/Icon-192.png',
          },
        },
      });

      sent += response.successCount;

      // Remove tokens that FCM reports as invalid or unregistered.
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

// ─── Scheduled function ───────────────────────────────────────────────────────

exports.sendDailyReminders = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'UTC' },
  async (_event) => {
    const db = getFirestore();
    let created = 0;
    let skipped = 0;

    const baghdadToday = baghdadDateKey(0);
    const key2day      = baghdadDateKey(2);
    const key1day      = baghdadDateKey(1);
    console.log(
      `sendDailyReminders: Baghdad today=${baghdadToday}` +
      `  target_2_day=${key2day}  target_1_day=${key1day}`,
    );

    for (const { offset, subtype } of SUBTYPES) {
      const targetDateKey = baghdadDateKey(offset);

      const snap = await db
        .collection('appointments')
        .where('dateKey', '==', targetDateKey)
        .get();

      // Filter client-side — avoids composite index requirement
      const active = snap.docs.filter((d) => !SKIP_STATUSES.has(d.data().status));

      console.log(
        `sendDailyReminders [${subtype}]: queried_dateKey=${targetDateKey} ` +
          `fetched=${snap.size} active=${active.length}`,
      );

      for (const doc of active) {
        const appt = doc.data();
        const appointmentId = doc.id;

        // Family booking: notify the user who booked, not the patient record
        const recipientUid =
          appt.bookedByUserId && appt.bookedByUserId !== appt.patientId
            ? appt.bookedByUserId
            : appt.patientId;

        if (!recipientUid) {
          console.warn(`sendDailyReminders: missing recipientUid on ${appointmentId}`);
          continue;
        }

        // Log the appointment's own dateKey — helps diagnose timezone mismatches during testing
        console.log(
          `sendDailyReminders [${subtype}]: appt=${appointmentId}` +
          `  appt.dateKey=${appt.dateKey || '(missing)'}` +
          `  target=${targetDateKey}` +
          `  match=${appt.dateKey === targetDateKey}`,
        );

        const reminderId = `reminder_${appointmentId}_${subtype}`;
        const notifRef = db
          .collection('users')
          .doc(recipientUid)
          .collection('notifications')
          .doc(reminderId);

        // Idempotent: skip if already written
        const existing = await notifRef.get();
        if (existing.exists) {
          skipped++;
          continue;
        }

        const content = buildContent(subtype, appt);

        await notifRef.set({
          type: 'appointment_reminder',
          subtype,
          appointmentId,
          doctorName: appt.doctorName || '',
          doctorName_en: appt.doctorName_en || appt.doctorName || '',
          doctorName_ar: appt.doctorName_ar || appt.doctorName || '',
          doctorName_ku: appt.doctorName_ku || appt.doctorName || '',
          appointmentAt: appt.appointmentAt || appt.slotStartAt || null,
          dateKey: appt.dateKey || targetDateKey,
          titleEn: content.titleEn,
          titleAr: content.titleAr,
          titleKu: content.titleKu,
          bodyEn: content.bodyEn,
          bodyAr: content.bodyAr,
          bodyKu: content.bodyKu,
          isRead: false,
          createdAt: FieldValue.serverTimestamp(),
        });

        created++;

        // Fan out FCM push — non-fatal; Firestore notification already written.
        try {
          const fcm = await sendFcmPush(db, recipientUid, {
            appointmentId,
            titleEn: content.titleEn,
            titleAr: content.titleAr,
            titleKu: content.titleKu,
            bodyEn: content.bodyEn,
            bodyAr: content.bodyAr,
            bodyKu: content.bodyKu,
          });
          console.log(
            `sendDailyReminders [${subtype}]: fcm appt=${appointmentId}` +
            ` sent=${fcm.sent} cleaned=${fcm.cleaned}`,
          );
        } catch (e) {
          console.error(
            `sendDailyReminders [${subtype}]: fcm non-fatal appt=${appointmentId}: ${e.message}`,
          );
        }
      }
    }

    console.log(
      `sendDailyReminders: done — created=${created} skipped=${skipped}`,
    );
  },
);
