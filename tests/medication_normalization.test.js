'use strict';

/**
 * Medication normalization — pure unit tests, no emulator (same shape as
 * phase2_expire_logic.test.js).
 *
 * normalizedKey is an identity/dedup aid ONLY. These tests deliberately pin
 * both directions: what must collapse together, and what must stay apart so we
 * never accidentally assert clinical equivalence.
 */

const {
  normalizeText,
  canonicalNumber,
  canonicalUnit,
  canonicalForm,
  identityBase,
  buildNormalizedKey,
  buildSearchTokens,
  MAX_SEARCH_TOKENS,
} = require('../functions/medications/normalizeMedication');

describe('normalizeText', () => {
  test('lowercases and collapses whitespace', () => {
    expect(normalizeText('  Moxifloxacin   Ophthalmic  ')).toBe('moxifloxacin ophthalmic');
  });

  test('folds Arabic-Indic digits to ASCII', () => {
    expect(normalizeText('٥٠٠')).toBe('500');
    expect(normalizeText('۲۵')).toBe('25');
  });

  test('strips Arabic diacritics and tatweel', () => {
    expect(normalizeText('مُوكسِي')).toBe('موكسي');
    expect(normalizeText('دواـــء')).toBe('دواء');
  });

  test('preserves % as a strength unit, not punctuation', () => {
    expect(normalizeText('0.5%')).toBe('0.5%');
  });

  test('keeps decimal points inside numbers but drops them elsewhere', () => {
    expect(normalizeText('0.5')).toBe('0.5');
    expect(normalizeText('Sod. Chloride')).toBe('sod chloride');
  });

  test('separates on punctuation', () => {
    expect(normalizeText('Amoxicillin/Clavulanate')).toBe('amoxicillin clavulanate');
    expect(normalizeText('Vitamin-D3')).toBe('vitamin d3');
  });

  test('handles null and undefined', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('canonicalNumber', () => {
  test('trims trailing zeros so 0.50 and 0.5 agree', () => {
    expect(canonicalNumber('0.50')).toBe('0.5');
    expect(canonicalNumber('0.5')).toBe('0.5');
  });

  test('normalizes integer-valued decimals', () => {
    expect(canonicalNumber('5.0')).toBe('5');
    expect(canonicalNumber('500')).toBe('500');
    expect(canonicalNumber('0500')).toBe('500');
  });

  test('passes through non-numeric input unchanged', () => {
    expect(canonicalNumber('two')).toBe('two');
    expect(canonicalNumber('')).toBe('');
  });
});

describe('canonicalUnit', () => {
  test('collapses unambiguous synonyms of the same unit', () => {
    expect(canonicalUnit('MG')).toBe('mg');
    expect(canonicalUnit('milligram')).toBe('mg');
    expect(canonicalUnit('mcg')).toBe('mcg');
    expect(canonicalUnit('ug')).toBe('mcg');
    expect(canonicalUnit('IU')).toBe('iu');
    expect(canonicalUnit('percent')).toBe('%');
  });

  test('does NOT convert between different units', () => {
    // Converting mg to g would assert equivalence — strictly out of scope.
    expect(canonicalUnit('mg')).not.toBe(canonicalUnit('g'));
    expect(canonicalUnit('ml')).not.toBe(canonicalUnit('l'));
  });
});

describe('canonicalForm', () => {
  test('collapses abbreviations to a canonical token', () => {
    expect(canonicalForm('Tab')).toBe('tablet');
    expect(canonicalForm('TABLETS')).toBe('tablet');
    expect(canonicalForm('Soln')).toBe('solution');
  });

  test('preserves multi-token forms in author order', () => {
    expect(canonicalForm('Ophthalmic Solution')).toBe('ophthalmic solution');
  });

  test('does NOT treat a solution as a suspension', () => {
    expect(canonicalForm('Solution')).not.toBe(canonicalForm('Suspension'));
  });
});

describe('identityBase', () => {
  test('prefers the generic name when supplied', () => {
    expect(identityBase({
      genericName: 'Moxifloxacin',
      displayName: 'Vigamox 0.5% Ophthalmic Solution',
    })).toBe('moxifloxacin');
  });

  test('strips strength and form tokens out of a display name', () => {
    expect(identityBase({
      displayName: 'Moxifloxacin 0.5% Ophthalmic Solution',
    })).toBe('moxifloxacin');
  });

  test('strips explicitly supplied strength/unit/form', () => {
    expect(identityBase({
      displayName: 'Amoxicillin 500 mg Capsule',
      strength: '500',
      strengthUnit: 'mg',
      dosageForm: 'Capsule',
    })).toBe('amoxicillin');
  });

  test('returns empty when there is nothing to identify', () => {
    expect(identityBase({})).toBe('');
  });
});

describe('buildNormalizedKey — what must collapse', () => {
  test('separate-field and inline-display entries converge', () => {
    const inline = buildNormalizedKey({
      displayName: 'Moxifloxacin 0.5% Ophthalmic Solution',
    });
    const fielded = buildNormalizedKey({
      displayName: 'Moxifloxacin',
      genericName: 'Moxifloxacin',
      strength: '0.5',
      strengthUnit: '%',
      dosageForm: 'Ophthalmic Solution',
    });
    expect(inline).toBe(fielded);
    expect(inline).toBe('moxifloxacin|ophthalmic solution|0.5|%');
  });

  test('casing, spacing and punctuation differences collapse', () => {
    const a = buildNormalizedKey({ displayName: 'AMOXICILLIN 500MG CAPSULE' });
    const b = buildNormalizedKey({ displayName: '  amoxicillin  500 mg  capsule ' });
    const c = buildNormalizedKey({ displayName: 'Amoxicillin, 500mg, Caps.' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('unit synonyms collapse', () => {
    const a = buildNormalizedKey({
      displayName: 'Levothyroxine', strength: '25', strengthUnit: 'mcg', dosageForm: 'Tablet',
    });
    const b = buildNormalizedKey({
      displayName: 'Levothyroxine', strength: '25', strengthUnit: 'ug', dosageForm: 'Tab',
    });
    expect(a).toBe(b);
  });

  test('Arabic-Indic digits in a strength collapse to the ASCII form', () => {
    const a = buildNormalizedKey({ displayName: 'Amoxicillin', strength: '٥٠٠', strengthUnit: 'mg' });
    const b = buildNormalizedKey({ displayName: 'Amoxicillin', strength: '500', strengthUnit: 'mg' });
    expect(a).toBe(b);
  });

  test('trailing-zero strength differences collapse', () => {
    const a = buildNormalizedKey({ displayName: 'Moxi', strength: '0.50', strengthUnit: '%' });
    const b = buildNormalizedKey({ displayName: 'Moxi', strength: '0.5', strengthUnit: '%' });
    expect(a).toBe(b);
  });
});

describe('buildNormalizedKey — what must STAY APART', () => {
  test('different strengths are different medications', () => {
    const a = buildNormalizedKey({ displayName: 'Amoxicillin 250mg Capsule' });
    const b = buildNormalizedKey({ displayName: 'Amoxicillin 500mg Capsule' });
    expect(a).not.toBe(b);
  });

  test('different dosage forms are different medications', () => {
    const a = buildNormalizedKey({ displayName: 'Prednisolone 1% Ophthalmic Solution' });
    const b = buildNormalizedKey({ displayName: 'Prednisolone 1% Ophthalmic Suspension' });
    expect(a).not.toBe(b);
  });

  test('different units are different medications', () => {
    const a = buildNormalizedKey({ displayName: 'Drug', strength: '1', strengthUnit: 'mg' });
    const b = buildNormalizedKey({ displayName: 'Drug', strength: '1', strengthUnit: 'g' });
    expect(a).not.toBe(b);
  });

  test('different actives are different medications', () => {
    const a = buildNormalizedKey({ displayName: 'Moxifloxacin 0.5% Solution' });
    const b = buildNormalizedKey({ displayName: 'Gatifloxacin 0.5% Solution' });
    expect(a).not.toBe(b);
  });

  test('a brand does not silently merge into its generic', () => {
    // Vigamox has no genericName supplied here, so it keeps its own identity.
    // Linking brand to generic is a moderation decision (Phase 6), never an
    // automatic string inference.
    const brand = buildNormalizedKey({ displayName: 'Vigamox 0.5% Ophthalmic Solution' });
    const generic = buildNormalizedKey({ displayName: 'Moxifloxacin 0.5% Ophthalmic Solution' });
    expect(brand).not.toBe(generic);
  });
});

describe('buildNormalizedKey — shape and degenerate input', () => {
  test('always produces four pipe-separated segments', () => {
    expect(buildNormalizedKey({ displayName: 'Aspirin' }).split('|')).toHaveLength(4);
  });

  test('returns empty string when nothing identifiable is supplied', () => {
    expect(buildNormalizedKey({})).toBe('');
    expect(buildNormalizedKey({ displayName: '   ' })).toBe('');
    expect(buildNormalizedKey(null)).toBe('');
  });

  test('empty segments are preserved so the key is never ambiguous', () => {
    expect(buildNormalizedKey({ displayName: 'Aspirin' })).toBe('aspirin|||');
  });
});

describe('buildSearchTokens', () => {
  test('includes whole words and progressive prefixes from 3 chars', () => {
    const t = buildSearchTokens({ displayName: 'Moxifloxacin' });
    expect(t).toContain('moxifloxacin');
    expect(t).toContain('mox');
    expect(t).toContain('moxi');
    expect(t).not.toContain('mo');
  });

  test('draws on displayName, genericName and brandName', () => {
    const t = buildSearchTokens({
      displayName: 'Vigamox', genericName: 'Moxifloxacin', brandName: 'Alcon',
    });
    expect(t).toContain('vigamox');
    expect(t).toContain('moxifloxacin');
    expect(t).toContain('alcon');
  });

  test('is capped so a pathological name cannot bloat the document', () => {
    const t = buildSearchTokens({
      displayName: Array.from({ length: 40 }, (_, i) => `token${i}word`).join(' '),
    });
    expect(t.length).toBeLessThanOrEqual(MAX_SEARCH_TOKENS);
  });

  test('is deterministic and sorted', () => {
    const a = buildSearchTokens({ displayName: 'Amoxicillin Capsule' });
    const b = buildSearchTokens({ displayName: 'Capsule Amoxicillin' });
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  test('returns empty for empty input', () => {
    expect(buildSearchTokens({})).toEqual([]);
  });
});
