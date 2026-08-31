/**
 * ONE-TIME TEST DATA RESET — clinical/scheduling collections only.
 * =============================================================================
 *
 * Clears DOCUMENTS from exactly four top-level collections:
 *
 *     appointments · clinical_requests · schedules · slot_locks
 *
 * plus, for each deleted clinical_request, the derived records that would
 * otherwise be stranded (see "WHY THE EXTRAS" below). Collections themselves are
 * never deleted — Firestore has no such concept for a collection with no
 * documents, and nothing here issues a collection-group or database-wide delete.
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
 * For clinical_requests specifically, these are written on create/update and
 * are keyed off the SAME requestId:
 *
 *   patient_referral_requests/{requestId}
 *       1:1 mirror. onClinicalReferralCreated.js:175 (create),
 *       onClinicalReferralStatusUpdated.js:76 (update).
 *
 *   clinical_requests/{requestId}/attachments/*
 *       Real subcollection (firestore.rules:2293). Deleting a parent document
 *       does NOT delete its subcollections, so these need explicit recursion.
 *
 *   users/{recipientUid}/notifications/{notifId}
 *       Eight deterministic id patterns, all derived from requestId:
 *         referral_{id}                 onClinicalReferralCreated.js:397
 *         rx_created_{id}               onClinicalReferralCreated.js:450
 *         lab_appt_created_{id}         onLabAppointmentCreated.js:125
 *         reminder_{id}_2_day           sendDailyReminders.js:339
 *         reminder_{id}_1_day           sendDailyReminders.js:339
 *         reminder_{id}_same_day        sendSameDayReminders.js:250
 *         wf_lab_order_{id}             notificationEngine.js:45 + labOrderWorkflow.js:43
 *         wf_prescription_{id}          notificationEngine.js:45 + prescriptionWorkflow.js:42
 *       Every one also carries a clinicalRequestId field, used below purely as
 *       a post-delete VERIFICATION read — never as a deletion selector.
 *
 * -----------------------------------------------------------------------------
 * NOT IN SCOPE — deliberately
 * -----------------------------------------------------------------------------
 * Deleting `appointments` strands its own notifications by exactly the same
 * mechanism: reminder_{appointmentId}_2_day / _1_day / _same_day and
 * wf_appointment_{appointmentId}. Cleaning those was NOT authorised for this
 * run, so this script does not touch them — it REPORTS the count instead
 * (see reportAppointmentNotificationExposure). Re-run with a widened scope
 * only after an explicit decision.
 *
 * Never touched: patient_prescriptions, users (the documents themselves),
 * doctors, medical_centers, pharmacy_providers, diagnostic_providers, patients,
 * medication/catalog, taxonomy, config, subscription plans, Commerce/Odoo,
 * rules, indexes.
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

/** Notification ids derived from a clinical_request id. */
function notificationIdsFor(requestId) {
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

/**
 * Users who could hold a notification for this request. Read from the request
 * document itself rather than discovered by a collection-group scan, so the
 * blast radius stays bounded to uids this request actually names.
 */
function recipientCandidates(data) {
  return [...new Set([data.patientId, data.partnerProviderId, data.doctorId, data.centerId].filter(
    (v) => typeof v === "string" && v.length > 0,
  ))];
}

function parseArgs(argv) {
  const execute = argv.includes("--execute");
  const confirmArg = argv.find((a) => a.startsWith("--confirm="));
  const confirm = confirmArg ? confirmArg.slice("--confirm=".length) : null;
  const verifyOrphans = argv.includes("--verify-orphans");
  return { execute, confirm, verifyOrphans };
}

function banner(mode) {
  console.log("=".repeat(78));
  console.log(`  TEST CLINICAL DATA RESET — ${mode}`);
  console.log(`  project: ${REQUIRED_PROJECT_ID}`);
  console.log("=".repeat(78));
}

async function resolveProjectId() {
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
    const batch = db.batch();
    for (const ref of refs.slice(i, i + CHUNK)) batch.delete(ref);
    await batch.commit();
    deleted += Math.min(CHUNK, refs.length - i);
  }
  return deleted;
}

/** Collects every document ref in a collection (ids only — no field data read). */
async function listRefs(collectionRef) {
  const snap = await collectionRef.select().get();
  return snap.docs.map((d) => d.ref);
}

async function buildPlan(db) {
  const plan = {
    counts: {},
    clinicalRequests: [],
    simple: {},
    totals: { attachments: 0, referralMirrors: 0, notifications: 0 },
  };

  for (const name of TARGET_COLLECTIONS) {
    const refs = await listRefs(db.collection(name));
    plan.counts[name] = refs.length;
    if (name !== "clinical_requests") plan.simple[name] = refs;
  }

  const crSnap = await db.collection("clinical_requests").get();
  for (const doc of crSnap.docs) {
    const requestId = doc.id;
    const data = doc.data() || {};

    const attachments = await listRefs(doc.ref.collection("attachments"));

    const mirrorRef = db.collection("patient_referral_requests").doc(requestId);
    const mirrorSnap = await mirrorRef.get();

    const recipients = recipientCandidates(data);
    const notifIds = notificationIdsFor(requestId);
    const notifRefs = [];
    for (const uid of recipients) {
      for (const notifId of notifIds) {
        const ref = db.collection("users").doc(uid).collection("notifications").doc(notifId);
        // eslint-disable-next-line no-await-in-loop
        const snap = await ref.get();
        if (snap.exists) notifRefs.push(ref);
      }
    }

    plan.clinicalRequests.push({
      requestId,
      docRef: doc.ref,
      attachments,
      mirrorRef: mirrorSnap.exists ? mirrorRef : null,
      notifRefs,
      recipients,
    });

    plan.totals.attachments += attachments.length;
    plan.totals.referralMirrors += mirrorSnap.exists ? 1 : 0;
    plan.totals.notifications += notifRefs.length;
  }

  return plan;
}

function printPlan(plan) {
  console.log("\n── COUNTS BEFORE ────────────────────────────────────────────────");
  for (const name of TARGET_COLLECTIONS) {
    console.log(`  ${name.padEnd(20)} ${plan.counts[name]}`);
  }
  console.log("\n── DERIVED RECORDS (clinical_requests only) ─────────────────────");
  console.log(`  attachments (subcollection)      ${plan.totals.attachments}`);
  console.log(`  patient_referral_requests mirrors ${plan.totals.referralMirrors}`);
  console.log(`  notifications                     ${plan.totals.notifications}`);

  console.log("\n── EXACT DOCUMENTS TO DELETE ────────────────────────────────────");
  for (const name of TARGET_COLLECTIONS) {
    if (name === "clinical_requests") continue;
    for (const ref of plan.simple[name]) console.log(`  ${ref.path}`);
  }
  for (const item of plan.clinicalRequests) {
    console.log(`  clinical_requests/${item.requestId}`);
    for (const ref of item.attachments) console.log(`      ${ref.path}`);
    if (item.mirrorRef) console.log(`      ${item.mirrorRef.path}`);
    for (const ref of item.notifRefs) console.log(`      ${ref.path}`);
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

/**
 * Read-only. Reports how many appointment-derived notifications WOULD be
 * stranded by clearing `appointments`, without touching them — cleaning those
 * was not authorised for this run.
 */
async function reportAppointmentNotificationExposure(db, plan) {
  const apptIds = (plan.simple.appointments || []).map((r) => r.id);
  if (apptIds.length === 0) return;
  console.log("\n── NOT DELETED: appointment-derived notifications ───────────────");
  console.log(
    `  ${apptIds.length} appointment(s) will be deleted. Their notifications\n` +
      "  (reminder_{id}_2_day / _1_day / _same_day, wf_appointment_{id}) are NOT in\n" +
      "  scope for this run and will remain, referencing deleted appointments.\n" +
      "  Decide separately whether to clean them.",
  );
}

async function verifyAfter(db, plan) {
  console.log("\n── VERIFICATION ─────────────────────────────────────────────────");
  let ok = true;

  for (const name of TARGET_COLLECTIONS) {
    // eslint-disable-next-line no-await-in-loop
    const remaining = (await db.collection(name).select().limit(1).get()).size;
    const label = remaining === 0 ? "0 remaining  OK" : `${remaining}+ REMAINING`;
    console.log(`  ${name.padEnd(20)} ${label}`);
    if (remaining !== 0) ok = false;
  }

  const staleMirrors = [];
  for (const item of plan.clinicalRequests) {
    const ref = db.collection("patient_referral_requests").doc(item.requestId);
    // eslint-disable-next-line no-await-in-loop
    const snap = await ref.get();
    if (snap.exists) staleMirrors.push(item.requestId);
  }
  console.log(
    `  orphaned patient_referral_requests  ${
      staleMirrors.length === 0 ? "none  OK" : `${staleMirrors.length} REMAINING`
    }`,
  );
  if (staleMirrors.length > 0) {
    ok = false;
    for (const id of staleMirrors) console.log(`      patient_referral_requests/${id}`);
  }

  return ok;
}

async function main() {
  const { execute, confirm, verifyOrphans } = parseArgs(process.argv.slice(2));

  admin.initializeApp();
  const projectId = await resolveProjectId();

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
  await reportAppointmentNotificationExposure(db, plan);

  if (!execute) {
    console.log("\nDRY RUN — nothing was deleted.");
    console.log(
      `To delete, re-run with:\n  --execute --confirm=${REQUIRED_CONFIRMATION}\n`,
    );
    if (verifyOrphans) {
      console.log("(--verify-orphans only has an effect after --execute.)");
    }
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

  // Dependents first, source last — nothing here fires a trigger (there are no
  // delete triggers), but this ordering means an interrupted run never leaves a
  // mirror whose source is already gone.
  let notifDeleted = 0;
  let attachmentsDeleted = 0;
  let mirrorsDeleted = 0;

  for (const item of plan.clinicalRequests) {
    notifDeleted += await deleteRefs(db, item.notifRefs);
    attachmentsDeleted += await deleteRefs(db, item.attachments);
    if (item.mirrorRef) mirrorsDeleted += await deleteRefs(db, [item.mirrorRef]);
    await deleteRefs(db, [item.docRef]);
  }
  console.log(`  notifications              ${notifDeleted}`);
  console.log(`  attachments                ${attachmentsDeleted}`);
  console.log(`  patient_referral_requests  ${mirrorsDeleted}`);
  console.log(`  clinical_requests          ${plan.clinicalRequests.length}`);

  for (const name of TARGET_COLLECTIONS) {
    if (name === "clinical_requests") continue;
    const n = await deleteRefs(db, plan.simple[name]);
    console.log(`  ${name.padEnd(26)} ${n}`);
  }

  const ok = await verifyAfter(db, plan);
  console.log(
    ok
      ? "\nDONE — all four collections are empty and no referral mirrors were orphaned."
      : "\nCOMPLETED WITH WARNINGS — see REMAINING entries above.",
  );
  if (!ok) process.exit(2);
}

main().catch((err) => {
  console.error("\nFAILED:", err && err.message ? err.message : err);
  process.exit(1);
});

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
 * Credentials come from Application Default Credentials — set
 * GOOGLE_APPLICATION_CREDENTIALS, or use an active gcloud ADC login for
 * doctorapp-7e8b3. The script reads no key file from this repo, and aborts
 * unless the resolved project id is exactly doctorapp-7e8b3.
 *
 * This is a one-time script. Delete or archive it once the reset is verified.
 */
