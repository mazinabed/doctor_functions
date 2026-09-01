/**
 * Offline safety check for scripts/cleanup_orphaned_storage.js.
 *
 * No credentials, no network, no Storage, no Firestore:
 *
 *     node scripts/test_cleanup_orphaned_storage.js
 *
 * Classification is a pure function over (path, ownerExists), so the whole
 * decision surface can be exercised here with a stub — including the cases
 * that must NEVER delete: the protected prefix, unknown prefixes, malformed
 * paths, and objects whose owner is alive.
 *
 * It also cross-checks the path templates against storage.rules, because
 * deleting by parsed path is only correct while those really are the paths the
 * apps write to.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cleanup = require("./cleanup_orphaned_storage");

let failures = 0;

function check(name, fn) {
  const done = (err) => {
    if (err) {
      failures += 1;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    } else {
      console.log(`  PASS  ${name}`);
    }
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(() => done(), done);
    done();
  } catch (err) {
    done(err);
  }
  return Promise.resolve();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Stub owner checker: exists() is true only for ids in the given set. */
function ownerStub(alive = []) {
  const set = new Set(alive);
  return async (collection, id) => set.has(`${collection}/${id}`);
}

const STORAGE_RULES = fs.readFileSync(
  path.join(__dirname, "..", "..", "storage.rules"),
  "utf8",
);

async function run() {
  console.log("\ncleanup_orphaned_storage.js — offline safety check\n");

  // ─── The protected prefix ────────────────────────────────────────────────

  await check("specialty_icons/ is hard-protected", () => {
    assert(cleanup.PROTECTED_PREFIXES.includes("specialty_icons/"), "specialty_icons/ is not protected");
    assert(cleanup.isProtected("specialty_icons/cardiology.png"), "isProtected missed a specialty icon");
    assert(cleanup.isProtected("specialty_icons/nested/deep/x.svg"), "isProtected missed a nested icon");
  });

  await check("a specialty icon can never be classified as orphaned", async () => {
    // Nothing alive anywhere — the most hostile possible input.
    const dead = ownerStub([]);
    for (const name of [
      "specialty_icons/cardiology.png",
      "specialty_icons/",
      "specialty_icons/a/b/c.png",
    ]) {
      const r = await cleanup.classify(name, dead);
      assert(r.klass === "protected", `${name} classified as ${r.klass}, expected protected`);
    }
  });

  await check("no protected prefix appears in the deletable path rules", () => {
    for (const p of cleanup.PROTECTED_PREFIXES) {
      assert(
        !cleanup.PREFIX_RULES.some((r) => r.prefix === p),
        `${p} has a deletion rule`,
      );
      assert(cleanup.ruleFor(`${p}x.png`) === null || cleanup.isProtected(`${p}x.png`), `${p} is reachable by a rule`);
    }
  });

  // ─── Ownership decides, in both directions ───────────────────────────────

  await check("an object whose owner EXISTS is preserved as active", async () => {
    const alive = ownerStub([
      "doctors/doc1",
      "users/pat1",
      "medical_centers/ctr1",
      "pharmacy_providers/ph1",
      "diagnostic_providers/lab1",
      "appointments/apt1",
      "clinical_requests/req1",
    ]);
    const cases = [
      "doctor_profiles/doc1.jpg",
      "doctor_docs/doc1/license.jpg",
      "profile_images/pat1.jpg",
      "centers/ctr1/logo.jpg",
      "pharmacy_providers/ph1/logo.jpg",
      "diagnostic_providers/lab1/logo.jpg",
      "visit_note_photos/ctr1/apt1/photo1",
      "clinical_attachments/ctr1/req1/att1",
    ];
    for (const name of cases) {
      const r = await cleanup.classify(name, alive);
      assert(r.klass === "active", `${name} classified as ${r.klass}, expected active`);
    }
  });

  await check("an object whose owner is GONE is classified orphaned", async () => {
    const dead = ownerStub([]);
    const cases = [
      "doctor_profiles/gone.jpg",
      "doctor_docs/gone/license.jpg",
      "profile_images/gone.jpg",
      "centers/gone/logo.jpg",
      "pharmacy_providers/gone/logo.jpg",
      "diagnostic_providers/gone/logo.jpg",
      "pharmacy_docs/gone/id.pdf",
      "visit_note_photos/gone/gone/photo1",
      "clinical_attachments/gone/gone/att1",
    ];
    for (const name of cases) {
      const r = await cleanup.classify(name, dead);
      assert(r.klass === "orphaned", `${name} classified as ${r.klass}, expected orphaned`);
    }
  });

  await check("doctor_docs/ is kept alive by ANY provider collection", async () => {
    // storage.rules:33-35 — the same prefix serves clinical doctors AND
    // diagnostic providers, so a uid alive in either must keep its documents.
    for (const collection of ["doctors", "diagnostic_providers", "pharmacy_providers", "users"]) {
      const alive = ownerStub([`${collection}/u1`]);
      const r = await cleanup.classify("doctor_docs/u1/license.jpg", alive);
      assert(r.klass === "active", `doctor_docs kept by ${collection} was classified ${r.klass}`);
    }
  });

  await check("a nested object is owned by its appointment/request, not just its center", async () => {
    // The center surviving must NOT keep a photo whose appointment is gone —
    // the file documents that specific visit.
    const centerOnly = ownerStub(["medical_centers/ctr1"]);
    const photo = await cleanup.classify("visit_note_photos/ctr1/goneApt/p1", centerOnly);
    assert(photo.klass === "orphaned", `visit note photo classified ${photo.klass}, expected orphaned`);
    const att = await cleanup.classify("clinical_attachments/ctr1/goneReq/a1", centerOnly);
    assert(att.klass === "orphaned", `clinical attachment classified ${att.klass}, expected orphaned`);

    // ...but a live appointment/request keeps it even if the center is gone.
    const aptOnly = ownerStub(["patient_visit_notes/apt1"]);
    const kept = await cleanup.classify("visit_note_photos/goneCtr/apt1/p1", aptOnly);
    assert(kept.klass === "active", `a live visit note did not preserve its photo (${kept.klass})`);
  });

  // ─── Ambiguity always preserves ──────────────────────────────────────────

  await check("an unknown prefix is ambiguous, never orphaned", async () => {
    const dead = ownerStub([]);
    for (const name of ["mystery/file.bin", "backups/2026/dump.sql", "toplevel.txt"]) {
      const r = await cleanup.classify(name, dead);
      assert(r.klass === "ambiguous", `${name} classified as ${r.klass}, expected ambiguous`);
    }
  });

  await check("a malformed path under a known prefix is ambiguous, never orphaned", async () => {
    const dead = ownerStub([]);
    const cases = [
      "doctor_profiles/notajpg.png", // wrong extension for the {uid}.jpg template
      "doctor_profiles/", // folder placeholder
      "doctor_docs/uid-only", // missing the file segment
      "profile_images/deep/nested.jpg", // too many segments
      "visit_note_photos/ctr1/apt1", // missing the photo segment
      "clinical_attachments/ctr1", // truncated
      "centers/", // no center id
    ];
    for (const name of cases) {
      const r = await cleanup.classify(name, dead);
      assert(r.klass === "ambiguous", `${name} classified as ${r.klass}, expected ambiguous`);
    }
  });

  await check("classification is exhaustive and only one class deletes", async () => {
    const dead = ownerStub([]);
    const seen = new Set();
    for (const name of [
      "specialty_icons/a.png",
      "doctor_profiles/x.jpg",
      "doctor_profiles/x.png",
      "unknown/x",
    ]) {
      const r = await cleanup.classify(name, dead);
      assert(
        ["protected", "active", "ambiguous", "orphaned"].includes(r.klass),
        `unknown class ${r.klass}`,
      );
      seen.add(r.klass);
    }
    assert(seen.has("protected") && seen.has("orphaned") && seen.has("ambiguous"), "classes not exercised");
  });

  // ─── Authorization ───────────────────────────────────────────────────────

  await check("dry run is the default and --execute alone cannot delete", () => {
    const none = cleanup.parseArgs([]);
    assert(none.execute === false, "no args should be a dry run");
    assert(none.confirm === null, "no args should carry no confirmation");
    const exec = cleanup.parseArgs(["--execute"]);
    assert(exec.execute === true && exec.confirm === null, "--execute alone must carry no token");
    const full = cleanup.parseArgs(["--execute", `--confirm=${cleanup.REQUIRED_CONFIRMATION}`]);
    assert(full.confirm === cleanup.REQUIRED_CONFIRMATION, "token not parsed");
  });

  await check("project, bucket and confirmation guards hold", () => {
    assert(cleanup.REQUIRED_PROJECT_ID === "doctorapp-7e8b3", `project is ${cleanup.REQUIRED_PROJECT_ID}`);
    assert(cleanup.BUCKET_NAME === "doctorapp-7e8b3.firebasestorage.app", `bucket is ${cleanup.BUCKET_NAME}`);
    assert(cleanup.REQUIRED_CONFIRMATION === "CLEANUP-ORPHANED-STORAGE", "confirmation changed");
  });

  await check("deletion ceilings exist and are enforced", () => {
    assert(cleanup.LIMITS.maxDeleteObjects > 0, "no object ceiling");
    assert(cleanup.LIMITS.maxDeleteBytes > 0, "no byte ceiling");
    const src = fs.readFileSync(path.join(__dirname, "cleanup_orphaned_storage.js"), "utf8");
    assert(
      /orphans\.length > LIMITS\.maxDeleteObjects[\s\S]{0,300}process\.exit\(1\)/.test(src),
      "the ceiling does not abort",
    );
  });

  // ─── Structural safety ───────────────────────────────────────────────────

  const src = fs
    .readFileSync(path.join(__dirname, "cleanup_orphaned_storage.js"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  await check("only orphaned objects are ever deleted", () => {
    // The single delete call must sit behind a re-classification that yields
    // "orphaned", so a preserved class can never reach it.
    assert(
      /again\.klass !== "orphaned"[\s\S]{0,200}continue;/.test(src),
      "the delete loop does not skip non-orphaned objects",
    );
    const deletes = src.match(/\.delete\(\)/g) ?? [];
    assert(deletes.length === 1, `expected exactly one delete call, found ${deletes.length}`);
  });

  await check("execute re-verifies ownership instead of trusting the plan", () => {
    assert(/const recheck = makeOwnerChecker\(db\)/.test(src), "no fresh owner checker in execute");
    assert(/await cleanup?\.?classify\(o\.name, recheck\)|await classify\(o\.name, recheck\)/.test(src), "execute does not re-classify");
  });

  await check("Firestore, Auth and Odoo are never mutated", () => {
    for (const forbidden of [".update(", ".add(", "FieldValue", "deleteUser", "createUser", "odoo", "callKw"]) {
      assert(!src.includes(forbidden), `script contains ${forbidden}`);
    }
    // A document write would be Ref.set(...) / doc(...).set(...). Map.set and
    // Set construction are fine, so match only reference-shaped receivers.
    const docWrite = /\b(\w*[Rr]ef|doc\([^)]*\))\.set\(/.exec(src);
    assert(docWrite === null, `script writes a Firestore document: ${docWrite?.[0]}`);
    // Firestore is read-only: only .get() on documents.
    const fsCalls = src.match(/\.collection\([^)]*\)\.doc\([^)]*\)\.\w+\(/g) ?? [];
    for (const c of fsCalls) assert(c.endsWith(".get("), `non-read Firestore call: ${c}`);
  });

  await check("no credential file from this repo is read", () => {
    for (const forbidden of ["serviceAccount", "credential.cert", "applicationDefault("]) {
      assert(!src.includes(forbidden), `script references ${forbidden}`);
    }
  });

  await check("protected objects are re-verified after execution", () => {
    assert(
      /for \(const prefix of PROTECTED_PREFIXES\)[\s\S]{0,600}unchanged/.test(src),
      "protected prefixes are not re-verified after deletion",
    );
  });

  // ─── Drift checks against storage.rules ──────────────────────────────────

  await check("every path template still matches storage.rules", () => {
    const documented = [
      "centers/{centerId}/",
      "doctor_docs/{uid}/{fileName}",
      "doctor_profiles/{fileName}",
      "diagnostic_providers/{uid}/{fileName}",
      "pharmacy_providers/{uid}/{fileName}",
      "pharmacy_docs/{uid}/{fileName}",
      "profile_images/{fileName}",
      "visit_note_photos/{centerId}/{appointmentId}/{photoId}",
      "clinical_attachments/{centerId}/{requestId}/{attachmentId}",
    ];
    for (const d of documented) {
      assert(
        STORAGE_RULES.includes(`match /${d}`) || STORAGE_RULES.includes(d),
        `storage.rules no longer documents ${d}`,
      );
    }
  });

  await check("every prefix in storage.rules has a rule or is protected", () => {
    const matched = [...STORAGE_RULES.matchAll(/match \/([a-z_]+)\//g)].map((m) => `${m[1]}/`);
    const known = new Set([...cleanup.PREFIX_RULES.map((r) => r.prefix), ...cleanup.PROTECTED_PREFIXES]);
    const unhandled = [...new Set(matched)].filter((p) => p !== "b/" && !known.has(p));
    assert(unhandled.length === 0, `prefix(es) in storage.rules with no rule: ${unhandled.join(", ")}`);
  });

  await check("specialty_icons/ has no client write rule — it is platform data", () => {
    assert(
      !/match \/specialty_icons\//.test(STORAGE_RULES),
      "specialty_icons/ now has a storage rule; re-check whether it is still Admin-managed platform data",
    );
  });

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) FAILED — do not run the cleanup until resolved.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

run();
