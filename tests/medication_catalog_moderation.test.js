'use strict';

/**
 * Medication catalog moderation — pure unit tests, no emulator (same shape as
 * medication_normalization.test.js).
 *
 * Scope: the near-duplicate evidence an admin is shown before they promote a
 * clinician-contributed medication into the global catalog.
 *
 * The invariant these tests exist to protect is a NEGATIVE one, and it cannot
 * be asserted by looking at any single function: nothing in this file, and
 * nothing anywhere in the codebase, promotes an entry on its own. `score` and
 * `distinctCenterCount` order and inform a human decision. So every assertion
 * below is about what a reviewer SEES, never about an outcome the system
 * reaches by itself — and one test pins that absence directly.
 */

const {
  catalogRow,
  overlapScore,
  findNearestMatches,
} = require('../functions/medications/adminMedicationCatalog')._internal;

const { buildSearchTokens, buildNormalizedKey } =
  require('../functions/medications/normalizeMedication');

// ─── Fake Firestore ───────────────────────────────────────────────────────────
// Just enough of the query surface findNearestMatches uses. Queries are
// evaluated against an in-memory array, so ranking is tested against real
// documents rather than hand-fed match objects.

function doc(id, data) {
  return { id, data: () => data };
}

function fakeDb(docs, { failExact = false, failTokens = false } = {}) {
  return {
    collection() {
      return {
        where(field, op, value) {
          const self = {
            limit() { return self; },
            async get() {
              if (field === 'normalizedKey' && failExact) {
                throw new Error('exact lookup exploded');
              }
              if (field === 'searchTokens' && failTokens) {
                throw new Error('token lookup exploded');
              }
              const hits = docs.filter((d) => {
                const v = d.data()[field];
                if (op === '==') return v === value;
                if (op === 'array-contains') {
                  return Array.isArray(v) && v.includes(value);
                }
                return false;
              });
              return { forEach: (fn) => hits.forEach(fn) };
            },
          };
          return self;
        },
      };
    },
  };
}

function catalogDoc(id, identity, extra = {}) {
  return doc(id, {
    ...identity,
    normalizedKey: buildNormalizedKey(identity),
    searchTokens: buildSearchTokens(identity),
    status: 'active',
    ...extra,
  });
}

const MOXI = {
  displayName: 'Moxifloxacin 0.5% Ophthalmic Solution',
  genericName: 'Moxifloxacin',
  strength: '0.5',
  strengthUnit: '%',
  dosageForm: 'Ophthalmic Solution',
};

const AMOXI = {
  displayName: 'Amoxicillin 500 mg Capsule',
  genericName: 'Amoxicillin',
  strength: '500',
  strengthUnit: 'mg',
  dosageForm: 'Capsule',
};

function submissionFor(identity, overrides = {}) {
  return {
    normalizedKey: buildNormalizedKey(identity),
    proposed: { ...identity },
    ...overrides,
  };
}

// ─── catalogRow ───────────────────────────────────────────────────────────────

describe('catalogRow', () => {
  test('carries provenance, because an rxnorm row must never be re-typed', () => {
    const row = catalogRow(doc('rxnorm_311036', {
      displayName: MOXI.displayName,
      source: 'rxnorm',
      rxcui: '311036',
    }));
    expect(row.source).toBe('rxnorm');
    expect(row.rxcui).toBe('311036');
  });

  test('defaults an unmarked entry to admin provenance, never to rxnorm', () => {
    // Guessing rxnorm here would attach an NLM claim to something NLM never
    // supplied.
    const row = catalogRow(doc('x', { displayName: 'Drug 1 MG Tablet' }));
    expect(row.source).toBe('admin');
    expect(row.rxcui).toBeNull();
  });

  test('exposes no translated name fields (ADR-014)', () => {
    // Medication identity is standardized English. A nameAr/nameKu reaching the
    // admin UI would be the first step toward translating drug names.
    const row = catalogRow(catalogDoc('c1', MOXI));
    expect(Object.keys(row)).not.toContain('nameAr');
    expect(Object.keys(row)).not.toContain('nameKu');
  });

  test('survives a malformed document rather than throwing at the reviewer', () => {
    const row = catalogRow({ id: 'c1', data: () => undefined });
    expect(row.displayName).toBe('');
    expect(row.usageCount).toBe(0);
    expect(row.status).toBe('active');
  });
});

// ─── overlapScore ─────────────────────────────────────────────────────────────

describe('overlapScore', () => {
  test('is 1 only when both token sets are identical', () => {
    expect(overlapScore(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  test('divides by the LARGER set, so a subset never scores 1', () => {
    // Otherwise a one-token submission would score a perfect match against
    // every richer catalog entry containing that token.
    expect(overlapScore(['a'], ['a', 'b', 'c'])).toBeCloseTo(1 / 3);
  });

  test('is symmetric', () => {
    expect(overlapScore(['a', 'b'], ['b', 'c', 'd']))
      .toBe(overlapScore(['b', 'c', 'd'], ['a', 'b']));
  });

  test('is 0 for empty or non-array input rather than NaN', () => {
    expect(overlapScore([], ['a'])).toBe(0);
    expect(overlapScore(['a'], [])).toBe(0);
    expect(overlapScore(null, ['a'])).toBe(0);
    expect(overlapScore(['a'], undefined)).toBe(0);
  });
});

// ─── findNearestMatches ───────────────────────────────────────────────────────

describe('findNearestMatches', () => {
  test('surfaces an exact dedup-key collision as the strongest evidence', async () => {
    const db = fakeDb([catalogDoc('rxnorm_311036', MOXI, { source: 'rxnorm' })]);
    const matches = await findNearestMatches(db, submissionFor(MOXI));

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('rxnorm_311036');
    expect(matches[0].evidence).toBe('exact_normalized_key');
    expect(matches[0].score).toBe(1);
  });

  test('a typo still surfaces the entry it duplicates, via shared tokens', async () => {
    // The whole reason review exists: the key does NOT collapse a misspelling,
    // so token overlap has to carry the reviewer to the right candidate.
    const typo = { ...MOXI, displayName: 'Moxifloxacn Ophthalmic Solution' };
    const db = fakeDb([catalogDoc('rxnorm_311036', MOXI, { source: 'rxnorm' })]);

    const matches = await findNearestMatches(db, submissionFor(typo, {
      normalizedKey: 'moxifloxacn|ophthalmic solution|0.5|%',
    }));

    expect(matches.map((m) => m.id)).toContain('rxnorm_311036');
    expect(matches[0].evidence).toBe('shared_search_tokens');
    expect(matches[0].score).toBeLessThan(1);
  });

  test('does not offer an unrelated medication as a candidate', async () => {
    const db = fakeDb([catalogDoc('c_amoxi', AMOXI)]);
    const matches = await findNearestMatches(db, submissionFor(MOXI));
    expect(matches).toEqual([]);
  });

  test('an exact-key hit is never demoted below a token hit', async () => {
    const db = fakeDb([
      catalogDoc('c_exact', MOXI),
      catalogDoc('c_similar', {
        ...MOXI,
        displayName: 'Moxifloxacin 0.5% Ophthalmic Drops',
        dosageForm: 'Drops',
      }),
    ]);
    const matches = await findNearestMatches(db, submissionFor(MOXI));

    expect(matches[0].id).toBe('c_exact');
    expect(matches[0].evidence).toBe('exact_normalized_key');
  });

  test('reports each candidate once, even when both signals hit it', async () => {
    const db = fakeDb([catalogDoc('c_exact', MOXI)]);
    const matches = await findNearestMatches(db, submissionFor(MOXI));
    expect(matches.filter((m) => m.id === 'c_exact')).toHaveLength(1);
  });

  test('caps the list, so review stays a decision and not a scroll', async () => {
    const docs = [];
    for (let i = 0; i < 9; i++) docs.push(catalogDoc(`c_${i}`, MOXI));
    const matches = await findNearestMatches(db_(docs), submissionFor(MOXI));
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  test('returns nothing rather than throwing when the catalog is empty', async () => {
    expect(await findNearestMatches(fakeDb([]), submissionFor(MOXI))).toEqual([]);
  });

  test('a submission with no key still gets token evidence', async () => {
    const db = fakeDb([catalogDoc('c_exact', MOXI)]);
    const matches = await findNearestMatches(db, {
      normalizedKey: '',
      proposed: { displayName: MOXI.displayName },
    });
    expect(matches.map((m) => m.id)).toContain('c_exact');
  });

  test('a failed lookup degrades to less evidence, never to a crash', async () => {
    // A reviewer seeing fewer candidates can still make a correct decision.
    // A thrown error would take the whole review queue down.
    const docs = [catalogDoc('c_exact', MOXI)];

    const noExact = await findNearestMatches(
      fakeDb(docs, { failExact: true }), submissionFor(MOXI));
    expect(noExact.map((m) => m.evidence)).not.toContain('exact_normalized_key');

    const noTokens = await findNearestMatches(
      fakeDb(docs, { failTokens: true }), submissionFor(MOXI));
    expect(noTokens[0].evidence).toBe('exact_normalized_key');

    const neither = await findNearestMatches(
      fakeDb(docs, { failExact: true, failTokens: true }), submissionFor(MOXI));
    expect(neither).toEqual([]);
  });
});

// ─── The absence that matters most ────────────────────────────────────────────

describe('no automatic promotion exists', () => {
  test('the moderation module exports no promoter, scheduler or threshold', () => {
    const mod = require('../functions/medications/adminMedicationCatalog');
    const exported = Object.keys(mod);

    // Every catalog write must be reachable only through an admin-gated
    // callable. A scheduled or triggered export here would be a path into
    // `medication_catalog` with no human on it.
    for (const name of exported) {
      if (name === '_internal') continue;
      expect(name).toMatch(/^admin[A-Z]/);
    }
    expect(exported).toContain('adminApproveMedicationSubmission');
  });

  test('findNearestMatches reads distinctCenterCount into no decision', async () => {
    // Convergence across many centres is the strongest trust signal available,
    // and it is deliberately inert: an identical result whether one centre or
    // fifty produced this medication.
    const db = fakeDb([catalogDoc('c_exact', MOXI)]);

    const one = await findNearestMatches(
      db, submissionFor(MOXI, { distinctCenterCount: 1 }));
    const many = await findNearestMatches(
      db, submissionFor(MOXI, { distinctCenterCount: 50 }));

    expect(many).toEqual(one);
  });
});

function db_(docs) {
  return fakeDb(docs);
}
