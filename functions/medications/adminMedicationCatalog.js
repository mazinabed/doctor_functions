'use strict';

/**
 * Global medication catalog moderation — Prescription Platform Phase 6
 * (ADR-014 §5).
 *
 * The admin half of the contributed-catalog model. A clinician who cannot find
 * a medication creates it in their centre library instantly (Phase 1) and a
 * `medication_submissions` candidate is queued by `onCenterMedicationWritten`.
 * Nothing is trusted vocabulary until an admin says so here.
 *
 * ── NO AUTOMATIC PROMOTION ──────────────────────────────────────────────────
 *
 * ADR-014 §5 is explicit: launch with admin review only. `distinctCenterCount`
 * — how many unrelated centres independently produced the same normalizedKey —
 * is surfaced as REVIEW EVIDENCE and drives nothing. There is no threshold, no
 * scheduled job, and no code path anywhere that writes to `medication_catalog`
 * without an admin acting.
 *
 * ── Why callables rather than direct Firestore ──────────────────────────────
 *
 * `medication_catalog` is `write: if false` for every client — that single rule
 * is what stops a free-text typo becoming trusted global data. Promotion
 * therefore has to run server-side. Admin identity is verified against
 * `users/{uid}.role == 'admin'`, the same gate every other admin relay in this
 * project uses.
 *
 * Unlike `adminCanonicalProducts.js`, there is no Commerce relay here: the
 * clinical medication catalog lives in THIS project (ADR-014 §9 keeps it
 * separate from Commerce's canonical products), so these functions talk to
 * Firestore directly.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const {
  buildNormalizedKey,
  buildSearchTokens,
  normalizeText,
} = require('./normalizeMedication');

const SUBMISSIONS = 'medication_submissions';
const CATALOG = 'medication_catalog';

const MAX_SUBMISSIONS = 100;
const MAX_MATCHES_PER_SUBMISSION = 5;

async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in.');
  }
  const snap = await getFirestore()
    .collection('users').doc(request.auth.uid).get();
  if (snap.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return request.auth.uid;
}

/** Shapes a catalog document for the admin UI. */
function catalogRow(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    displayName: d.displayName || '',
    genericName: d.genericName || null,
    brandName: d.brandName || null,
    strength: d.strength || null,
    strengthUnit: d.strengthUnit || null,
    dosageForm: d.dosageForm || null,
    manufacturer: d.manufacturer || null,
    source: d.source || 'admin',
    rxcui: d.rxcui || null,
    normalizedKey: d.normalizedKey || null,
    status: d.status || 'active',
    usageCount: Number(d.usageCount) || 0,
  };
}

/**
 * Token overlap as a rough similarity, used only to ORDER candidate matches for
 * a human. It is never a decision: two entries scoring 1.0 are still merged
 * only if an admin says so.
 */
function overlapScore(aTokens, bTokens) {
  if (!Array.isArray(aTokens) || !Array.isArray(bTokens)) return 0;
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const b = new Set(bTokens);
  let hits = 0;
  for (const t of aTokens) if (b.has(t)) hits++;
  return hits / Math.max(aTokens.length, bTokens.length);
}

/**
 * Finds catalog entries a submission might duplicate.
 *
 * Two signals, in order of strength:
 *   1. An exact `normalizedKey` match — the dedup spine doing its job. Strong
 *      evidence, still not a decision.
 *   2. Shared search tokens — for near-misses the key did not collapse, e.g. a
 *      brand entered against an existing generic.
 */
async function findNearestMatches(db, submission) {
  const key = submission.normalizedKey || '';
  const proposed = submission.proposed || {};
  const tokens = buildSearchTokens({
    displayName: proposed.displayName || '',
    genericName: proposed.genericName || '',
    brandName: proposed.brandName || '',
  });

  const matches = new Map();

  if (key) {
    try {
      const exact = await db.collection(CATALOG)
        .where('normalizedKey', '==', key).limit(5).get();
      exact.forEach((d) => {
        matches.set(d.id, {
          ...catalogRow(d),
          score: 1,
          evidence: 'exact_normalized_key',
        });
      });
    } catch (e) {
      console.warn(`adminMedicationCatalog: exact-key lookup failed: ${e.message}`);
    }
  }

  // Probe on the most selective token, the same approach searchMedicationCatalog
  // uses; a full scan of the catalog would defeat the point of the bounded
  // query architecture.
  const probe = tokens
    .filter((t) => t.length >= 4)
    .sort((a, b) => b.length - a.length)[0];

  if (probe) {
    try {
      const similar = await db.collection(CATALOG)
        .where('searchTokens', 'array-contains', probe).limit(10).get();
      similar.forEach((d) => {
        if (matches.has(d.id)) return;
        const score = overlapScore(tokens, (d.data() || {}).searchTokens);
        if (score < 0.35) return; // too weak to be worth an admin's attention
        matches.set(d.id, {
          ...catalogRow(d),
          score: Number(score.toFixed(2)),
          evidence: 'shared_search_tokens',
        });
      });
    } catch (e) {
      console.warn(`adminMedicationCatalog: token lookup failed: ${e.message}`);
    }
  }

  return Array.from(matches.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES_PER_SUBMISSION);
}

// ─── List the review queue ────────────────────────────────────────────────────

exports.adminListMedicationSubmissions = onCall(
  { region: 'us-central1' },
  async (request) => {
    await requireAdmin(request);
    const db = getFirestore();
    const status = String((request.data || {}).status || 'pending');

    let snap;
    try {
      snap = await db.collection(SUBMISSIONS)
        .where('status', '==', status)
        .limit(MAX_SUBMISSIONS)
        .get();
    } catch (e) {
      console.error(`adminListMedicationSubmissions: query failed: ${e.message}`);
      throw new HttpsError('internal', 'Could not load the review queue.');
    }

    const submissions = [];
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const proposed = d.proposed || {};
      submissions.push({
        id: doc.id,
        centerId: d.centerId || '',
        centerMedicationId: d.centerMedicationId || '',
        normalizedKey: d.normalizedKey || '',
        displayName: proposed.displayName || '',
        genericName: proposed.genericName || null,
        brandName: proposed.brandName || null,
        strength: proposed.strength || null,
        strengthUnit: proposed.strengthUnit || null,
        dosageForm: proposed.dosageForm || null,
        manufacturer: proposed.manufacturer || null,
        submittedByUid: d.submittedByUid || '',
        // Review evidence only. Independent convergence across unrelated
        // centres is a strong trust signal, but it promotes nothing — see the
        // file header.
        distinctCenterCount: Number(d.distinctCenterCount) || 1,
        status: d.status || 'pending',
        nearestMatches: await findNearestMatches(db, d),
      });
    }

    // Most-corroborated first: the entries several centres independently
    // produced are the ones most worth an admin's time.
    submissions.sort((a, b) =>
      b.distinctCenterCount - a.distinctCenterCount ||
      a.displayName.localeCompare(b.displayName));

    return { submissions, truncated: snap.size >= MAX_SUBMISSIONS };
  },
);

// ─── Approve: promote a submission into the global catalog ───────────────────

exports.adminApproveMedicationSubmission = onCall(
  { region: 'us-central1' },
  async (request) => {
    const uid = await requireAdmin(request);
    const data = request.data || {};
    const submissionId = String(data.submissionId || '').trim();
    if (!submissionId) {
      throw new HttpsError('invalid-argument', 'submissionId is required.');
    }

    const db = getFirestore();
    const subRef = db.collection(SUBMISSIONS).doc(submissionId);
    const subSnap = await subRef.get();
    if (!subSnap.exists) {
      throw new HttpsError('not-found', 'That submission no longer exists.');
    }
    const submission = subSnap.data() || {};
    if (submission.status !== 'pending') {
      throw new HttpsError(
        'failed-precondition',
        `That submission was already ${submission.status}.`,
      );
    }

    // The admin may correct the entry as they approve it — a typo caught in
    // review should be fixed once, here, rather than promoted and edited after.
    const proposed = submission.proposed || {};
    const identity = {
      displayName: String(data.displayName || proposed.displayName || '').trim(),
      genericName: data.genericName ?? proposed.genericName ?? null,
      brandName: data.brandName ?? proposed.brandName ?? null,
      strength: data.strength ?? proposed.strength ?? null,
      strengthUnit: data.strengthUnit ?? proposed.strengthUnit ?? null,
      dosageForm: data.dosageForm ?? proposed.dosageForm ?? null,
      manufacturer: data.manufacturer ?? proposed.manufacturer ?? null,
    };
    if (!identity.displayName) {
      throw new HttpsError('invalid-argument', 'A medication name is required.');
    }

    // Recomputed rather than trusting the submission's stored key: the admin may
    // have just corrected the identity, and the key must describe what is
    // actually being promoted.
    const normalizedKey = buildNormalizedKey(identity);
    const searchTokens = buildSearchTokens(identity);

    const catalogRef = db.collection(CATALOG).doc();
    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(subRef);
        if ((fresh.data() || {}).status !== 'pending') {
          throw new HttpsError(
            'failed-precondition',
            'That submission was reviewed by someone else.',
          );
        }
        tx.set(catalogRef, {
          ...identity,
          route: null,
          // A promoted entry is a clinician contribution, not NLM content — the
          // provenance distinction that keeps RxNorm attribution honest.
          source: 'contributed',
          rxcui: null,
          nationalCode: null,
          nationalCodeSystem: null,
          normalizedKey,
          searchTokens,
          status: 'active',
          usageCount: 0,
          promotedFromSubmissionId: submissionId,
          promotedFromCenterId: submission.centerId || null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(subRef, {
          status: 'approved',
          approvedCatalogId: catalogRef.id,
          reviewedByUid: uid,
          reviewedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error(`adminApproveMedicationSubmission: ${e.message}`);
      throw new HttpsError('internal', 'Could not approve the submission.');
    }

    // NOTE: the originating centre's own medication row is deliberately left
    // untouched. It already works, and rewriting a centre's library as a side
    // effect of an admin action elsewhere is a mutation nobody asked for. The
    // benefit of promotion is for every OTHER centre, which now finds the
    // medication instead of re-creating it.
    console.log(
      `adminApproveMedicationSubmission: ${submissionId} -> ${catalogRef.id} by ${uid}`,
    );
    return { catalogId: catalogRef.id, normalizedKey };
  },
);

// ─── Merge: this submission is an existing catalog entry ─────────────────────

exports.adminMergeMedicationSubmission = onCall(
  { region: 'us-central1' },
  async (request) => {
    const uid = await requireAdmin(request);
    const data = request.data || {};
    const submissionId = String(data.submissionId || '').trim();
    const catalogId = String(data.catalogId || '').trim();
    if (!submissionId || !catalogId) {
      throw new HttpsError(
        'invalid-argument',
        'submissionId and catalogId are required.',
      );
    }

    const db = getFirestore();
    const subRef = db.collection(SUBMISSIONS).doc(submissionId);
    const catalogSnap = await db.collection(CATALOG).doc(catalogId).get();
    if (!catalogSnap.exists) {
      throw new HttpsError('not-found', 'That catalogue entry no longer exists.');
    }

    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(subRef);
        if (!fresh.exists) {
          throw new HttpsError('not-found', 'That submission no longer exists.');
        }
        if ((fresh.data() || {}).status !== 'pending') {
          throw new HttpsError(
            'failed-precondition',
            'That submission was already reviewed.',
          );
        }
        // No catalog write at all: merging says "this already exists", so the
        // right outcome is one entry, not a second one plus a pointer.
        tx.update(subRef, {
          status: 'merged',
          mergedIntoCatalogId: catalogId,
          reviewedByUid: uid,
          reviewedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error(`adminMergeMedicationSubmission: ${e.message}`);
      throw new HttpsError('internal', 'Could not merge the submission.');
    }

    console.log(
      `adminMergeMedicationSubmission: ${submissionId} -> ${catalogId} by ${uid}`,
    );
    return { catalogId };
  },
);

// ─── Reject ──────────────────────────────────────────────────────────────────

exports.adminRejectMedicationSubmission = onCall(
  { region: 'us-central1' },
  async (request) => {
    const uid = await requireAdmin(request);
    const data = request.data || {};
    const submissionId = String(data.submissionId || '').trim();
    if (!submissionId) {
      throw new HttpsError('invalid-argument', 'submissionId is required.');
    }

    const db = getFirestore();
    const subRef = db.collection(SUBMISSIONS).doc(submissionId);

    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(subRef);
        if (!fresh.exists) {
          throw new HttpsError('not-found', 'That submission no longer exists.');
        }
        if ((fresh.data() || {}).status !== 'pending') {
          throw new HttpsError(
            'failed-precondition',
            'That submission was already reviewed.',
          );
        }
        tx.update(subRef, {
          status: 'rejected',
          rejectReason: String(data.reason || '').trim() || null,
          reviewedByUid: uid,
          reviewedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error(`adminRejectMedicationSubmission: ${e.message}`);
      throw new HttpsError('internal', 'Could not reject the submission.');
    }

    // Rejecting does NOT remove the medication from the centre that created it.
    // Their library is theirs; review decides only what becomes shared
    // vocabulary.
    console.log(`adminRejectMedicationSubmission: ${submissionId} by ${uid}`);
    return { ok: true };
  },
);

// ─── Browse the catalog ──────────────────────────────────────────────────────

exports.adminListMedicationCatalog = onCall(
  { region: 'us-central1' },
  async (request) => {
    await requireAdmin(request);
    const db = getFirestore();
    const data = request.data || {};
    const query = String(data.query || '').trim();

    try {
      // With a query, reuse the bounded token index rather than scanning.
      if (query) {
        const token = normalizeText(query)
          .split(' ')
          .filter((t) => t.length >= 2)
          .sort((a, b) => b.length - a.length)[0];
        if (!token) return { items: [] };
        const snap = await db.collection(CATALOG)
          .where('searchTokens', 'array-contains', token)
          .limit(50).get();
        return { items: snap.docs.map(catalogRow) };
      }
      const snap = await db.collection(CATALOG)
        .orderBy('createdAt', 'desc').limit(50).get();
      return { items: snap.docs.map(catalogRow) };
    } catch (e) {
      console.error(`adminListMedicationCatalog: ${e.message}`);
      throw new HttpsError('internal', 'Could not load the catalogue.');
    }
  },
);

// ─── Correct or deprecate a catalog entry ────────────────────────────────────

exports.adminUpdateMedicationCatalogEntry = onCall(
  { region: 'us-central1' },
  async (request) => {
    const uid = await requireAdmin(request);
    const data = request.data || {};
    const catalogId = String(data.catalogId || '').trim();
    if (!catalogId) {
      throw new HttpsError('invalid-argument', 'catalogId is required.');
    }

    const db = getFirestore();
    const ref = db.collection(CATALOG).doc(catalogId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', 'That catalogue entry no longer exists.');
    }
    const current = snap.data() || {};

    const update = { updatedAt: FieldValue.serverTimestamp(), reviewedByUid: uid };

    if (typeof data.status === 'string') {
      if (!['active', 'deprecated', 'merged'].includes(data.status)) {
        throw new HttpsError('invalid-argument', 'Unknown status.');
      }
      update.status = data.status;
    }

    // Identity edits recompute the dedup key and tokens: a corrected name whose
    // key still described the typo would never cluster with anything again.
    const identityKeys = ['displayName', 'genericName', 'brandName',
      'strength', 'strengthUnit', 'dosageForm', 'manufacturer'];
    const touchesIdentity = identityKeys.some((k) => data[k] !== undefined);

    if (touchesIdentity) {
      const identity = {};
      for (const k of identityKeys) {
        identity[k] = data[k] !== undefined ? data[k] : (current[k] ?? null);
      }
      if (!String(identity.displayName || '').trim()) {
        throw new HttpsError('invalid-argument', 'A medication name is required.');
      }
      Object.assign(update, identity);
      update.normalizedKey = buildNormalizedKey(identity);
      update.searchTokens = buildSearchTokens(identity);
    }

    // `source` and `rxcui` are never editable here: provenance is a fact about
    // where an entry came from, not an admin preference, and NLM attribution
    // depends on it staying accurate.
    try {
      await ref.update(update);
    } catch (e) {
      console.error(`adminUpdateMedicationCatalogEntry: ${e.message}`);
      throw new HttpsError('internal', 'Could not update the entry.');
    }

    return { catalogId };
  },
);

// Exported for unit tests only. `findNearestMatches` already takes `db` as a
// parameter, so the ranking logic that decides what an admin is shown can be
// exercised without an emulator or a live catalog.
exports._internal = { catalogRow, overlapScore, findNearestMatches };
