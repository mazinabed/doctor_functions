'use strict';

/**
 * Medication normalization — the server-side dedup spine (ADR-014).
 *
 * PURPOSE AND LIMITS
 * ------------------
 * `normalizedKey` is an IDENTITY / DEDUPLICATION aid only. It exists so that
 * two people typing the same medication in two different centers produce the
 * same key, which lets us:
 *   - warn about a probable duplicate at creation time
 *   - cluster submissions for future admin moderation (Phase 6)
 *
 * It is NOT a statement of clinical equivalence. Two medications sharing a
 * normalizedKey are *probably the same product typed differently* — nothing
 * more. Nothing in TrustyDr may treat a key match as "these are clinically
 * interchangeable", and nothing may auto-promote on a key match alone
 * (ADR-014 §5: promotion is admin-reviewed only).
 *
 * Computed ONLY here, server-side, so the algorithm can be improved without a
 * client release. The client never derives this value.
 */

// Arabic/Persian-Indic digits → ASCII. Doctors occasionally paste strengths
// carrying these when copying from local sources.
const DIGIT_FOLD = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

// Arabic diacritics (harakat) + tatweel. Stripped so decorated and plain
// spellings of the same token collapse together.
const ARABIC_MARKS = /[ً-ْٰـ]/g;

// Unit spelling variants → one canonical token. Deliberately conservative:
// only unambiguous synonyms of the SAME unit, never conversions between units
// (mg and g are different keys — converting them would assert equivalence).
const UNIT_CANON = {
  mg: 'mg', milligram: 'mg', milligrams: 'mg', mgs: 'mg',
  g: 'g', gm: 'g', gram: 'g', grams: 'g',
  mcg: 'mcg', ug: 'mcg', microgram: 'mcg', micrograms: 'mcg', 'µg': 'mcg',
  ml: 'ml', milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', litre: 'l',
  iu: 'iu', 'i.u': 'iu', unit: 'iu', units: 'iu',
  '%': '%', percent: '%', pct: '%',
  meq: 'meq',
  mmol: 'mmol',
};

// Dosage-form spelling variants → one canonical token. Same conservatism:
// synonyms only ("soln" == "solution"), never a claim that a solution and a
// suspension are the same thing.
const FORM_CANON = {
  tab: 'tablet', tabs: 'tablet', tablet: 'tablet', tablets: 'tablet',
  cap: 'capsule', caps: 'capsule', capsule: 'capsule', capsules: 'capsule',
  soln: 'solution', sol: 'solution', solution: 'solution',
  susp: 'suspension', suspension: 'suspension',
  inj: 'injection', injection: 'injection',
  oint: 'ointment', ointment: 'ointment',
  supp: 'suppository', suppository: 'suppository',
  syr: 'syrup', syrup: 'syrup',
  crm: 'cream', cream: 'cream',
  gel: 'gel',
  drop: 'drops', drops: 'drops',
  ophth: 'ophthalmic', ophthalmic: 'ophthalmic',
  inh: 'inhaler', inhaler: 'inhaler',
  patch: 'patch',
  powder: 'powder',
};

function foldDigits(s) {
  let out = '';
  for (const ch of s) out += (DIGIT_FOLD[ch] !== undefined ? DIGIT_FOLD[ch] : ch);
  return out;
}

/**
 * Lowercase, fold digits, strip Arabic marks, collapse punctuation/whitespace.
 * `%` is preserved because it is a strength unit, not punctuation.
 */
function normalizeText(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.normalize('NFKC');
  s = foldDigits(s);
  s = s.replace(ARABIC_MARKS, '');
  s = s.toLowerCase();
  // Keep letters, digits, '%', '.', and whitespace. Everything else separates.
  s = s.replace(/[^\p{L}\p{N}%.\s]+/gu, ' ');
  // A '.' only survives between digits (strengths like 0.5); elsewhere it separates.
  s = s.replace(/(?<!\d)\.(?!\d)/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Drop a trailing zero tail so "0.50" and "0.5" agree; "5.0" becomes "5". */
function canonicalNumber(value) {
  const s = normalizeText(value);
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  if (!s.includes('.')) return String(parseInt(s, 10));
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

// A "<number><unit>" run such as "500mg" or "0.5%".
// The trailing guard must be a negative lookahead rather than \b: '%' is a
// non-word character, so \b would require an adjacent word character and
// "0.5% Ophthalmic Solution" would never match.
const UNIT_ALTERNATION = '%|mg|mcg|ug|g|ml|l|iu|meq|mmol';
const UNIT_RUN_RE =
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})(?![\\p{L}\\p{N}])`, 'u');
const UNIT_RUN_RE_G =
  new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:${UNIT_ALTERNATION})(?![\\p{L}\\p{N}])`, 'gu');

function canonicalUnit(value) {
  const s = normalizeText(value).replace(/\s+/g, '');
  if (!s) return '';
  return UNIT_CANON[s] || s;
}

function canonicalForm(value) {
  const s = normalizeText(value);
  if (!s) return '';
  // Canonicalize each token, drop duplicates, keep author order
  // ("ophthalmic solution" stays "ophthalmic solution").
  const seen = new Set();
  const out = [];
  for (const tok of s.split(' ')) {
    const c = FORM_CANON[tok] || tok;
    if (!seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out.join(' ');
}

/**
 * Extracts "0.5" + "%" from a display name like
 * "Moxifloxacin 0.5% Ophthalmic Solution" when strength/unit were not supplied
 * as separate fields. Best-effort only — returns nulls when nothing matches.
 */
function inferStrengthFromText(text) {
  const s = normalizeText(text);
  // NOTE: the trailing guard is a negative lookahead, not \b. '%' is a
  // non-word character, so \b after it would require an adjacent word
  // character and "0.5% Solution" would never match.
  const m = s.match(UNIT_RUN_RE);
  if (!m) return { strength: '', strengthUnit: '' };
  return { strength: canonicalNumber(m[1]), strengthUnit: canonicalUnit(m[2]) };
}

/**
 * The identity base: the generic/scientific name when supplied, otherwise the
 * display name with any strength/unit/form tokens stripped out, so
 * "Moxifloxacin 0.5% Ophthalmic Solution" and a separate-field entry of
 * generic "Moxifloxacin" + 0.5 % + "Ophthalmic Solution" converge.
 */
function identityBase({ genericName, displayName, strength, strengthUnit, dosageForm }) {
  const generic = normalizeText(genericName);
  if (generic) return generic;

  let s = normalizeText(displayName);
  if (!s) return '';

  // Strip any "<number><unit>" run.
  s = s.replace(UNIT_RUN_RE_G, ' ');
  // Strip explicitly supplied strength/unit tokens.
  for (const extra of [canonicalNumber(strength), canonicalUnit(strengthUnit)]) {
    if (extra) s = s.split(' ').filter((t) => t !== extra).join(' ');
  }
  // Strip dosage-form tokens (both raw and canonical spellings).
  const formTokens = new Set();
  for (const tok of canonicalForm(dosageForm).split(' ')) if (tok) formTokens.add(tok);
  for (const tok of normalizeText(dosageForm).split(' ')) if (tok) formTokens.add(tok);
  s = s
    .split(' ')
    .filter((t) => t && !formTokens.has(t) && !FORM_CANON[t])
    .join(' ');

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Builds the canonical dedup key for a medication.
 *
 * Shape: `generic|form|strength|unit` — empty segments are kept so the key
 * always has four fields and can never be ambiguous about which part is
 * missing.
 *
 * Returns '' when there is not enough information to identify anything, which
 * callers must treat as "no dedup signal available" rather than as a match.
 */
function buildNormalizedKey(input) {
  const src = input || {};
  const base = identityBase(src);
  if (!base) return '';

  let strength = canonicalNumber(src.strength);
  let unit = canonicalUnit(src.strengthUnit);

  // Fall back to whatever the display name carries inline.
  if (!strength || !unit) {
    const inferred = inferStrengthFromText(src.displayName);
    if (!strength) strength = inferred.strength;
    if (!unit) unit = inferred.strengthUnit;
  }

  const form = canonicalForm(src.dosageForm) ||
    inferFormFromText(src.displayName);

  return [base, form, strength, unit].join('|');
}

/** Recovers a dosage form mentioned inside the display name. */
function inferFormFromText(text) {
  const s = normalizeText(text);
  if (!s) return '';
  const found = [];
  const seen = new Set();
  for (const tok of s.split(' ')) {
    const c = FORM_CANON[tok];
    if (c && !seen.has(c)) { seen.add(c); found.push(c); }
  }
  return found.join(' ');
}

/**
 * Search tokens for the bounded array-contains catalog query (ADR-014).
 * Built from displayName + genericName + brandName only — never from
 * translated text, because medication identity is never translated.
 *
 * Includes progressive prefixes (min 3 chars) so "moxi" matches
 * "Moxifloxacin" without an unbounded client-side scan. Capped so a
 * pathological name cannot blow up the document.
 */
const MAX_SEARCH_TOKENS = 60;
const MIN_PREFIX = 3;

function buildSearchTokens({ displayName, genericName, brandName }) {
  const words = new Set();
  for (const field of [displayName, genericName, brandName]) {
    for (const tok of normalizeText(field).split(' ')) {
      if (tok && tok.length >= 2) words.add(tok);
    }
  }
  const tokens = new Set();
  for (const w of words) {
    tokens.add(w);
    for (let i = MIN_PREFIX; i < w.length; i++) tokens.add(w.slice(0, i));
  }
  return Array.from(tokens).sort().slice(0, MAX_SEARCH_TOKENS);
}

module.exports = {
  normalizeText,
  canonicalNumber,
  canonicalUnit,
  canonicalForm,
  identityBase,
  buildNormalizedKey,
  buildSearchTokens,
  MAX_SEARCH_TOKENS,
};
