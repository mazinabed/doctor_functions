/**
 * Offline safety check for scripts/reset_test_clinical_data.js.
 *
 * No credentials, no network, no Firestore — run it before the dry run:
 *
 *     node scripts/test_reset_test_clinical_data.js
 *
 * Two kinds of check, and the second is the one that matters:
 *
 *   1. The pure helpers behave as documented (id shapes, recipient resolution,
 *      argument parsing, dry-run default).
 *
 *   2. The reset script's notification ids are cross-checked against the SOURCE
 *      FILES THAT WRITE THEM, and its delete surface is checked structurally.
 *      A reset script that deletes by deterministic id is only correct for as
 *      long as those ids are what the writers actually produce — if someone
 *      renames a notification id or registers a new workflow over `appointments`
 *      or `clinical_requests`, the reset silently starts stranding records
 *      instead of failing. These assertions turn that silent drift into a
 *      failed check.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FUNCTIONS_ROOT = path.join(__dirname, '..');

const reset = require('./reset_test_clinical_data');

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSameSet(actual, expected, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert(
    a.length === e.length && a.every((v, i) => v === e[i]),
    `${label}\n          expected: ${JSON.stringify(e)}\n          actual:   ${JSON.stringify(a)}`,
  );
}

function read(relPath) {
  return fs.readFileSync(path.join(FUNCTIONS_ROOT, relPath), 'utf8');
}

/** Strips block and line comments so prose in a header cannot satisfy a code assertion. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

console.log('\nreset_test_clinical_data.js — offline safety check\n');

// ─── 1. Pure helpers ────────────────────────────────────────────────────────

check('clinical_request notification ids are the documented eight', () => {
  assertSameSet(
    reset.notificationIdsForClinicalRequest('REQ1'),
    [
      'referral_REQ1',
      'rx_created_REQ1',
      'lab_appt_created_REQ1',
      'reminder_REQ1_2_day',
      'reminder_REQ1_1_day',
      'reminder_REQ1_same_day',
      'wf_lab_order_REQ1',
      'wf_prescription_REQ1',
    ],
    'clinical_request id set drifted',
  );
});

check('appointment notification ids are the documented four', () => {
  assertSameSet(
    reset.notificationIdsForAppointment('APT1'),
    ['reminder_APT1_2_day', 'reminder_APT1_1_day', 'reminder_APT1_same_day', 'wf_appointment_APT1'],
    'appointment id set drifted',
  );
});

check('every built id embeds the source document id (no wildcard deletes)', () => {
  for (const id of [
    ...reset.notificationIdsForClinicalRequest('REQ1'),
    ...reset.notificationIdsForAppointment('APT1'),
  ]) {
    assert(/REQ1|APT1/.test(id), `id "${id}" is not scoped to a source document id`);
  }
});

check('appointment recipients are patientId + bookedByUserId only', () => {
  assertSameSet(
    reset.appointmentRecipientUids({
      patientId: 'p1',
      bookedByUserId: 'b1',
      doctorId: 'd1',
      centerId: 'c1',
    }),
    ['p1', 'b1'],
    'appointment recipient candidates widened beyond the appointment document',
  );
});

check('appointment recipients dedupe self-booking', () => {
  assertSameSet(
    reset.appointmentRecipientUids({ patientId: 'p1', bookedByUserId: 'p1' }),
    ['p1'],
    'self-booked appointment produced a duplicate uid',
  );
});

check('recipient helpers drop empty and non-string uids', () => {
  assertSameSet(
    reset.appointmentRecipientUids({ patientId: 'p1', bookedByUserId: '' }),
    ['p1'],
    'empty uid was not dropped',
  );
  assertSameSet(
    reset.clinicalRequestRecipientUids({
      patientId: 'p1',
      partnerProviderId: null,
      doctorId: undefined,
      centerId: 42,
    }),
    ['p1'],
    'non-string uid was not dropped',
  );
});

check('clinical_request recipients are the four fields the request names', () => {
  assertSameSet(
    reset.clinicalRequestRecipientUids({
      patientId: 'p1',
      partnerProviderId: 'pp1',
      doctorId: 'd1',
      centerId: 'c1',
    }),
    ['p1', 'pp1', 'd1', 'c1'],
    'clinical_request recipient candidates drifted',
  );
});

check('dry run is the default; --execute alone is not enough', () => {
  assert(reset.parseArgs([]).execute === false, 'no args should be a dry run');
  assert(reset.parseArgs([]).confirm === null, 'no args should carry no confirmation');
  const exec = reset.parseArgs(['--execute']);
  assert(exec.execute === true, '--execute not parsed');
  assert(exec.confirm === null, '--execute alone must not supply a confirmation');
  const full = reset.parseArgs(['--execute', `--confirm=${reset.REQUIRED_CONFIRMATION}`]);
  assert(full.confirm === reset.REQUIRED_CONFIRMATION, 'confirmation not parsed');
});

check('project and confirmation guards hold their expected values', () => {
  assert(reset.REQUIRED_PROJECT_ID === 'doctorapp-7e8b3', 'project guard changed');
  assert(reset.REQUIRED_CONFIRMATION === 'RESET-TEST-CLINICAL-DATA', 'confirmation string changed');
  assertSameSet(
    reset.TARGET_COLLECTIONS,
    ['appointments', 'clinical_requests', 'schedules', 'slot_locks'],
    'target collection set changed',
  );
});

check('volume ceilings are set for every target collection', () => {
  for (const name of reset.TARGET_COLLECTIONS) {
    assert(
      typeof reset.MAX_EXPECTED[name] === 'number' && reset.MAX_EXPECTED[name] > 0,
      `no volume ceiling for ${name}`,
    );
  }
});

// ─── 2. Cross-checks against the real notification writers ──────────────────

check('reminder id templates still match reminders/*.js', () => {
  const daily = read('reminders/sendDailyReminders.js');
  const sameDay = read('reminders/sendSameDayReminders.js');

  assert(
    daily.includes('`reminder_${appointmentId}_${subtype}`'),
    'sendDailyReminders no longer builds reminder_{appointmentId}_{subtype}',
  );
  assert(
    daily.includes('`reminder_${requestId}_${subtype}`'),
    'sendDailyReminders no longer builds reminder_{requestId}_{subtype}',
  );
  assert(
    sameDay.includes('`reminder_${appointmentId}_same_day`'),
    'sendSameDayReminders no longer builds reminder_{appointmentId}_same_day',
  );
  assert(
    sameDay.includes('`reminder_${requestId}_same_day`'),
    'sendSameDayReminders no longer builds reminder_{requestId}_same_day',
  );

  // The subtype values are what turn one template into two concrete ids.
  const subtypes = [...daily.matchAll(/subtype:\s*'([^']+)'/g)].map((m) => m[1]);
  assertSameSet(subtypes, ['2_day', '1_day'], 'SUBTYPES changed — reminder ids would drift');
});

check('clinical-request notification ids still match their writers', () => {
  const referral = read('notifications/onClinicalReferralCreated.js');
  const labAppt = read('notifications/onLabAppointmentCreated.js');
  assert(
    referral.includes('`referral_${requestId}`'),
    'onClinicalReferralCreated no longer builds referral_{requestId}',
  );
  assert(
    referral.includes('`rx_created_${requestId}`'),
    'onClinicalReferralCreated no longer builds rx_created_{requestId}',
  );
  assert(
    labAppt.includes('`lab_appt_created_${requestId}`'),
    'onLabAppointmentCreated no longer builds lab_appt_created_{requestId}',
  );
});

check('workflow notification id scheme is still wf_{workflowType}_{entityId}', () => {
  const engine = read('lib/notificationPlatform/notificationEngine.js');
  assert(
    engine.includes('`wf_${workflowType}_${entityId}`'),
    'notificationEngine changed its notification id scheme',
  );
});

check('every workflow over a target collection is covered by the reset', () => {
  // Read the registry rather than hardcoding: a NEW workflow registered over
  // `appointments` or `clinical_requests` writes a wf_* notification the reset
  // would otherwise strand. This is the check that catches that.
  const dir = path.join(FUNCTIONS_ROOT, 'lib', 'notificationPlatform', 'workflows');
  const expected = { appointments: [], clinical_requests: [] };

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const type = /workflowType:\s*'([^']+)'/.exec(src);
    const collection = /entityCollection:\s*'([^']+)'/.exec(src);
    if (!type || !collection) continue;
    if (expected[collection[1]]) expected[collection[1]].push(`wf_${type[1]}_ID`);
  }

  assert(
    expected.appointments.length > 0 && expected.clinical_requests.length > 0,
    'workflow registry could not be parsed — the coverage check is not actually running',
  );

  const apptWf = reset.notificationIdsForAppointment('ID').filter((i) => i.startsWith('wf_'));
  const crWf = reset.notificationIdsForClinicalRequest('ID').filter((i) => i.startsWith('wf_'));

  assertSameSet(
    apptWf,
    expected.appointments,
    'appointment workflow coverage drifted from the registry',
  );
  assertSameSet(
    crWf,
    expected.clinical_requests,
    'clinical_request workflow coverage drifted from the registry',
  );
});

check('no delete trigger exists that this reset would bypass or double-fire', () => {
  // The whole reason the derived records are in scope. If a delete trigger is
  // ever added, this script's design assumption changes and it must be revisited.
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // `scripts/` is skipped: nothing there is a deployed Cloud Function, and
      // these two files name onDocumentDeleted in prose.
      if (entry.name === 'node_modules' || entry.name === 'scripts' || entry.name.startsWith('.'))
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /onDocumentDeleted/.test(fs.readFileSync(full, 'utf8')))
        hits.push(path.relative(FUNCTIONS_ROOT, full));
    }
  };
  walk(FUNCTIONS_ROOT);
  assert(
    hits.length === 0,
    `onDocumentDeleted trigger(s) now exist — revisit the reset design:\n          ${hits.join('\n          ')}`,
  );
});

// ─── 3. Structural safety of the reset script itself ────────────────────────

const resetSource = codeOnly(read('scripts/reset_test_clinical_data.js'));

check('no collection-group or recursive delete surface', () => {
  for (const forbidden of [
    'collectionGroup',
    'recursiveDelete',
    'listCollections',
    'listDocuments',
    'bulkWriter',
    'deleteCollection',
  ]) {
    assert(!resetSource.includes(forbidden), `reset script uses ${forbidden}`);
  }
});

check('the only Firestore mutation is delete', () => {
  for (const forbidden of ['.set(', '.update(', '.add(', '.create(', 'FieldValue']) {
    assert(!resetSource.includes(forbidden), `reset script performs a write: ${forbidden}`);
  }
  assert(resetSource.includes('batch.delete(ref)'), 'reset script no longer deletes by ref');
});

check('no credential file is read from this repo', () => {
  for (const forbidden of ['serviceAccount', 'credential.cert', 'applicationDefault(']) {
    assert(!resetSource.includes(forbidden), `reset script references ${forbidden}`);
  }
  assert(!/require\(['"][^'"]*\.json['"]\)/.test(resetSource), 'reset script requires a .json file');
  assert(
    resetSource.includes('admin.initializeApp()'),
    'reset script no longer uses Application Default Credentials',
  );
});

check('collections touched are limited to the approved set', () => {
  const APPROVED = new Set([
    'appointments',
    'clinical_requests',
    'schedules',
    'slot_locks',
    'patient_referral_requests',
    'attachments',
    'users',
    'notifications',
  ]);
  const literals = [...resetSource.matchAll(/\.collection\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1],
  );
  const unexpected = literals.filter((n) => !APPROVED.has(n));
  assert(
    unexpected.length === 0,
    `reset script touches unapproved collection(s): ${[...new Set(unexpected)].join(', ')}`,
  );
});

check('the project guard aborts rather than continuing', () => {
  assert(
    /projectId !== REQUIRED_PROJECT_ID[\s\S]{0,400}process\.exit\(1\)/.test(resetSource),
    'the wrong-project branch no longer exits',
  );
});

check('--execute without the exact confirmation aborts', () => {
  assert(
    /confirm !== REQUIRED_CONFIRMATION[\s\S]{0,400}process\.exit\(1\)/.test(resetSource),
    'the missing-confirmation branch no longer exits',
  );
});

console.log(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check(s) FAILED — do not run the reset until resolved.\n`,
);
process.exit(failures === 0 ? 0 : 1);
