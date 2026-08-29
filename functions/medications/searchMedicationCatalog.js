'use strict';

/**
 * searchMedicationCatalog — Phase 1 (ADR-014).
 *
 * Server-side search over the global `medication_catalog`. Exists because
 * ADR-014 forbids a client-side read of the catalog: an unfiltered collection
 * read is the broad-read pattern `.claude/rules/firestore-safety.md` §6
 * prohibits, and at catalog scale it would be the most expensive query in the
 * product.
 *
 * The center library is NOT searched here — it is a small, center-scoped,
 * already rule-protected collection the client streams and filters locally
 * (same pattern as clinical_custom_types), so routing it through a callable
 * would add a round-trip and buy nothing.
 *
 * PHASE BOUNDARY: this function searches Firestore only. RxNorm is Phase 2 and
 * is registered as an additional source behind the client's
 * MedicationSearchService — it is deliberately not called from here.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const { normalizeText } = require('./normalizeMedication');

const CATALOG = 'medication_catalog';
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 15;

/**
 * Picks the most selective token to drive the array-contains query: the
 * longest one, since longer prefixes match fewer documents.
 */
function pickQueryToken(query) {
  const tokens = normalizeText(query).split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.sort((a, b) => b.length - a.length)[0];
}

/**
 * Relevance within the catalog source. The client's MedicationSearchService
 * owns cross-source ordering; this only orders catalog hits among themselves.
 */
function scoreRow(row, normalizedQuery) {
  const name = normalizeText(row.displayName);
  const generic = normalizeText(row.genericName);
  let score = 0;
  if (name === normalizedQuery) score += 100;
  else if (name.startsWith(normalizedQuery)) score += 60;
  else if (name.includes(normalizedQuery)) score += 30;
  if (generic.startsWith(normalizedQuery)) score += 20;
  // Real prescribing volume is a better tiebreaker than alphabetical order.
  score += Math.min(Number(row.usageCount) || 0, 20);
  return score;
}

exports.searchMedicationCatalog = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in.');
  }

  const data = request.data || {};
  const rawQuery = typeof data.query === 'string' ? data.query : '';
  const limit = Math.min(
    Math.max(parseInt(data.limit, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const token = pickQueryToken(rawQuery);
  if (!token) return { items: [], source: 'trustydr_catalog', truncated: false };

  const normalizedQuery = normalizeText(rawQuery);
  const db = getFirestore();

  let snap;
  try {
    snap = await db
      .collection(CATALOG)
      .where('status', '==', 'active')
      .where('searchTokens', 'array-contains', token)
      .limit(limit * 3) // over-fetch so local scoring has something to rank
      .get();
  } catch (e) {
    console.error(`searchMedicationCatalog: query failed: ${e.message}`);
    throw new HttpsError('internal', 'Medication search is unavailable.');
  }

  const items = snap.docs
    .map((d) => {
      const v = d.data() || {};
      return {
        id: d.id,
        displayName: v.displayName || '',
        genericName: v.genericName || null,
        brandName: v.brandName || null,
        strength: v.strength || null,
        strengthUnit: v.strengthUnit || null,
        dosageForm: v.dosageForm || null,
        route: v.route || null,
        manufacturer: v.manufacturer || null,
        source: v.source || 'admin',
        rxcui: v.rxcui || null,
        normalizedKey: v.normalizedKey || null,
        usageCount: Number(v.usageCount) || 0,
      };
    })
    .map((row) => ({ row, score: scoreRow(row, normalizedQuery) }))
    .sort((a, b) => b.score - a.score || a.row.displayName.localeCompare(b.row.displayName))
    .slice(0, limit)
    .map((x) => x.row);

  return {
    items,
    source: 'trustydr_catalog',
    truncated: snap.size >= limit * 3,
  };
});
