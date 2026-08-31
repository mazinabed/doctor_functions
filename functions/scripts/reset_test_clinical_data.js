/**
 * ONE-TIME TEST DATA RESET — clinical/scheduling collections only.
 * =============================================================================
 *
 * Clears DOCUMENTS from exactly four top-level collections:
 *
 *     appointments · clinical_requests · schedules · slot_locks
 *
 * plus, for each deleted appointment and clinical_request, the derived records
 * that would otherwise be stranded (see "WHY THE EXTRAS" below). Collections
 * themselves are never deleted — Firestore has no such concept for a collection
 * with no documents — and nothing here issues a collection-group or
 * database-wide delete.
 *
 * DRY RUN BY DEFAULT. Deletion requires BOTH --execute and the exact
 * confirmation string. See USAGE at the bottom.
 *
 * -----------------------------------------------------------------------------
 * WHY THE EXTRAS ARE IN SCOPE
 * -----------------------------------------------------------------------------
 * There is not a single onDocumentDeleted trigger anywhere in this codebase
 * (verified by grep across functions/). Every trigger is Created/Updated only.
 * So deleting a source document fires NOTHING and cleans up NOTHING — the
 * derived records simply remain, pointing at a document that no longer exists,
 * and several of them are patient-visible.
 *
 * Every derived record below is addressed by a DETERMINISTIC id built from the
 * source document's own id, under a recipient uid named by the source document
 * itself. No collection-group scan, no field-equality sweep, no "delete
 * everything under this user" — the blast radius is bounded by construction.
 *
 * clinical_requests/{requestId}
 *   patient_referral_requests/{requestId}
 *       1:1 mirror. onClinicalReferralCreated.js:175 (create),
 *       onClinicalReferralStatusUpdated.js:76 (update).
 *
 *   clinical_requests/{requestId}/attachments/*
 *       Real subcollection (firestore.rules:2293). Deleting a parent document
 *       does NOT delete its subcollections, so these need explicit recursion.
 *
 *   users/{recipientUid}/notifications/{notifId} — eight ids:
 *         referral_{id}                 onClinicalReferralCreated.js:397
 *         rx_created_{id}               onClinicalReferralCreated.js:450
 *         lab_appt_created_{id}         onLabAppointmentCreated.js:125
 *         reminder_{id}_2_day           sendDailyReminders.js:339
 *         reminder_{id}_1_day           sendDailyReminders.js:339
 *         reminder_{id}_same_day        sendSameDayReminders.js:250
 *         wf_lab_order_{id}             notificationEngine.js:45 + labOrderWorkflow.js:43
 *         wf_prescription_{id}          notificationEngine.js:45 + prescriptionWorkflow.js:42
 *
 * appointments/{appointmentId}
 *   users/{recipientUid}/notifications/{notifId} — four ids:
 *         reminder_{id}_2_day           sendDailyReminders.js:246
 *         reminder_{id}_1_day           sendDailyReminders.js:246
 *         reminder_{id}_same_day        sendSameDayReminders.js:156
 *         wf_appointment_{id}           onAppointmentStatusUpdated.js:19,90
 *
 *       All three writers resolve the recipient identically:
 *           bookedByUserId when it differs from patientId, else patientId
 *       (sendDailyReminders.js:228, sendSameDayReminders.js:146,
 *        onAppointmentStatusUpdated.js:83). This script probes BOTH uids rather
 *       than recomputing that single winner — see appointmentRecipientUids().
 *
 * -----------------------------------------------------------------------------
 * NOT IN SCOPE — deliberately
 * -----------------------------------------------------------------------------
 * Notification subcollections are never enumerated or cleared. Only the exact
 * deterministic ids above are addressed, and only for source documents actually
 * being deleted. Any other notification a user holds is left untouched.
 *
 * Never touched: patient_prescriptions, users (the documents themselves),
 * doctors, medical_centers, pharmacy_providers, diagnostic_providers, patients,
 * medication/catalog, taxonomy, config, subscription plans, Commerce/Odoo,
 * rules, indexes. No Cloud Function is disabled — none needs to be, since no
 * delete trigger exists to suppress.
 *
 * -----------------------------------------------------------------------------
 * CREDENTIALS
 * -----------------------------------------------------------------------------
 * Uses Application Default Credentials via admin.initializeApp(), matching the
 * other scripts in this folder. It deliberately does NOT read, import, or
 * reference serviceAccount.json or any key file in this repo. Supply
 * credentials yourself at run time (gcloud ADC or GOOGLE_APPLICATION_CREDENTIALS).
 */

const admin = require("firebase-admin");

// ── Guards ──────────────────────────────────────────────────────────────────
const REQUIRED_PROJECT_ID = "doctorapp-7e8b3";
const REQUIRED_CONFIRMATION = "RESET-TEST-CLINICAL-DATA";

/**
 * Refuse to run against anything that looks like real volume. These are
 * deliberately low: this reset is for a pre-launch environment holding tester
 * records. If a count exceeds its ceiling the script aborts and prints the
 * number — raise it consciously, having looked, rather than by reflex.
 */
const MAX_EXPECTED = {
  appointments: 500,
  clinical_requests: 500,
  schedules: 500,
  slot_locks: 2000, // ephemeral locks churn faster than the rest
};

const TARGET_COLLECTIONS = ["appointments", "clinical_requests", "schedules", "slot_locks"];

/** Collections whose documents are deleted outright, with no derived records. */
const PLAIN_COLLECTIONS = ["schedules", "slot_locks"];

/** Notification ids derived from a clinical_request id. */
function notificationIdsForClinicalRequest(requestId) {
  return [
    `referral_${requestId}`,
    `rx_created_${requestId}`,
    `lab_appt_created_${requestId}`,
    `reminder_${requestId}_2_day`,
    `reminder_${requestId}_1_day`,
    `reminder_${requestId}_same_day`,
    `wf_lab_order_${requestId}`,
    `wf_prescription_${requestId}`,
  ];
}

/** Notification ids derived from an appointment id. */
function notificationIdsForAppointment(appointmentId) {
  return [
    `reminder_${appointmentId}_2_day`,
    `reminder_${appointmentId}_1_day`,
    `reminder_${appointmentId}_same_day`,
    `wf_appointment_${appointmentId}`,
  ];
}

function uniqueUids(values) {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

/**
 * Users who could hold a notification for this clinical request. Read from the
 * request document itself rather than discovered by a scan, so the blast radius
 * stays bounded to uids this request actually names.
 */
function clinicalRequestRecipientUids(data) {
  return uniqueUids([data.patientId, data.partnerProviderId, data.doctorId, data.centerId]);
}

/**
 * Users who could hold a notification for this appointment.
 *
 * The three writers all resolve a SINGLE recipient as
 *     bookedByUserId when it differs from patientId, else patientId
 * so recomputing that rule would name one uid. This returns BOTH candidates
 * instead — deliberately. A notification written before bookedByUserId was set
 * (or before it changed) sits under the other uid, and recomputing today's
 * winner would silently strand it. Both uids come from the appointment document
 * itself, and every candidate is existence-checked before it is queued, so
 * probing two rather than one widens nothing: a document that does not exist is
 * never deleted.
 */
function appointmentRecipientUids(data) {
  return uniqueUids([data.patientId, data.bookedByUserId]);
}

function parseArgs(argv) {
  const execute = argv.includes("--execute");
  const confirmArg = argv.find((a) => a.startsWith("--confirm="));
  const confirm = confirmArg ? confirmArg.slice("--confirm=".length) : null;
  return { execute, confirm };
}

function banner(mode) {
  console.log("=".repeat(78));
  console.log(`  TEST CLINICAL DATA RESET — ${mode}`);
  console.log(`  project: ${REQUIRED_PROJECT_ID}`);
  console.log("=".repeat(78));
}

function resolveProjectId() {
  const app = admin.app();
  const fromOptions = app.options && app.options.projectId;
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  return fromOptions || fromEnv || null;
}

/** Deletes an array of DocumentReferences in chunks, respecting the 500-op batch cap. */
async function deleteRefs(db, refs) {
  const CHUNK = 400;
  let deleted = 0;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const ref of slice) batch.delete(ref);
    await batch.commit();
    deleted += slice.length;
  }
  return deleted;
}

/** Collects every document ref in a collection (ids only — no field data read). */
async function listRefs(collectionRef) {
  const snap = await collectionRef.select().get();
  return snap.docs.map((d) => d.ref);
}

/**
 * Existence-checks each (uid, notifId) pair and returns refs for those that
 * actually exist, so the printed plan is the literal delete list.
 */
async function existingNotificationRefs(db, uids, notifIds) {
  const found = [];
  for (const uid of uids) {
    for (const notifId of notifIds) {
      const ref = db.collection("users").doc(uid).collection("notifications").doc(notifId);
      // eslint-disable-next-line no-await-in-loop
      const snap = await ref.get();
      if (snap.exists) found.push(ref);
    }
  }
  return found;
}

async function buildPlan(db) {
  const plan = {
    counts: {},
    appointments: [],
    clinicalRequests: [],
    plain: {},
    totals: {
      attachments: 0,
      referralMirrors: 0,
      clinicalRequestNotifications: 0,
      appointmentNotifications: 0,
    },
  };

  for (const name of PLAIN_COLLECTIONS) {
    const refs = await listRefs(db.collection(name));
    plan.counts[name] = refs.length;
    plan.plain[name] = refs;
  }

  // ── appointments ──────────────────────────────────────────────────────────
  const apptSnap = await db.collection("appointments").get();
  plan.counts.appointments = apptSnap.size;
  for (const doc of apptSnap.docs) {
    const data = doc.data() || {};
    const recipients = appointmentRecipientUids(data);
    const notifRefs = await existingNotificationRefs(
      db,
      recipients,
      notificationIdsForAppointment(doc.id),
    );
    plan.appointments.push({ id: doc.id, docRef: doc.ref, notifRefs, recipients });
    plan.totals.appointmentNotifications += notifRefs.length;
  }

  // ── clinical_requests ─────────────────────────────────────────────────────
  const crSnap = await db.collection("clinical_requests").get();
  plan.counts.clinical_requests = crSnap.size;
  for (const doc of crSnap.docs) {
    const requestId = doc.id;
    const data = doc.data() || {};

    const attachments = await listRefs(doc.ref.collection("attachments"));

    const mirrorRef = db.collection("patient_referral_requests").doc(requestId);
    const mirrorSnap = await mirrorRef.get();

    const recipients = clinicalRequestRecipientUids(data);
    const notifRefs = await existingNotificationRefs(
      db,
      recipients,
      notificationIdsForClinicalRequest(requestId),
    );

    plan.clinicalRequests.push({
      id: requestId,
      docRef: doc.ref,
      attachments,
      mirrorRef: mirrorSnap.exists ? mirrorRef : null,
      notifRefs,
      recipients,
    });

    plan.totals.attachments += attachments.length;
    plan.totals.referralMirrors += mirrorSnap.exists ? 1 : 0;
    plan.totals.clinicalRequestNotifications += notifRefs.length;
  }

  return plan;
}

function printPlan(plan) {
  console.log("\n── COUNTS BEFORE ────────────────────────────────────────────────");
  for (const name of TARGET_COLLECTIONS) {
    console.log(`  ${name.padEnd(20)} ${plan.counts[name]}`);
  }

  console.log("\n── DERIVED RECORDS ALSO IN SCOPE ────────────────────────────────");
  console.log(`  attachments (clinical_requests subcollection)  ${plan.totals.attachments}`);
  console.log(`  patient_referral_requests mirrors              ${plan.totals.referralMirrors}`);
  console.log(
    `  notifications (from clinical_requests)         ${plan.totals.clinicalRequestNotifications}`,
  );
  console.log(
    `  notifications (from appointments)              ${plan.totals.appointmentNotifications}`,
  );

  console.log("\n── EXACT DOCUMENTS TO DELETE ────────────────────────────────────");
  for (const item of plan.appointments) {
    console.log(`  appointments/${item.id}`);
    for (const ref of item.notifRefs) console.log(`      ${ref.path}`);
  }
  for (const item of plan.clinicalRequests) {
    console.log(`  clinical_requests/${item.id}`);
    for (const ref of item.attachments) console.log(`      ${ref.path}`);
    if (item.mirrorRef) console.log(`      ${item.mirrorRef.path}`);
    for (const ref of item.notifRefs) console.log(`      ${ref.path}`);
  }
  for (const name of PLAIN_COLLECTIONS) {
    for (const ref of plan.plain[name]) console.log(`  ${ref.path}`);
  }
}

function assertSaneVolume(plan) {
  const problems = [];
  for (const [name, max] of Object.entries(MAX_EXPECTED)) {
    if (plan.counts[name] > max) {
      problems.push(`${name}: ${plan.counts[name]} documents exceeds the ${max} ceiling`);
    }
  }
  if (problems.length > 0) {
    console.error("\nABORTING — this does not look like a test-only dataset:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nNothing was deleted. Inspect the data, then raise MAX_EXPECTED deliberately\n" +
        "if the volume is genuinely expected.",
    );
    process.exit(1);
  }
}

async function verifyAfter(db, plan) {
  console.log("\n── VERIFICATION ─────────────────────────────────────────────────");
  let ok = true;

  for (const name of TARGET_COLLECTIONS) {
    // eslint-disable-next-line no-await-in-loop
    const remaining = (await db.collection(name).select().limit(1).get()).size;
    const label = remaining === 0 ? "0 remaining  OK" : `${remaining}+ REMAINING`;
    console.log(`  ${name.padEnd(34)} ${label}`);
    if (remaining !== 0) ok = false;
  }

  // Orphaned referral mirrors — a mirror whose source clinical_request is gone.
  const staleMirrors = [];
  for (const item of plan.clinicalRequests) {
    const ref = db.collection("patient_referral_requests").doc(item.id);
    // eslint-disable-next-line no-await-in-loop
    const snap = await ref.get();
    if (snap.exists) staleMirrors.push(item.id);
  }
  console.log(
    `  ${"orphaned patient_referral_requests".padEnd(34)} ${
      staleMirrors.length === 0 ? "none  OK" : `${staleMirrors.length} REMAINING`
    }`,
  );
  if (staleMirrors.length > 0) {
    ok = false;
    for (const id of staleMirrors) console.log(`      patient_referral_requests/${id}`);
  }

  // Every notification this run planned to delete is actually gone.
  const planned = [
    ...plan.appointments.flatMap((i) => i.notifRefs),
    ...plan.clinicalRequests.flatMap((i) => i.notifRefs),
  ];
  const staleNotifs = [];
  for (const ref of planned) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await ref.get();
    if (snap.exists) staleNotifs.push(ref.path);
  }
  console.log(
    `  ${"orphaned notifications".padEnd(34)} ${
      staleNotifs.length === 0 ? "none  OK" : `${staleNotifs.length} REMAINING`
    }`,
  );
  if (staleNotifs.length > 0) {
    ok = false;
    for (const p of staleNotifs) console.log(`      ${p}`);
  }

  return ok;
}

async function main() {
  const { execute, confirm } = parseArgs(process.argv.slice(2));

  admin.initializeApp();
  const projectId = resolveProjectId();

  if (projectId !== REQUIRED_PROJECT_ID) {
    console.error(
      `\nABORTING — wrong project.\n  expected: ${REQUIRED_PROJECT_ID}\n  resolved: ${
        projectId || "(none — no ADC / GOOGLE_CLOUD_PROJECT set)"
      }\n`,
    );
    process.exit(1);
  }

  const db = admin.firestore();
  banner(execute ? "EXECUTE" : "DRY RUN");

  const plan = await buildPlan(db);
  printPlan(plan);
  assertSaneVolume(plan);

  if (!execute) {
    console.log("\nDRY RUN — nothing was deleted.");
    console.log(`To delete, re-run with:\n  --execute --confirm=${REQUIRED_CONFIRMATION}\n`);
    return;
  }

  if (confirm !== REQUIRED_CONFIRMATION) {
    console.error(
      `\nABORTING — --execute requires --confirm=${REQUIRED_CONFIRMATION}\n` +
        `  got: ${confirm === null ? "(missing)" : confirm}\n`,
    );
    process.exit(1);
  }

  console.log("\n── DELETING ─────────────────────────────────────────────────────");

  // Dependents first, source last. Nothing here fires a trigger (there are no
  // delete triggers), but this ordering means an interrupted run never leaves a
  // derived record whose source is already gone.
  let apptNotifs = 0;
  for (const item of plan.appointments) {
    apptNotifs += await deleteRefs(db, item.notifRefs);
    await deleteRefs(db, [item.docRef]);
  }
  console.log(`  ${"notifications (appointments)".padEnd(30)} ${apptNotifs}`);
  console.log(`  ${"appointments".padEnd(30)} ${plan.appointments.length}`);

  let crNotifs = 0;
  let attachments = 0;
  let mirrors = 0;
  for (const item of plan.clinicalRequests) {
    crNotifs += await deleteRefs(db, item.notifRefs);
    attachments += await deleteRefs(db, item.attachments);
    if (item.mirrorRef) mirrors += await deleteRefs(db, [item.mirrorRef]);
    await deleteRefs(db, [item.docRef]);
  }
  console.log(`  ${"notifications (clinical_requests)".padEnd(30)} ${crNotifs}`);
  console.log(`  ${"attachments".padEnd(30)} ${attachments}`);
  console.log(`  ${"patient_referral_requests".padEnd(30)} ${mirrors}`);
  console.log(`  ${"clinical_requests".padEnd(30)} ${plan.clinicalRequests.length}`);

  for (const name of PLAIN_COLLECTIONS) {
    const n = await deleteRefs(db, plan.plain[name]);
    console.log(`  ${name.padEnd(30)} ${n}`);
  }

  const ok = await verifyAfter(db, plan);
  console.log(
    ok
      ? "\nDONE — all four collections are empty, no referral mirrors orphaned,\n" +
          "and every targeted notification is gone."
      : "\nCOMPLETED WITH WARNINGS — see REMAINING entries above.",
  );
  if (!ok) process.exit(2);
}

// Only run when invoked directly, so scripts/test_reset_test_clinical_data.js
// can require the pure helpers without touching Firestore.
if (require.main === module) {
  main().catch((err) => {
    console.error("\nFAILED:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_PROJECT_ID,
  REQUIRED_CONFIRMATION,
  MAX_EXPECTED,
  TARGET_COLLECTIONS,
  PLAIN_COLLECTIONS,
  notificationIdsForClinicalRequest,
  notificationIdsForAppointment,
  clinicalRequestRecipientUids,
  appointmentRecipientUids,
  parseArgs,
};

/*
 * USAGE
 * -----
 * From doctor_functions/functions (firebase-admin lives in its node_modules):
 *
 *   # 1. dry run — prints counts and every exact document path, deletes nothing
 *   node scripts/reset_test_clinical_data.js
 *
 *   # 2. after reviewing the dry-run output
 *   node scripts/reset_test_clinical_data.js --execute --confirm=RESET-TEST-CLINICAL-DATA
 *
 * Offline safety check (no credentials, no network):
 *   node scripts/test_reset_test_clinical_data.js
 *
 * Credentials come from Application Default Credentials — set
 * GOOGLE_APPLICATION_CREDENTIALS, or use an active gcloud ADC login for
 * doctorapp-7e8b3. The script reads no key file from this repo, and aborts
 * unless the resolved project id is exactly doctorapp-7e8b3.
 *
 * This is a one-time script. Delete or archive it once the reset is verified.
 */
