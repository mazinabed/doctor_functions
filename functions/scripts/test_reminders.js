'use strict';

/**
 * Manual test runner for appointment reminder Cloud Functions.
 * Runs the exact same logic as sendDailyReminders / sendSameDayReminders
 * against the live Firestore database using the service account.
 *
 * Usage (from the functions/ directory):
 *
 *   # Preview 2-day + 1-day reminders (no writes)
 *   node scripts/test_reminders.js daily --dry-run
 *
 *   # Actually write 2-day + 1-day reminders
 *   node scripts/test_reminders.js daily
 *
 *   # Preview same-day reminders with the live [now+1h, now+2h] window
 *   node scripts/test_reminders.js same-day --dry-run
 *
 *   # Actually write same-day reminders with the live window
 *   node scripts/test_reminders.js same-day
 *
 *   # Test same-day with a shifted window — useful when no appointment
 *   # falls in the next 2 hours.  --window-start and --window-end are
 *   # hours from now (can be negative to look into the past).
 *   node scripts/test_reminders.js same-day --window-start 0 --window-end 48
 *
 *   # Run both functions back-to-back (dry-run)
 *   node scripts/test_reminders.js all --dry-run
 */

const path   = require('path');
const admin  = require('firebase-admin');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ─── Init ─────────────────────────────────────────────────────────────────────
const serviceAccount = require(
  path.resolve(__dirname, '../doctorapp-7e8b3-firebase-adminsdk-fbsvc-32f7844f03.json'),
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = getFirestore();

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const mode     = args[0];                             // 'daily' | 'same-day' | 'all'
const dryRun   = args.includes('--dry-run');
const wsIdx    = args.indexOf('--window-start');
const weIdx    = args.indexOf('--window-end');
const windowStartHours = wsIdx !== -1 ? parseFloat(args[wsIdx + 1]) : 1;
const windowEndHours   = weIdx !== -1 ? parseFloat(args[weIdx + 1]) : 2;

if (!['daily', 'same-day', 'all'].includes(mode)) {
  console.error('Usage: node scripts/test_reminders.js <daily|same-day|all> [--dry-run] [--window-start N] [--window-end N]');
  process.exit(1);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const SKIP_STATUSES = new Set(['cancelled', 'completed']);

function baghdadDateKey(offsetDays) {
  const now     = new Date();
  const baghdad = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  baghdad.setUTCDate(baghdad.getUTCDate() + offsetDays);
  const y = baghdad.getUTCFullYear();
  const m = String(baghdad.getUTCMonth() + 1).padStart(2, '0');
  const d = String(baghdad.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildDailyContent(subtype, appt) {
  const nameEn = appt.doctorName_en || appt.doctorName || '(unknown)';
  const nameAr = appt.doctorName_ar || appt.doctorName || '(unknown)';
  const nameKu = appt.doctorName_ku || appt.doctorName || '(unknown)';
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

function recipient(appt) {
  return (appt.bookedByUserId && appt.bookedByUserId !== appt.patientId)
    ? appt.bookedByUserId
    : appt.patientId;
}

function bar() { console.log('─'.repeat(60)); }
function section(title) { console.log('\n' + '━'.repeat(60)); console.log(` ${title}`); console.log('━'.repeat(60)); }

// ─── sendDailyReminders logic ─────────────────────────────────────────────────

async function runDailyReminders() {
  section(`sendDailyReminders  [${dryRun ? 'DRY-RUN — no writes' : 'LIVE — writing to Firestore'}]`);

  const baghdadToday = baghdadDateKey(0);
  const key2day      = baghdadDateKey(2);
  const key1day      = baghdadDateKey(1);
  console.log(`\n  Baghdad today   : ${baghdadToday}`);
  console.log(`  Target (2_day)  : ${key2day}`);
  console.log(`  Target (1_day)  : ${key1day}`);
  bar();

  const subtypes = [
    { offset: 2, subtype: '2_day' },
    { offset: 1, subtype: '1_day' },
  ];

  let created = 0, skipped = 0, errors = 0;

  for (const { offset, subtype } of subtypes) {
    const targetDateKey = baghdadDateKey(offset);
    console.log(`\n[${subtype}]  dateKey = ${targetDateKey}`);
    bar();

    const snap = await db.collection('appointments')
      .where('dateKey', '==', targetDateKey)
      .get();

    const active = snap.docs.filter((d) => !SKIP_STATUSES.has(d.data().status));
    console.log(`  Fetched: ${snap.size}  Active: ${active.length}`);

    if (active.length === 0) {
      console.log('  → No active appointments on this date.');
      continue;
    }

    for (const doc of active) {
      const appt = doc.data();
      const uid  = recipient(appt);

      if (!uid) {
        console.warn(`  ⚠  ${doc.id}: missing patientId/bookedByUserId — skip`);
        errors++;
        continue;
      }

      const reminderId = `reminder_${doc.id}_${subtype}`;
      const notifRef   = db.collection('users').doc(uid)
        .collection('notifications').doc(reminderId);

      const existing = await notifRef.get();
      const status   = existing.exists ? 'EXISTS — skip' : 'NEW';

      const content = buildDailyContent(subtype, appt);
      const dateKeyMatch = appt.dateKey === targetDateKey;
      console.log(`  ${status === 'NEW' ? '✓' : '○'}  appt=${doc.id}`);
      console.log(`     appt.dateKey=${appt.dateKey}  target=${targetDateKey}  match=${dateKeyMatch}`);
      console.log(`     recipient=${uid}  (${appt.bookedByUserId !== appt.patientId ? 'bookedBy' : 'patient'})`);
      console.log(`     notifId=${reminderId}  → ${status}`);
      console.log(`     title: "${content.titleEn}"`);

      if (status === 'NEW' && !dryRun) {
        try {
          await notifRef.set({
            type: 'appointment_reminder', subtype,
            appointmentId: doc.id,
            doctorName:    appt.doctorName    || '',
            doctorName_en: appt.doctorName_en || appt.doctorName || '',
            doctorName_ar: appt.doctorName_ar || appt.doctorName || '',
            doctorName_ku: appt.doctorName_ku || appt.doctorName || '',
            appointmentAt: appt.appointmentAt || appt.slotStartAt || null,
            dateKey:       appt.dateKey || targetDateKey,
            titleEn: content.titleEn, titleAr: content.titleAr, titleKu: content.titleKu,
            bodyEn:  content.bodyEn,  bodyAr:  content.bodyAr,  bodyKu:  content.bodyKu,
            isRead: false,
            createdAt: FieldValue.serverTimestamp(),
          });
          console.log('     ✅ Written');
          created++;
        } catch (e) {
          console.error(`     ❌ Write failed: ${e.message}`);
          errors++;
        }
      } else if (status === 'NEW' && dryRun) {
        console.log('     [dry-run] would write');
        created++;
      } else {
        skipped++;
      }
    }
  }

  bar();
  console.log(`\nResult: created=${created}  skipped=${skipped}  errors=${errors}  dry-run=${dryRun}\n`);
}

// ─── sendSameDayReminders logic ───────────────────────────────────────────────

async function runSameDayReminders() {
  section(`sendSameDayReminders  [${dryRun ? 'DRY-RUN — no writes' : 'LIVE — writing to Firestore'}]`);

  const now         = new Date();
  const windowStart = new Date(now.getTime() + windowStartHours * 60 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + windowEndHours   * 60 * 60 * 1000);

  console.log(`\n  Now         : ${now.toISOString()}`);
  console.log(`  Window start: ${windowStart.toISOString()}  (+${windowStartHours}h)`);
  console.log(`  Window end  : ${windowEnd.toISOString()}  (+${windowEndHours}h)`);
  bar();

  const snap = await db.collection('appointments')
    .where('appointmentAt', '>=', Timestamp.fromDate(windowStart))
    .where('appointmentAt', '<=', Timestamp.fromDate(windowEnd))
    .get();

  const active = snap.docs.filter((d) => !SKIP_STATUSES.has(d.data().status));
  console.log(`  Fetched: ${snap.size}  Active: ${active.length}`);

  if (active.length === 0) {
    console.log('  → No active appointments in this window.');
    console.log('  Tip: use --window-start 0 --window-end 48 to scan the next 48 hours.\n');
  }

  let created = 0, skipped = 0, errors = 0;

  for (const doc of active) {
    const appt = doc.data();
    const uid  = recipient(appt);

    if (!uid) {
      console.warn(`  ⚠  ${doc.id}: missing patientId/bookedByUserId — skip`);
      errors++;
      continue;
    }

    const reminderId = `reminder_${doc.id}_same_day`;
    const notifRef   = db.collection('users').doc(uid)
      .collection('notifications').doc(reminderId);

    const existing = await notifRef.get();
    const status   = existing.exists ? 'EXISTS — skip' : 'NEW';

    const nameEn = appt.doctorName_en || appt.doctorName || '(unknown)';
    const apptAt = (appt.appointmentAt || appt.slotStartAt)?.toDate?.() ?? '?';

    console.log(`  ${status === 'NEW' ? '✓' : '○'}  appt=${doc.id}`);
    console.log(`     appointmentAt=${apptAt}  doctor=${nameEn}`);
    console.log(`     recipient=${uid}  notifId=${reminderId}  → ${status}`);

    if (status === 'NEW' && !dryRun) {
      const nameAr = appt.doctorName_ar || appt.doctorName || '';
      const nameKu = appt.doctorName_ku || appt.doctorName || '';
      try {
        await notifRef.set({
          type: 'appointment_reminder', subtype: 'same_day',
          appointmentId: doc.id,
          doctorName:    appt.doctorName    || '',
          doctorName_en: nameEn,
          doctorName_ar: nameAr,
          doctorName_ku: nameKu,
          appointmentAt: appt.appointmentAt || appt.slotStartAt || null,
          dateKey:       appt.dateKey || '',
          titleEn: 'Appointment in About 2 Hours',
          titleAr: 'موعدك بعد ساعتين تقريباً',
          titleKu: 'نوبەتت لە نزیکەی ٢ کاتژمێردا',
          bodyEn: `Your appointment with Dr. ${nameEn} starts in approximately 2 hours.`,
          bodyAr: `موعدك مع الدكتور ${nameAr} يبدأ بعد ساعتين تقريباً.`,
          bodyKu: `نوبەتت لەگەڵ د. ${nameKu} لە نزیکەی ٢ کاتژمێردا دەستپێدەکات.`,
          isRead: false,
          createdAt: FieldValue.serverTimestamp(),
        });
        console.log('     ✅ Written');
        created++;
      } catch (e) {
        console.error(`     ❌ Write failed: ${e.message}`);
        errors++;
      }
    } else if (status === 'NEW' && dryRun) {
      console.log('     [dry-run] would write');
      created++;
    } else {
      skipped++;
    }
  }

  bar();
  console.log(`\nResult: created=${created}  skipped=${skipped}  errors=${errors}  dry-run=${dryRun}\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nTrustyDr Reminder Test  |  mode=${mode}  dry-run=${dryRun}`);
  console.log(`Project: doctorapp-7e8b3  |  ${new Date().toISOString()}`);

  if (mode === 'daily' || mode === 'all')    await runDailyReminders();
  if (mode === 'same-day' || mode === 'all') await runSameDayReminders();

  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
