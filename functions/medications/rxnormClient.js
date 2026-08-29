'use strict';

/**
 * RxNorm / RxNav client — Prescription Platform Phase 2 (ADR-014 §7).
 *
 * ─── SOURCE BOUNDARY (the reason this file reads the way it does) ───────────
 *
 * RxNav surfaces content from many vocabularies, not all of which are
 * NLM-created RxNorm. A live probe of `/approximateTerm` for "moxiflox"
 * returns candidates attributed to GS, MMSL, NDDF and ATC — proprietary
 * third-party vocabularies. ADR-014 permits persisting ONLY NLM-created
 * RxNorm normalized content.
 *
 * The rule applied throughout this file:
 *
 *   - An **rxcui is an NLM identifier** and is safe to use as a pointer.
 *   - A **name is only safe if it came from an RxNorm concept** — i.e. from
 *     `/drugs` conceptProperties or `/rxcui/{id}/properties`, never from an
 *     approximateTerm candidate's own `name`/`source` fields.
 *   - `synonym` is deliberately NOT persisted: for SCD 403818 it reads
 *     "moxifloxacin (as moxifloxacin HCl) 0.5 % Ophthalmic Solution", which
 *     may be source-vocabulary derived. Only `name` is used.
 *   - `/rxcui/{id}/allProperties` is never called — it returns attributes
 *     across source vocabularies and would cross the boundary.
 *
 * So `approximateTerm` is used strictly as a *typo-tolerant rxcui finder*, and
 * every name we keep is then re-read from RxNorm's own properties endpoint.
 *
 * ─── AVAILABILITY ──────────────────────────────────────────────────────────
 *
 * RxNorm is a fallback search source and is NEVER a runtime requirement for
 * prescribing. Every network call is bounded by a hard timeout, and every
 * failure path returns empty rather than throwing, so a doctor can always
 * issue a prescription with RxNav unreachable.
 *
 * Pure mapping functions are exported separately from the network functions so
 * the parsing contract is unit-testable without touching the network.
 */

const RXNAV_BASE = 'https://rxnav.nlm.nih.gov/REST';

/** Hard per-request deadline. RxNav must never hold up a search. */
const REQUEST_TIMEOUT_MS = 2500;

/**
 * Prescribable RxNorm term types. SCD/SBD are clinical and branded drug
 * products; GPCK/BPCK are their pack equivalents. Ingredient-level TTYs (IN,
 * PIN, MIN) and component TTYs (SCDC) are deliberately excluded — they are not
 * things a doctor prescribes, and offering them would invite a prescription
 * line with no strength or form.
 */
const PRESCRIBABLE_TTYS = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);

// ─── Pure mappers ────────────────────────────────────────────────────────────

function isPrescribableTty(tty) {
  return PRESCRIBABLE_TTYS.has(String(tty || '').toUpperCase());
}

/**
 * One RxNorm concept reduced to the fields ADR-014 permits persisting.
 * Returns null for anything unusable or suppressed.
 */
function mapConcept(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rxcui = String(raw.rxcui || '').trim();
  const name = String(raw.name || '').trim();
  const tty = String(raw.tty || '').trim().toUpperCase();
  if (!rxcui || !name) return null;
  // 'Y' means RxNorm has suppressed the concept — never surface it.
  if (String(raw.suppress || 'N').toUpperCase() === 'Y') return null;
  return { rxcui, displayName: name, tty };
}

/**
 * Parses `/drugs.json?name=`.
 * Shape: { drugGroup: { name, conceptGroup: [ { tty, conceptProperties: [] } ] } }
 * An unmatched term returns { drugGroup: { name: null } } with no conceptGroup.
 */
function mapDrugsResponse(json) {
  const groups = json && json.drugGroup && Array.isArray(json.drugGroup.conceptGroup)
    ? json.drugGroup.conceptGroup
    : [];

  const out = [];
  const seen = new Set();
  for (const group of groups) {
    if (!isPrescribableTty(group && group.tty)) continue;
    const props = (group && Array.isArray(group.conceptProperties))
      ? group.conceptProperties
      : [];
    for (const raw of props) {
      const concept = mapConcept(raw);
      if (!concept || seen.has(concept.rxcui)) continue;
      seen.add(concept.rxcui);
      out.push(concept);
    }
  }
  return out;
}

/**
 * Parses `/rxcui/{id}/properties.json`.
 * Shape: { properties: { rxcui, name, synonym, tty, language, suppress } }
 * `synonym` is intentionally ignored — see the source-boundary note above.
 */
function mapPropertiesResponse(json) {
  const p = json && json.properties;
  if (!p) return null;
  return mapConcept(p);
}

/**
 * Parses `/approximateTerm.json`, returning ONLY distinct rxcuis.
 *
 * Candidate `name` and `source` are deliberately discarded: a live probe shows
 * these attributed to GS / MMSL / NDDF / ATC. The rxcui is an NLM identifier
 * and is safe; the accompanying content is not.
 */
function mapApproximateRxcuis(json, maxRxcuis = 8) {
  const candidates = json && json.approximateGroup &&
    Array.isArray(json.approximateGroup.candidate)
    ? json.approximateGroup.candidate
    : [];

  const seen = new Set();
  for (const c of candidates) {
    const rxcui = String((c && c.rxcui) || '').trim();
    if (!rxcui || seen.has(rxcui)) continue;
    seen.add(rxcui);
    if (seen.size >= maxRxcuis) break;
  }
  return Array.from(seen);
}

/**
 * Stable cache key for a query. Lowercased and whitespace-collapsed so
 * "Moxifloxacin  " and "moxifloxacin" share one cache entry. Non-alphanumerics
 * become '_' so the value is a legal Firestore document id.
 */
function cacheKeyForQuery(query) {
  const normalized = String(query || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return normalized.replace(/[^a-z0-9]+/g, '_').slice(0, 400);
}

// ─── Network ─────────────────────────────────────────────────────────────────

/**
 * GETs JSON with a hard deadline. Returns null on ANY failure — timeout,
 * non-2xx, unparseable body, DNS. Callers treat null as "RxNorm unavailable"
 * and degrade; nothing here ever throws into a search request.
 */
async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // RxNav asks callers to identify themselves.
        'User-Agent': 'TrustyDr/1.0 (healthcare; +https://trustydr.com)',
      },
    });
    if (!res.ok) {
      console.warn(`rxnormClient: ${res.status} from ${url}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`rxnormClient: request failed ${url}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Exact/near name search over RxNorm drug concepts. */
async function searchDrugs(query) {
  const url = `${RXNAV_BASE}/drugs.json?name=${encodeURIComponent(query)}`;
  const json = await fetchJson(url);
  if (!json) return null; // null = unavailable, [] = genuinely no matches
  return mapDrugsResponse(json);
}

/** Resolves one rxcui to its RxNorm concept. */
async function resolveRxcui(rxcui) {
  const url = `${RXNAV_BASE}/rxcui/${encodeURIComponent(rxcui)}/properties.json`;
  const json = await fetchJson(url);
  if (!json) return null;
  return mapPropertiesResponse(json);
}

/** Typo-tolerant rxcui discovery. Names from this endpoint are discarded. */
async function approximateRxcuis(term, maxRxcuis = 8) {
  const url = `${RXNAV_BASE}/approximateTerm.json?term=${encodeURIComponent(term)}` +
    `&maxEntries=${Math.min(Math.max(maxRxcuis, 1), 20)}`;
  const json = await fetchJson(url);
  if (!json) return null;
  return mapApproximateRxcuis(json, maxRxcuis);
}

/**
 * The Phase 2 search strategy.
 *
 * 1. `/drugs` — the RXNORM-scoped path, and the common case.
 * 2. Only if that yields nothing, `/approximateTerm` to find candidate rxcuis,
 *    each re-read through `/rxcui/{id}/properties` so every persisted name is
 *    RxNorm's own. Bounded by [maxResolve] to cap fan-out on a bad query.
 *
 * Returns null when RxNorm is unavailable (so the caller can report a degraded
 * source) and [] when RxNorm answered but had nothing.
 */
async function searchRxNorm(query, { limit = 10, maxResolve = 5 } = {}) {
  const direct = await searchDrugs(query);
  if (direct === null) return null;
  if (direct.length > 0) return direct.slice(0, limit);

  const rxcuis = await approximateRxcuis(query, maxResolve * 2);
  if (rxcuis === null) return null;
  if (rxcuis.length === 0) return [];

  const resolved = await Promise.all(
    rxcuis.slice(0, maxResolve).map((id) => resolveRxcui(id)),
  );

  const out = [];
  const seen = new Set();
  for (const concept of resolved) {
    if (!concept || seen.has(concept.rxcui)) continue;
    // Approximate matching can surface ingredient-level concepts; keep the
    // same prescribable-only rule the direct path applies.
    if (!isPrescribableTty(concept.tty)) continue;
    seen.add(concept.rxcui);
    out.push(concept);
  }
  return out.slice(0, limit);
}

module.exports = {
  // pure
  isPrescribableTty,
  mapConcept,
  mapDrugsResponse,
  mapPropertiesResponse,
  mapApproximateRxcuis,
  cacheKeyForQuery,
  PRESCRIBABLE_TTYS,
  REQUEST_TIMEOUT_MS,
  // network
  fetchJson,
  searchDrugs,
  resolveRxcui,
  approximateRxcuis,
  searchRxNorm,
};
