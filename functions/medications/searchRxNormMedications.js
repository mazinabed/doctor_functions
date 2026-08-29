'use strict';

/**
 * searchRxNormMedications — Prescription Platform Phase 2 (ADR-014 §7).
 *
 * The RxNorm tier of the medication search. Registered behind the client's
 * MedicationSearchService alongside the Phase 1 sources; the picker is
 * unchanged.
 *
 * Two caching layers, for two different reasons:
 *
 *   1. **Query cache** (`rxnorm_cache/{key}`) — repeat searches for the same
 *      term skip the network entirely. Short TTL, because it caches a *search*,
 *      not an identity.
 *   2. **Entity materialisation** — handled by materializeRxNormMedication when
 *      a doctor actually picks a result. That is the durable half: once picked,
 *      the medication lives in `medication_catalog` and is served from
 *      Firestore forever, so RxNav is only ever hit for terms nobody has
 *      chosen yet.
 *
 * NEVER a runtime requirement. Every failure path returns
 * `{ items: [], degraded: true }` so the client can report a partial result and
 * carry on; nothing here throws for an RxNav problem.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const { searchRxNorm, cacheKeyForQuery } = require('./rxnormClient');
const { normalizeText } = require('./normalizeMedication');

const CACHE = 'rxnorm_cache';
const CATALOG = 'medication_catalog';

/**
 * Query-cache lifetime. Short by design: RxNorm content is stable, but this
 * caches a *search result set*, and a term that matched nothing today may match
 * once RxNorm adds a concept. The durable path is materialisation, not this.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const MIN_QUERY_LENGTH = 3;
const MAX_LIMIT = 15;
const DEFAULT_LIMIT = 10;

/** Relevance within the RxNorm tier only — cross-source order is the client's. */
function scoreConcept(concept, normalizedQuery) {
  const name = normalizeText(concept.displayName);
  let score = 0;
  if (name === normalizedQuery) score += 100;
  else if (name.startsWith(normalizedQuery)) score += 60;
  else if (name.includes(normalizedQuery)) score += 25;
  // Prefer clinical (generic) products over branded ones: a doctor searching a
  // molecule usually wants the generic concept.
  if (concept.tty === 'SCD') score += 6;
  return score;
}

async function readCache(db, key) {
  try {
    const snap = await db.collection(CACHE).doc(key).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const expiresAt = data.expiresAt;
    if (!expiresAt || typeof expiresAt.toMillis !== 'function') return null;
    if (expiresAt.toMillis() <= Date.now()) return null;
    return Array.isArray(data.items) ? data.items : null;
  } catch (e) {
    // A cache read failure must not fail the search.
    console.warn(`searchRxNormMedications: cache read failed: ${e.message}`);
    return null;
  }
}

async function writeCache(db, key, query, items) {
  try {
    await db.collection(CACHE).doc(key).set({
      query,
      items,
      fetchedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + CACHE_TTL_MS),
    });
  } catch (e) {
    console.warn(`searchRxNormMedications: cache write failed: ${e.message}`);
  }
}

/**
 * Marks results that already exist in the catalog, so the client can offer
 * "add to library" directly instead of a redundant materialise round-trip.
 * Firestore `in` queries cap at 30 values; the limit here is well under that.
 */
async function annotateExistingCatalogIds(db, items) {
  if (items.length === 0) return items;
  const ids = items.map((i) => `rxnorm_${i.rxcui}`);
  try {
    const snaps = await db.getAll(...ids.map((id) => db.collection(CATALOG).doc(id)));
    const present = new Set(
      snaps.filter((s) => s.exists).map((s) => s.id),
    );
    return items.map((i) => ({
      ...i,
      catalogId: present.has(`rxnorm_${i.rxcui}`) ? `rxnorm_${i.rxcui}` : null,
    }));
  } catch (e) {
    console.warn(`searchRxNormMedications: catalog annotate failed: ${e.message}`);
    return items.map((i) => ({ ...i, catalogId: null }));
  }
}

exports.searchRxNormMedications = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in.');
  }

  const data = request.data || {};
  const rawQuery = typeof data.query === 'string' ? data.query : '';
  const query = rawQuery.trim();
  const limit = Math.min(
    Math.max(parseInt(data.limit, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  // RxNorm is a fallback for terms the local tiers missed, so a very short
  // query is not worth an external round-trip.
  if (query.length < MIN_QUERY_LENGTH) {
    return { items: [], source: 'rxnorm', degraded: false, cached: false };
  }

  const db = getFirestore();
  const key = cacheKeyForQuery(query);

  const cached = await readCache(db, key);
  if (cached) {
    return {
      items: (await annotateExistingCatalogIds(db, cached)).slice(0, limit),
      source: 'rxnorm',
      degraded: false,
      cached: true,
    };
  }

  const concepts = await searchRxNorm(query, { limit });

  // null = RxNav unavailable. Report degraded; never throw.
  if (concepts === null) {
    return { items: [], source: 'rxnorm', degraded: true, cached: false };
  }

  const normalizedQuery = normalizeText(query);
  const ranked = concepts
    .map((c) => ({ c, score: scoreConcept(c, normalizedQuery) }))
    .sort((a, b) => b.score - a.score ||
      a.c.displayName.localeCompare(b.c.displayName))
    .map((x) => x.c);

  // Cache the RxNorm answer itself, including a genuine empty result — that is
  // a real answer and re-asking costs a round-trip for nothing.
  await writeCache(db, key, query, ranked);

  return {
    items: (await annotateExistingCatalogIds(db, ranked)).slice(0, limit),
    source: 'rxnorm',
    degraded: false,
    cached: false,
  };
});
