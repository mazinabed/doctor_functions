/**
 * ONE-TIME CLEANUP — Storage objects orphaned by the deleted Healthcare test data.
 * =============================================================================
 *
 * Removes Cloud Storage objects whose owning Firestore record no longer
 * exists. Ownership is derived from the object PATH, using the templates
 * documented in storage.rules, then checked against live Firestore.
 *
 * DRY RUN BY DEFAULT. Deletion requires BOTH --execute and the exact
 * confirmation string. See USAGE at the bottom.
 *
 * -----------------------------------------------------------------------------
 * WHY THESE OBJECTS ARE STRANDED
 * -----------------------------------------------------------------------------
 * The earlier clinical reset (scripts/reset_test_clinical_data.js) was
 * Firestore-only — verified by grep: it contains no Storage reference of any
 * kind. It deleted clinical_requests and their attachment METADATA documents,
 * but every corresponding Storage object is still there.
 *
 * That has a consequence worth stating plainly: for clinical_attachments and
 * visit_note_photos, the Firestore document that pointed at the object is
 * already gone, so the object can no longer be correlated forward from
 * Firestore. The only remaining link is the id embedded in the path, which is
 * why this script reasons from paths rather than from attachment records.
 *
 * -----------------------------------------------------------------------------
 * CLASSIFICATION — FOUR OUTCOMES, ONLY ONE OF WHICH DELETES
 * -----------------------------------------------------------------------------
 *   PROTECTED  a hard-protected prefix. Never read for deletion, never counted
 *              as a candidate, re-verified untouched after execution.
 *   ACTIVE     the owning record exists in Firestore right now. Preserved.
 *   AMBIGUOUS  the prefix is unknown, or the path does not match its documented
 *              template, so no owner can be established. Preserved and reported.
 *   ORPHANED   the path parses cleanly AND the owning record is absent. The
 *              only class that is ever deleted.
 *
 * Ambiguity always resolves toward keeping the file. An object is deleted only
 * when its owner can be positively identified AND positively shown to be gone.
 *
 * -----------------------------------------------------------------------------
 * FRESH ACCOUNTS
 * -----------------------------------------------------------------------------
 * New Healthcare test accounts are being created right now, so the answer to
 * "does this owner exist" changes over time. Execute mode therefore RE-CHECKS
 * each object's owner immediately before deleting it, rather than trusting the
 * plan built moments earlier. An account created between the dry run and the
 * execution keeps its files.
 */

const admin = require("firebase-admin");

// ── Guards ──────────────────────────────────────────────────────────────────
const REQUIRED_PROJECT_ID = "doctorapp-7e8b3";
const REQUIRED_CONFIRMATION = "CLEANUP-ORPHANED-STORAGE";

/**
 * The live bucket. doctorapp-7e8b3.appspot.com does not exist on this project
 * (probed directly); .firebasestorage.app is the real one.
 */
const BUCKET_NAME = "doctorapp-7e8b3.firebasestorage.app";

/**
 * Never enumerated for deletion, never a candidate, re-verified after any run.
 *
 * specialty_icons/ holds the shared specialty artwork used across TrustyDr. It
 * is referenced by the `specialties` collection, is not owned by any doctor or
 * provider, and has no match block in storage.rules at all (so clients cannot
 * write it — it is Admin-SDK/console managed platform data).
 */
const PROTECTED_PREFIXES = ["specialty_icons/"];

/**
 * EXPLICIT ONE-TIME EXCEPTION (2026-09-01).
 *
 * Objects owned by these uids are treated as deletable even though the uid
 * still exists in Firestore. This exists for exactly one reason: the operator
 * wants a clean Storage baseline and intends to recreate this test doctor from
 * scratch, so their uploaded files must go with them.
 *
 * This deliberately inverts the script's normal safety direction, so it is
 * narrow on purpose: an explicit uid list, not a pattern, not a role, not a
 * date cutoff. Nothing is inferred. Empty this set once the baseline is taken.
 *
 * Firestore is NOT touched — only the uid's Storage objects.
 */
const DELETABLE_UID_EXCEPTIONS = new Set([
  "SqQGcXuDkaOFaI0NlLwTeqr67fv1", // fresh test doctor, to be recreated from scratch
]);

/** Refuse to run against anything that does not look like a test-sized cleanup. */
const LIMITS = {
  maxDeleteObjects: 5000,
  maxDeleteBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
};

/**
 * Path templates, taken verbatim from storage.rules' own documentation.
 *
 * mode "any"     — the object belongs to one entity whose record may live in
 *                  any of the listed collections. If ANY exists, it is active.
 *                  (doctor_docs/ is genuinely shared between clinical doctors
 *                  and diagnostic providers — storage.rules:33-35 says so.)
 * mode "primary" — a nested path. The FIRST owner listed is the one that
 *                  decides: a visit-note photo belongs to its appointment, and
 *                  a clinical attachment to its request. The center is recorded
 *                  for reporting but does not keep the object alive on its own,
 *                  because the specific appointment/request is what the file
 *                  actually documents.
 */
const PREFIX_RULES = [
  {
    prefix: "centers/",
    template: "centers/{centerId}/**",
    mode: "any",
    parse: (parts) => (parts.length >= 3 && parts[1] ? { centerId: parts[1] } : null),
    owners: [{ collection: "medical_centers", key: "centerId" }],
  },
  {
    prefix: "doctor_docs/",
    template: "doctor_docs/{uid}/{fileName}",
    mode: "any",
    parse: (parts) => (parts.length === 3 && parts[1] ? { uid: parts[1] } : null),
    /**
     * A superseded upload convention: doctor_docs/{millis}_{slot}_{name}.{ext}
     * with NO uid segment, so ownership cannot be derived from the path.
     *
     * These are AMBIGUOUS by default and preserved. They only become deletable
     * with --include-legacy-doctor-docs, which is opt-in precisely because the
     * "prove the owner is gone" rule cannot be applied to them — the argument
     * for deleting them is contextual (no live record references any of them,
     * and no current code path reads this shape) rather than provable per file.
     */
    legacyFlat: (parts) => parts.length === 2 && parts[1].length > 0,
    // storage.rules:33-35 — used by ALL onboarding flows, clinical doctors AND
    // diagnostic providers, so a uid alive in either keeps the document.
    owners: [
      { collection: "doctors", key: "uid" },
      { collection: "diagnostic_providers", key: "uid" },
      { collection: "pharmacy_providers", key: "uid" },
      { collection: "users", key: "uid" },
    ],
  },
  {
    prefix: "doctor_profiles/",
    template: "doctor_profiles/{uid}.jpg",
    mode: "any",
    parse: (parts) =>
      parts.length === 2 && parts[1].endsWith(".jpg")
        ? { uid: parts[1].slice(0, -".jpg".length) }
        : null,
    owners: [
      { collection: "doctors", key: "uid" },
      { collection: "users", key: "uid" },
    ],
  },
  {
    prefix: "diagnostic_providers/",
    template: "diagnostic_providers/{uid}/{fileName}",
    mode: "any",
    parse: (parts) => (parts.length === 3 && parts[1] ? { uid: parts[1] } : null),
    owners: [
      { collection: "diagnostic_providers", key: "uid" },
      { collection: "users", key: "uid" },
    ],
  },
  {
    prefix: "pharmacy_providers/",
    template: "pharmacy_providers/{uid}/{fileName}",
    mode: "any",
    parse: (parts) => (parts.length === 3 && parts[1] ? { uid: parts[1] } : null),
    owners: [
      { collection: "pharmacy_providers", key: "uid" },
      { collection: "users", key: "uid" },
    ],
  },
  {
    prefix: "pharmacy_docs/",
    template: "pharmacy_docs/{uid}/{fileName}",
    mode: "any",
    parse: (parts) => (parts.length === 3 && parts[1] ? { uid: parts[1] } : null),
    owners: [
      { collection: "pharmacy_providers", key: "uid" },
      { collection: "users", key: "uid" },
    ],
  },
  {
    prefix: "profile_images/",
    template: "profile_images/{uid}.jpg",
    mode: "any",
    parse: (parts) =>
      parts.length === 2 && parts[1].endsWith(".jpg")
        ? { uid: parts[1].slice(0, -".jpg".length) }
        : null,
    owners: [{ collection: "users", key: "uid" }],
  },
  {
    prefix: "visit_note_photos/",
    template: "visit_note_photos/{centerId}/{appointmentId}/{photoId}",
    // The photo's metadata document lives at
    // patient_visit_notes/{appointmentId}/photos/{photoId}
    // (visit_note_photo_repo.dart:63-64), NOT under appointments. Both are
    // checked: the visit note is the record that actually points at the file,
    // and the appointment is what the note documents. Either one alive keeps
    // the photo.
    //
    // The centerId is parsed for reporting but is deliberately NOT an owner. A
    // surviving center must not keep a photo of a visit that no longer exists —
    // the file documents that specific appointment, not the building.
    mode: "any",
    parse: (parts) =>
      parts.length === 4 && parts[1] && parts[2]
        ? { centerId: parts[1], appointmentId: parts[2] }
        : null,
    owners: [
      { collection: "patient_visit_notes", key: "appointmentId" },
      { collection: "appointments", key: "appointmentId" },
    ],
  },
  {
    prefix: "clinical_attachments/",
    template: "clinical_attachments/{centerId}/{requestId}/{attachmentId}",
    // Metadata lives at clinical_requests/{requestId}/attachments/{attachmentId}
    // (clinical_request_repo.dart:654). The parent request is the owner; as
    // above, the center alone does not keep a request-specific file alive.
    mode: "any",
    parse: (parts) =>
      parts.length === 4 && parts[1] && parts[2]
        ? { centerId: parts[1], requestId: parts[2] }
        : null,
    owners: [{ collection: "clinical_requests", key: "requestId" }],
  },
];

// ── Pure helpers ────────────────────────────────────────────────────────────

function isProtected(objectName) {
  return PROTECTED_PREFIXES.some((p) => objectName.startsWith(p));
}

function ruleFor(objectName) {
  return PREFIX_RULES.find((r) => objectName.startsWith(r.prefix)) ?? null;
}

/**
 * Splits an object name into path segments. A trailing "/" (folder placeholder
 * objects that the console creates) yields an empty final segment, which will
 * fail every template and so lands in AMBIGUOUS rather than being deleted.
 */
function segments(objectName) {
  return objectName.split("/");
}

function parseArgs(argv) {
  const confirmArg = argv.find((a) => a.startsWith("--confirm="));
  return {
    execute: argv.includes("--execute"),
    confirm: confirmArg ? confirmArg.slice("--confirm=".length) : null,
    includeLegacyDoctorDocs: argv.includes("--include-legacy-doctor-docs"),
  };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ── Firestore ownership ─────────────────────────────────────────────────────

/** Caches existence lookups — many objects share one owner. */
function makeOwnerChecker(db) {
  const cache = new Map();
  return async function exists(collection, id) {
    if (!id) return false;
    const key = `${collection}/${id}`;
    if (cache.has(key)) return cache.get(key);
    const snap = await db.collection(collection).doc(id).get();
    cache.set(key, snap.exists);
    return snap.exists;
  };
}

/**
 * Classifies one object. Returns { klass, rule, ids, aliveVia, reason }.
 * klass is one of: protected | active | ambiguous | orphaned.
 */
async function classify(objectName, exists, options = {}) {
  // The protected check runs first and unconditionally — before rules, before
  // exceptions, before any option can influence the outcome.
  if (isProtected(objectName)) {
    return { klass: "protected", reason: "hard-protected shared platform prefix" };
  }
  const rule = ruleFor(objectName);
  if (!rule) {
    return { klass: "ambiguous", reason: "no known path template for this prefix" };
  }
  const parts = segments(objectName);
  const ids = rule.parse(parts);
  if (!ids) {
    if (options.includeLegacyDoctorDocs && rule.legacyFlat?.(parts)) {
      return {
        klass: "orphaned",
        rule,
        ids: {},
        reason: "legacy flat path with no uid segment — opted in via --include-legacy-doctor-docs",
      };
    }
    return {
      klass: "ambiguous",
      rule,
      reason: `path does not match the documented template ${rule.template}`,
    };
  }

  // Explicit one-time exception: this owner's files go even though the owner
  // still exists. Never applies to a protected prefix — that returned above.
  const excepted = Object.values(ids).find((v) => DELETABLE_UID_EXCEPTIONS.has(v));
  if (excepted) {
    return {
      klass: "orphaned",
      rule,
      ids,
      reason: `explicit one-time deletion exception for ${excepted} (owner still exists in Firestore)`,
    };
  }

  if (rule.mode === "any") {
    for (const owner of rule.owners) {
      // eslint-disable-next-line no-await-in-loop
      if (await exists(owner.collection, ids[owner.key])) {
        return {
          klass: "active",
          rule,
          ids,
          aliveVia: `${owner.collection}/${ids[owner.key]}`,
          reason: "owning record exists",
        };
      }
    }
    return {
      klass: "orphaned",
      rule,
      ids,
      reason: `no owning record in ${rule.owners.map((o) => o.collection).join(", ")}`,
    };
  }

  // primary: the first owner decides.
  const primary = rule.owners[0];
  if (await exists(primary.collection, ids[primary.key])) {
    return {
      klass: "active",
      rule,
      ids,
      aliveVia: `${primary.collection}/${ids[primary.key]}`,
      reason: "owning record exists",
    };
  }
  return {
    klass: "orphaned",
    rule,
    ids,
    reason: `${primary.collection}/${ids[primary.key]} does not exist`,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function blankBucket() {
  return { protected: mk(), active: mk(), ambiguous: mk(), orphaned: mk() };
  function mk() {
    return { count: 0, bytes: 0, samples: [] };
  }
}

function add(acc, klass, name, size) {
  const b = acc[klass];
  b.count += 1;
  b.bytes += size;
  if (b.samples.length < 8) b.samples.push(name);
}

function printTable(title, byPrefix) {
  console.log(`\n${title}`);
  console.log(
    `  ${"prefix".padEnd(24)} ${"objects".padStart(8)} ${"size".padStart(11)}   ` +
      `${"orphaned".padStart(9)} ${"active".padStart(8)} ${"ambiguous".padStart(10)} ${"protected".padStart(10)}`,
  );
  for (const [prefix, acc] of byPrefix) {
    const total = acc.protected.count + acc.active.count + acc.ambiguous.count + acc.orphaned.count;
    const bytes = acc.protected.bytes + acc.active.bytes + acc.ambiguous.bytes + acc.orphaned.bytes;
    console.log(
      `  ${prefix.padEnd(24)} ${String(total).padStart(8)} ${formatBytes(bytes).padStart(11)}   ` +
        `${String(acc.orphaned.count).padStart(9)} ${String(acc.active.count).padStart(8)} ` +
        `${String(acc.ambiguous.count).padStart(10)} ${String(acc.protected.count).padStart(10)}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { execute, confirm, includeLegacyDoctorDocs } = parseArgs(process.argv.slice(2));
  const options = { includeLegacyDoctorDocs };

  admin.initializeApp({ projectId: REQUIRED_PROJECT_ID, storageBucket: BUCKET_NAME });
  const resolved = admin.app().options.projectId;
  if (resolved !== REQUIRED_PROJECT_ID) {
    console.error(
      `\nABORTING — wrong project.\n  expected: ${REQUIRED_PROJECT_ID}\n  resolved: ${resolved || "(none)"}\n`,
    );
    process.exit(1);
  }

  const db = admin.firestore();
  const bucket = admin.storage().bucket(BUCKET_NAME);
  const [bucketExists] = await bucket.exists();
  if (!bucketExists) {
    console.error(`\nABORTING — bucket ${BUCKET_NAME} does not exist.\n`);
    process.exit(1);
  }

  console.log("=".repeat(100));
  console.log(`  ORPHANED STORAGE CLEANUP — ${execute ? "EXECUTE" : "DRY RUN"}`);
  console.log(`  project: ${REQUIRED_PROJECT_ID}   bucket: ${BUCKET_NAME}`);
  console.log(`  PROTECTED (never touched): ${PROTECTED_PREFIXES.join(", ")}`);
  if (DELETABLE_UID_EXCEPTIONS.size > 0) {
    console.log(`  ONE-TIME DELETE EXCEPTIONS (owner exists, files still go): ${[...DELETABLE_UID_EXCEPTIONS].join(", ")}`);
  }
  console.log(`  legacy flat doctor_docs/: ${includeLegacyDoctorDocs ? "INCLUDED (--include-legacy-doctor-docs)" : "excluded (ambiguous, preserved)"}`);
  console.log("=".repeat(100));

  const exists = makeOwnerChecker(db);
  const [files] = await bucket.getFiles();
  console.log(`\n${files.length} object(s) in the bucket.`);

  const byPrefix = new Map();
  const orphans = [];
  const ambiguous = [];

  for (const file of files) {
    const name = file.name;
    const size = Number(file.metadata?.size ?? 0);
    const top = `${name.split("/")[0]}/`;
    if (!byPrefix.has(top)) byPrefix.set(top, blankBucket());

    // eslint-disable-next-line no-await-in-loop
    const result = await classify(name, exists, options);
    add(byPrefix.get(top), result.klass, name, size);

    if (result.klass === "orphaned") orphans.push({ file, name, size, result });
    if (result.klass === "ambiguous") ambiguous.push({ name, size, result });
  }

  printTable("── OBJECTS BY PREFIX ────────────────────────────────────────────", [...byPrefix].sort());

  const totalOrphanBytes = orphans.reduce((n, o) => n + o.size, 0);
  const totalAmbiguousBytes = ambiguous.reduce((n, o) => n + o.size, 0);

  console.log("\n── ORPHANED — the only class that would be deleted ───────────────");
  console.log(`  ${orphans.length} object(s), ${formatBytes(totalOrphanBytes)}`);
  const orphanByReason = new Map();
  for (const o of orphans) {
    const k = `${o.result.rule.prefix} — ${o.result.reason.replace(/\/[^ ,]+/g, "/<id>")}`;
    orphanByReason.set(k, (orphanByReason.get(k) ?? 0) + 1);
  }
  for (const [reason, count] of [...orphanByReason].sort()) {
    console.log(`      ${String(count).padStart(5)}  ${reason}`);
  }

  console.log("\n── AMBIGUOUS — preserved, never deleted ─────────────────────────");
  console.log(`  ${ambiguous.length} object(s), ${formatBytes(totalAmbiguousBytes)}`);
  for (const a of ambiguous.slice(0, 25)) console.log(`      ${a.name}\n          ${a.result.reason}`);
  if (ambiguous.length > 25) console.log(`      ... and ${ambiguous.length - 25} more`);

  const protectedBefore = [...byPrefix].reduce(
    (acc, [, v]) => ({ count: acc.count + v.protected.count, bytes: acc.bytes + v.protected.bytes }),
    { count: 0, bytes: 0 },
  );
  console.log(
    `\n── PROTECTED ────────────────────────────────────────────────────\n` +
      `  ${protectedBefore.count} object(s), ${formatBytes(protectedBefore.bytes)} under ${PROTECTED_PREFIXES.join(", ")}`,
  );

  if (orphans.length > LIMITS.maxDeleteObjects || totalOrphanBytes > LIMITS.maxDeleteBytes) {
    console.error(
      `\nABORTING — orphan set exceeds the ceiling ` +
        `(${orphans.length}/${LIMITS.maxDeleteObjects} objects, ${formatBytes(totalOrphanBytes)}/${formatBytes(LIMITS.maxDeleteBytes)}).`,
    );
    process.exit(1);
  }

  if (!execute) {
    console.log("\n── EVERY ORPHANED OBJECT ────────────────────────────────────────");
    for (const o of orphans) console.log(`  ${o.name}  (${formatBytes(o.size)})  ${o.result.reason}`);
    console.log("\nDRY RUN — nothing was deleted.");
    console.log(`To delete, re-run with:\n  --execute --confirm=${REQUIRED_CONFIRMATION}\n`);
    return;
  }

  if (confirm !== REQUIRED_CONFIRMATION) {
    console.error(
      `\nABORTING — --execute requires --confirm=${REQUIRED_CONFIRMATION}\n  got: ${confirm ?? "(missing)"}\n`,
    );
    process.exit(1);
  }

  console.log("\n── DELETING ─────────────────────────────────────────────────────");
  let deleted = 0;
  const skipped = [];
  const failed = [];
  // A fresh checker: ownership is re-verified against Firestore NOW, not against
  // the plan built above. An account created since then keeps its files.
  const recheck = makeOwnerChecker(db);
  for (const o of orphans) {
    const again = await classify(o.name, recheck, options);
    if (again.klass !== "orphaned") {
      skipped.push({ name: o.name, klass: again.klass, reason: again.reason });
      continue;
    }
    try {
      await o.file.delete();
      deleted += 1;
    } catch (err) {
      failed.push({ name: o.name, reason: (err.message ?? String(err)).split("\n")[0].slice(0, 140) });
    }
  }
  console.log(`  deleted ${deleted}/${orphans.length}`);
  if (skipped.length > 0) {
    console.log(`  skipped ${skipped.length} — owner reappeared since the plan was built:`);
    for (const s of skipped) console.log(`      ${s.name}  (${s.klass}: ${s.reason})`);
  }
  for (const f of failed) console.log(`  FAILED ${f.name} — ${f.reason}`);

  console.log("\n── VERIFICATION ─────────────────────────────────────────────────");
  let ok = true;
  let stillPresent = 0;
  for (const o of orphans) {
    if (skipped.some((s) => s.name === o.name)) continue;
    const [ex] = await bucket.file(o.name).exists();
    if (ex) {
      stillPresent += 1;
      console.log(`  STILL PRESENT: ${o.name}`);
    }
  }
  console.log(`  targeted objects remaining: ${stillPresent === 0 ? "none  OK" : stillPresent}`);
  if (stillPresent > 0) ok = false;

  for (const prefix of PROTECTED_PREFIXES) {
    const [after] = await bucket.getFiles({ prefix });
    const bytes = after.reduce((n, f) => n + Number(f.metadata?.size ?? 0), 0);
    const same = after.length === protectedBefore.count && bytes === protectedBefore.bytes;
    console.log(
      `  ${prefix} ${after.length} object(s), ${formatBytes(bytes)}  ` +
        `${same ? "unchanged  OK" : "!!! CHANGED — expected " + protectedBefore.count + " / " + formatBytes(protectedBefore.bytes)}`,
    );
    if (!same) ok = false;
  }

  console.log(
    ok
      ? "\nDONE — orphaned objects removed; protected and ambiguous objects untouched."
      : "\nCOMPLETED WITH WARNINGS — see above.",
  );
  if (!ok) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nFAILED:", err?.message ?? err);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_PROJECT_ID,
  REQUIRED_CONFIRMATION,
  BUCKET_NAME,
  PROTECTED_PREFIXES,
  DELETABLE_UID_EXCEPTIONS,
  PREFIX_RULES,
  LIMITS,
  isProtected,
  ruleFor,
  segments,
  parseArgs,
  classify,
  formatBytes,
};

/*
 * USAGE
 * -----
 * From doctor_functions/functions:
 *
 *   node scripts/cleanup_orphaned_storage.js
 *   node scripts/cleanup_orphaned_storage.js --execute --confirm=CLEANUP-ORPHANED-STORAGE
 *
 * Offline safety check (no credentials, no network):
 *   node scripts/test_cleanup_orphaned_storage.js
 *
 * Credentials come from Application Default Credentials. No key file in this
 * repo is read. Aborts unless the project resolves to doctorapp-7e8b3.
 *
 * One-time script — delete or archive it once the cleanup is verified.
 */
