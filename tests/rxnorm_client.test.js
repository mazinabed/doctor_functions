'use strict';

/**
 * RxNorm client parsing + source boundary — Phase 2 (ADR-014 §7).
 *
 * Pure unit tests, no network and no emulator. The fixtures are verbatim
 * response shapes captured from live RxNav probes during implementation, so the
 * parsing contract is pinned against what the service actually returns rather
 * than against what the docs describe.
 *
 * The most important tests here are the SOURCE BOUNDARY ones: RxNav surfaces
 * proprietary vocabulary content (GS, MMSL, NDDF, ATC) alongside NLM-created
 * RxNorm content, and ADR-014 permits persisting only the latter.
 */

const {
  isPrescribableTty,
  mapConcept,
  mapDrugsResponse,
  mapPropertiesResponse,
  mapApproximateRxcuis,
  cacheKeyForQuery,
} = require('../functions/medications/rxnormClient');

const {
  deriveIdentityFromRxNormName,
  catalogIdForRxcui,
} = require('../functions/medications/materializeRxNormMedication');

// ── Live-captured fixtures ───────────────────────────────────────────────────

// GET /REST/drugs.json?name=moxifloxacin
const DRUGS_RESPONSE = {
  drugGroup: {
    name: 'moxifloxacin',
    conceptGroup: [
      { tty: 'BPCK' }, // present with no conceptProperties — real shape
      { tty: 'GPCK' },
      {
        tty: 'SBD',
        conceptProperties: [{
          rxcui: '261339',
          name: 'moxifloxacin 400 MG Oral Tablet [Avelox]',
          synonym: 'Avelox 400 MG Oral Tablet',
          tty: 'SBD',
          language: 'ENG',
          suppress: 'N',
          umlscui: '',
        }],
      },
      {
        tty: 'SCD',
        conceptProperties: [{
          rxcui: '311787',
          name: 'moxifloxacin 400 MG Oral Tablet',
          synonym: 'moxifloxacin (as moxifloxacin HCl) 400 MG Oral Tablet',
          tty: 'SCD',
          language: 'ENG',
          suppress: 'N',
          umlscui: '',
        }],
      },
    ],
  },
};

// GET /REST/drugs.json?name=zzzznotadrug
const DRUGS_EMPTY = { drugGroup: { name: null } };

// GET /REST/rxcui/403818/properties.json
const PROPERTIES_RESPONSE = {
  properties: {
    rxcui: '403818',
    name: 'moxifloxacin 5 MG/ML Ophthalmic Solution',
    synonym: 'moxifloxacin (as moxifloxacin HCl) 0.5 % Ophthalmic Solution',
    tty: 'SCD',
    language: 'ENG',
    suppress: 'N',
    umlscui: '',
  },
};

// GET /REST/approximateTerm.json?term=moxiflox — note every candidate is
// attributed to a NON-RxNorm vocabulary.
const APPROXIMATE_RESPONSE = {
  approximateGroup: {
    inputTerm: null,
    candidate: [
      { rxcui: '139462', rxaui: '10324008', score: '8.58', rank: '1', source: 'GS' },
      { rxcui: '139462', rxaui: '12765117', score: '8.58', rank: '1', source: 'MMSL' },
      { rxcui: '139462', rxaui: '3625065', score: '8.58', rank: '1', source: 'NDDF' },
      { rxcui: '139462', rxaui: '5481282', score: '8.58', rank: '1', name: 'moxifloxacin', source: 'ATC' },
      { rxcui: '403818', rxaui: '9999999', score: '7.10', rank: '2', source: 'MMSL' },
    ],
  },
};

// ── Source boundary ──────────────────────────────────────────────────────────

describe('SOURCE BOUNDARY — only NLM-created RxNorm content is kept', () => {
  test('approximateTerm yields rxcuis ONLY — never names or source labels', () => {
    const rxcuis = mapApproximateRxcuis(APPROXIMATE_RESPONSE);
    expect(rxcuis).toEqual(['139462', '403818']);
    // The mapper returns bare strings, so a proprietary `name` (the ATC
    // candidate carries one) cannot leak into anything we persist.
    for (const value of rxcuis) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+$/);
    }
  });

  test('approximateTerm output carries no MMSL/GS/NDDF/ATC attribution', () => {
    const serialized = JSON.stringify(mapApproximateRxcuis(APPROXIMATE_RESPONSE));
    for (const sab of ['MMSL', 'GS', 'NDDF', 'ATC', 'moxifloxacin']) {
      expect(serialized).not.toContain(sab);
    }
  });

  test('mapConcept never persists `synonym`, which may be source-derived', () => {
    const concept = mapPropertiesResponse(PROPERTIES_RESPONSE);
    expect(concept.displayName).toBe('moxifloxacin 5 MG/ML Ophthalmic Solution');
    expect(concept).not.toHaveProperty('synonym');
    expect(JSON.stringify(concept)).not.toContain('as moxifloxacin HCl');
  });

  test('a concept keeps exactly the three permitted fields', () => {
    const concept = mapPropertiesResponse(PROPERTIES_RESPONSE);
    expect(Object.keys(concept).sort()).toEqual(['displayName', 'rxcui', 'tty']);
  });
});

// ── TTY filtering ────────────────────────────────────────────────────────────

describe('isPrescribableTty', () => {
  test('accepts prescribable drug products', () => {
    for (const tty of ['SCD', 'SBD', 'GPCK', 'BPCK', 'scd']) {
      expect(isPrescribableTty(tty)).toBe(true);
    }
  });

  test('rejects ingredient and component concepts', () => {
    // These are not things a doctor prescribes — offering them would produce a
    // prescription line with no strength or form.
    for (const tty of ['IN', 'PIN', 'MIN', 'SCDC', 'DF', 'BN', '', null]) {
      expect(isPrescribableTty(tty)).toBe(false);
    }
  });
});

// ── /drugs parsing ───────────────────────────────────────────────────────────

describe('mapDrugsResponse', () => {
  test('extracts prescribable concepts across TTY groups', () => {
    const items = mapDrugsResponse(DRUGS_RESPONSE);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.rxcui).sort()).toEqual(['261339', '311787']);
  });

  test('tolerates concept groups with no conceptProperties', () => {
    // BPCK/GPCK arrive with the key absent — the real shape.
    expect(() => mapDrugsResponse(DRUGS_RESPONSE)).not.toThrow();
  });

  test('returns empty for an unmatched term', () => {
    expect(mapDrugsResponse(DRUGS_EMPTY)).toEqual([]);
  });

  test('returns empty for malformed or missing input', () => {
    expect(mapDrugsResponse(null)).toEqual([]);
    expect(mapDrugsResponse({})).toEqual([]);
    expect(mapDrugsResponse({ drugGroup: {} })).toEqual([]);
  });

  test('deduplicates an rxcui appearing in more than one group', () => {
    const dupe = {
      drugGroup: {
        conceptGroup: [
          { tty: 'SCD', conceptProperties: [{ rxcui: '1', name: 'A', tty: 'SCD' }] },
          { tty: 'SBD', conceptProperties: [{ rxcui: '1', name: 'A', tty: 'SBD' }] },
        ],
      },
    };
    expect(mapDrugsResponse(dupe)).toHaveLength(1);
  });

  test('excludes non-prescribable groups', () => {
    const withIngredient = {
      drugGroup: {
        conceptGroup: [
          { tty: 'IN', conceptProperties: [{ rxcui: '9', name: 'moxifloxacin', tty: 'IN' }] },
        ],
      },
    };
    expect(mapDrugsResponse(withIngredient)).toEqual([]);
  });
});

describe('mapConcept', () => {
  test('drops RxNorm-suppressed concepts', () => {
    expect(mapConcept({ rxcui: '1', name: 'X', tty: 'SCD', suppress: 'Y' })).toBeNull();
  });

  test('keeps concepts with suppress N or absent', () => {
    expect(mapConcept({ rxcui: '1', name: 'X', tty: 'SCD', suppress: 'N' })).not.toBeNull();
    expect(mapConcept({ rxcui: '1', name: 'X', tty: 'SCD' })).not.toBeNull();
  });

  test('rejects entries missing an rxcui or a name', () => {
    expect(mapConcept({ name: 'X', tty: 'SCD' })).toBeNull();
    expect(mapConcept({ rxcui: '1', tty: 'SCD' })).toBeNull();
    expect(mapConcept(null)).toBeNull();
  });
});

describe('mapPropertiesResponse', () => {
  test('maps a properties payload', () => {
    expect(mapPropertiesResponse(PROPERTIES_RESPONSE)).toEqual({
      rxcui: '403818',
      displayName: 'moxifloxacin 5 MG/ML Ophthalmic Solution',
      tty: 'SCD',
    });
  });

  test('returns null for a missing payload', () => {
    expect(mapPropertiesResponse(null)).toBeNull();
    expect(mapPropertiesResponse({})).toBeNull();
  });
});

describe('mapApproximateRxcuis', () => {
  test('deduplicates and respects the cap', () => {
    expect(mapApproximateRxcuis(APPROXIMATE_RESPONSE, 1)).toEqual(['139462']);
  });

  test('returns empty for a malformed payload', () => {
    expect(mapApproximateRxcuis(null)).toEqual([]);
    expect(mapApproximateRxcuis({ approximateGroup: {} })).toEqual([]);
  });
});

// ── Cache keying ─────────────────────────────────────────────────────────────

describe('cacheKeyForQuery', () => {
  test('collapses case and whitespace so equivalent searches share an entry', () => {
    expect(cacheKeyForQuery('Moxifloxacin')).toBe(cacheKeyForQuery('  moxifloxacin  '));
    expect(cacheKeyForQuery('moxi  floxacin')).toBe(cacheKeyForQuery('moxi floxacin'));
  });

  test('produces a legal Firestore document id', () => {
    const key = cacheKeyForQuery('Moxifloxacin 0.5% / Ophthalmic');
    expect(key).toMatch(/^[a-z0-9_]+$/);
    expect(key).not.toContain('/');
  });

  test('distinguishes genuinely different queries', () => {
    expect(cacheKeyForQuery('moxifloxacin')).not.toBe(cacheKeyForQuery('gatifloxacin'));
  });

  test('is bounded in length', () => {
    expect(cacheKeyForQuery('x'.repeat(2000)).length).toBeLessThanOrEqual(400);
  });
});

// ── Identity derivation from RxNorm names ────────────────────────────────────

describe('deriveIdentityFromRxNormName', () => {
  test('splits a clinical drug name', () => {
    expect(deriveIdentityFromRxNormName('moxifloxacin 5 MG/ML Ophthalmic Solution'))
      .toEqual({
        displayName: 'moxifloxacin 5 MG/ML Ophthalmic Solution',
        genericName: 'moxifloxacin',
        brandName: null,
        strength: '5',
        strengthUnit: 'MG/ML',
        dosageForm: 'Ophthalmic Solution',
      });
  });

  test('extracts a bracketed brand from a branded drug name', () => {
    const id = deriveIdentityFromRxNormName('moxifloxacin 400 MG Oral Tablet [Avelox]');
    expect(id.brandName).toBe('Avelox');
    expect(id.genericName).toBe('moxifloxacin');
    expect(id.strength).toBe('400');
    expect(id.strengthUnit).toBe('MG');
    expect(id.dosageForm).toBe('Oral Tablet');
    // displayName always keeps the authoritative RxNorm name verbatim.
    expect(id.displayName).toBe('moxifloxacin 400 MG Oral Tablet [Avelox]');
  });

  test('handles a multi-word ingredient', () => {
    const id = deriveIdentityFromRxNormName(
      'prednisolone acetate 10 MG/ML Ophthalmic Suspension',
    );
    expect(id.genericName).toBe('prednisolone acetate');
    expect(id.dosageForm).toBe('Ophthalmic Suspension');
  });

  test('degrades gracefully when no strength is present', () => {
    const id = deriveIdentityFromRxNormName('Some Unparseable Concept');
    expect(id.displayName).toBe('Some Unparseable Concept');
    expect(id.genericName).toBe('Some Unparseable Concept');
    expect(id.strength).toBeNull();
    expect(id.dosageForm).toBeNull();
  });

  test('handles empty input without throwing', () => {
    const id = deriveIdentityFromRxNormName('');
    expect(id.displayName).toBe('');
    expect(id.genericName).toBeNull();
  });

  test('never invents translated name fields', () => {
    // The language rule: medication identity is standardized and untranslated.
    const id = deriveIdentityFromRxNormName('moxifloxacin 400 MG Oral Tablet');
    expect(id).not.toHaveProperty('nameAr');
    expect(id).not.toHaveProperty('nameKu');
  });
});

describe('catalogIdForRxcui', () => {
  test('is deterministic, which is what makes materialisation idempotent', () => {
    expect(catalogIdForRxcui('403818')).toBe('rxnorm_403818');
    expect(catalogIdForRxcui('403818')).toBe(catalogIdForRxcui('403818'));
  });
});
