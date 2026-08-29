'use strict';

/**
 * Prescription verification — Prescription Platform Phase 7 (ADR-013 §8).
 * Pure unit tests, no emulator.
 *
 * The threat these tests exist to close: the printed sheet shows a SHORT,
 * guessable reference number, and a pharmacist reads it out loud. If that
 * reference — or anything else printed on the paper — could be used to fetch a
 * prescription, the whole patient population would be enumerable. So the tests
 * below pin two things hard:
 *
 *   1. The credential is unguessable, server-minted, and unrelated to anything
 *      visible on the sheet.
 *   2. The public projection carries only what a pharmacist needs to match a
 *      document, and never a diagnosis, an internal id, or the token itself.
 *
 * And one boundary that is legal rather than technical: TrustyDr confirms a
 * document matches a record it issued. It does not certify clinical
 * appropriateness and it does not decide whether dispensing is permitted — so
 * nothing here may produce the word "expired" or an eligibility verdict.
 */

const {
  TOKEN_PATTERN,
  generateToken,
  isWellFormedToken,
  referenceNumber,
} = require('../functions/prescriptions/verificationToken');

const {
  ADVISORY_AGE_DAYS,
  maskPatientName,
  maskPhone,
  ageInDays,
  projectVerificationItem,
  summarizeDispensing,
  buildVerificationProjection,
} = require('../functions/prescriptions/verificationProjection');

const DAY = 86400000;
const NOW = Date.parse('2026-08-28T12:00:00Z');

function ts(ms) {
  return { toMillis: () => ms };
}

const MOXI_ITEM = {
  id: 'rxitem-1',
  displayName: 'Moxifloxacin 0.5% Ophthalmic Solution',
  genericName: 'Moxifloxacin',
  strength: '0.5',
  strengthUnit: '%',
  dosageForm: 'Ophthalmic Solution',
  doseAmount: 1,
  doseUnitCode: 'drop',
  routeCode: 'affected_eye',
  frequencyCode: 'qid',
  durationValue: 7,
  durationUnitCode: 'day',
  quantity: 1,
  quantityUnitCode: 'bottle',
  instructions: 'Shake well before use',
  instructionsLocale: 'en',
  directionsAuthored: { text: 'ONE DROP...', locale: 'en' },
  sortOrder: 0,
};

function prescription(overrides = {}) {
  return {
    appointmentId: 'appt_1',
    centerId: 'center1',
    patientId: 'uid_patient1',
    patientName: 'Ahmed Hassan Ali',
    patientPhone: '+9647701234567',
    doctorId: 'uid_doctor1',
    doctorName: 'Zainab Karim',
    doctorSpecialty: 'Ophthalmology',
    doctorLicenseNumber: 'LIC-4471',
    centerName: 'Al Noor Eye Centre',
    centerAddress: 'Karrada, Baghdad',
    centerPhone: '+9647800000000',
    items: [MOXI_ITEM],
    diagnosisNote: 'SECRET-DIAGNOSIS-MARKER',
    patientInstructions: 'Return in one week',
    status: 'issued',
    issuedAt: ts(NOW - 2 * DAY),
    createdByUid: 'uid_doctor1',
    verificationToken: generateToken(),
    printCount: 2,
    ...overrides,
  };
}

function project(overrides = {}, extra = {}) {
  return buildVerificationProjection({
    prescriptionId: 'abc123XYZ4F2A9C',
    prescription: prescription(overrides),
    nowMs: NOW,
    ...extra,
  });
}

// ─── The credential ───────────────────────────────────────────────────────────

describe('verification token', () => {
  test('is 32 base64url characters — 192 bits of entropy', () => {
    const token = generateToken();
    expect(token).toMatch(TOKEN_PATTERN);
    expect(token).toHaveLength(32);
  });

  test('is unpredictable across mints', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(generateToken());
    expect(seen.size).toBe(500);
  });

  test('is URL-safe, so it survives a QR and a link unescaped', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateToken();
      expect(encodeURIComponent(t)).toBe(t);
    }
  });

  test('rejects anything that is not a minted token', () => {
    // Every one of these is something an attacker would try FIRST, and each is
    // rejected before Firestore is touched at all.
    expect(isWellFormedToken('abc123XYZ4F2A9C')).toBe(false); // a document id
    expect(isWellFormedToken('4F2A9C')).toBe(false); // the printed reference
    expect(isWellFormedToken('')).toBe(false);
    expect(isWellFormedToken(null)).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken(12345)).toBe(false);
    expect(isWellFormedToken({})).toBe(false);
    expect(isWellFormedToken('a'.repeat(31))).toBe(false);
    expect(isWellFormedToken('a'.repeat(33))).toBe(false);
    expect(isWellFormedToken(`${'a'.repeat(31)}/`)).toBe(false);
    expect(isWellFormedToken(`${'a'.repeat(31)}+`)).toBe(false);
    expect(isWellFormedToken(`${'a'.repeat(31)}=`)).toBe(false);
  });
});

describe('printed reference number', () => {
  test('is derived from the id, inventing no schema field', () => {
    expect(referenceNumber('abc123XYZ4F2A9C')).toBe('4F2A9C');
  });

  test('is short and therefore deliberately NOT a credential', () => {
    // 6 chars is trivially enumerable, which is exactly why the token exists
    // and why isWellFormedToken rejects a reference outright.
    const ref = referenceNumber('abc123XYZ4F2A9C');
    expect(ref).toHaveLength(6);
    expect(isWellFormedToken(ref)).toBe(false);
  });

  test('tolerates a short or empty id', () => {
    expect(referenceNumber('ab')).toBe('AB');
    expect(referenceNumber('')).toBe('');
    expect(referenceNumber(null)).toBe('');
  });
});

// ─── Masking ──────────────────────────────────────────────────────────────────

describe('patient masking', () => {
  test('keeps the given name and initials the rest', () => {
    expect(maskPatientName('Ahmed Hassan Ali')).toBe('Ahmed H. A.');
  });

  test('masks Arabic names the same way', () => {
    expect(maskPatientName('أحمد حسن علي')).toBe('أحمد ح. ع.');
  });

  test('leaves a single-part name intact', () => {
    // Nothing to mask, and blanking it would defeat the one check this page
    // exists for — matching the person holding the sheet.
    expect(maskPatientName('Ahmed')).toBe('Ahmed');
  });

  test('collapses stray whitespace rather than emitting empty initials', () => {
    expect(maskPatientName('  Ahmed   Hassan  ')).toBe('Ahmed H.');
  });

  test('is empty for an empty name', () => {
    expect(maskPatientName('')).toBe('');
    expect(maskPatientName(null)).toBe('');
  });

  test('phone keeps only the last four digits', () => {
    expect(maskPhone('+9647701234567')).toBe('••••4567');
  });

  test('phone is null when there is too little to mask', () => {
    expect(maskPhone('12')).toBeNull();
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
  });
});

// ─── Age advisory, never expiry ───────────────────────────────────────────────

describe('age advisory', () => {
  test('counts whole days since issue', () => {
    expect(ageInDays(NOW - 3 * DAY, NOW)).toBe(3);
    expect(ageInDays(NOW - 1, NOW)).toBe(0);
  });

  test('never reports a negative age from clock skew', () => {
    expect(ageInDays(NOW + 5 * DAY, NOW)).toBe(0);
  });

  test('is null when a prescription somehow has no issue time', () => {
    expect(ageInDays(null, NOW)).toBeNull();
  });

  test('a recent prescription raises no advisory', () => {
    expect(project().ageAdvisory).toBe(false);
  });

  test('an old prescription raises an advisory but stays issued', () => {
    // The critical distinction: age changes the ADVICE, never the STATUS.
    // TrustyDr has not implemented verified jurisdiction rules, so it must not
    // decide that an old prescription is invalid.
    const old = project({ issuedAt: ts(NOW - 200 * DAY) });
    expect(old.ageAdvisory).toBe(true);
    expect(old.ageDays).toBe(200);
    expect(old.status).toBe('issued');
  });

  test('the advisory threshold is published so the page can explain it', () => {
    expect(project().advisoryAfterDays).toBe(ADVISORY_AGE_DAYS);
  });

  test('nothing in the projection can render as "expired"', () => {
    const serialized = JSON.stringify(project({ issuedAt: ts(NOW - 900 * DAY) }));
    expect(serialized.toLowerCase()).not.toContain('expire');
    expect(serialized.toLowerCase()).not.toContain('invalid');
  });
});

// ─── What the public may see ──────────────────────────────────────────────────

describe('public projection', () => {
  test('carries what a pharmacist needs to match the sheet', () => {
    const p = project();
    expect(p.referenceNumber).toBe('4F2A9C');
    expect(p.doctorName).toBe('Zainab Karim');
    expect(p.doctorLicenseNumber).toBe('LIC-4471');
    expect(p.centerName).toBe('Al Noor Eye Centre');
    expect(p.centerPhone).toBe('+9647800000000');
    expect(p.patientNameMasked).toBe('Ahmed H. A.');
    expect(p.items).toHaveLength(1);
    expect(p.items[0].displayName)
      .toBe('Moxifloxacin 0.5% Ophthalmic Solution');
  });

  test('carries the full professional practice identity', () => {
    // The pharmacist compares the paper against this page, so the practice
    // block has to be complete enough to actually compare: name, location and
    // a number they can ring.
    const p = project();
    expect(p.centerName).toBe('Al Noor Eye Centre');
    expect(p.centerAddress).toBe('Karrada, Baghdad');
    expect(p.centerPhone).toBe('+9647800000000');
  });

  test('carries the prescriber credential a pharmacist checks', () => {
    const p = project();
    expect(p.doctorName).toBe('Zainab Karim');
    expect(p.doctorSpecialty).toBe('Ophthalmology');
    expect(p.doctorLicenseNumber).toBe('LIC-4471');
  });

  test('omits professional fields the centre never recorded', () => {
    // Absent means absent. No placeholder, no empty string that would render as
    // a dangling label on the page.
    const p = buildVerificationProjection({
      prescriptionId: 'abc123XYZ4F2A9C',
      prescription: {
        status: 'issued',
        doctorName: 'Zainab Karim',
        patientName: 'Ahmed Hassan',
        items: [],
      },
      nowMs: NOW,
    });
    expect(p.centerAddress).toBeNull();
    expect(p.centerPhone).toBeNull();
    expect(p.doctorLicenseNumber).toBeNull();
    expect(p.doctorSpecialty).toBeNull();
    // And the fields that DO exist still come through.
    expect(p.doctorName).toBe('Zainab Karim');
    expect(p.referenceNumber).toBe('4F2A9C');
  });

  test('NEVER carries the diagnosis', () => {
    expect(JSON.stringify(project()))
      .not.toContain('SECRET-DIAGNOSIS-MARKER');
    expect(project().diagnosisNote).toBeUndefined();
  });

  test('NEVER carries the verification token back out', () => {
    // The page is reached by holding the token; echoing it would let a screen
    // photo of the result become a working credential of its own.
    const p = project();
    expect(p.verificationToken).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(prescription().verificationToken);
  });

  test('NEVER carries internal identifiers', () => {
    const p = project();
    for (const key of ['patientId', 'doctorId', 'centerId', 'appointmentId',
      'createdByUid', 'printCount']) {
      expect(p[key]).toBeUndefined();
    }
  });

  test('carries the unmasked patient name nowhere', () => {
    expect(JSON.stringify(project())).not.toContain('Ahmed Hassan Ali');
    expect(JSON.stringify(project())).not.toContain('+9647701234567');
  });

  test('reports supersession as a fact, not as a pointer', () => {
    // The holder of THIS token has no claim on another prescription's contents.
    const p = project({ status: 'superseded', supersededBy: 'other_rx_id' });
    expect(p.hasBeenSuperseded).toBe(true);
    expect(p.status).toBe('superseded');
    expect(JSON.stringify(p)).not.toContain('other_rx_id');
  });

  test('a cancelled prescription still verifies, and says so', () => {
    // Refusing to resolve would leave a pharmacist unable to tell a cancelled
    // prescription from a forged one — the worst possible outcome.
    const p = project({
      status: 'cancelled',
      cancelledAt: ts(NOW - DAY),
      cancelReason: 'wrong dose',
    });
    expect(p.status).toBe('cancelled');
    expect(p.cancelledAtMs).toBe(NOW - DAY);
  });

  test('the cancellation REASON stays private', () => {
    // Clinical rationale, and none of the pharmacist's business — the status
    // alone is what changes their action.
    const p = project({ status: 'cancelled', cancelReason: 'PRIVATE-REASON' });
    expect(JSON.stringify(p)).not.toContain('PRIVATE-REASON');
  });
});

// ─── Medication lines ─────────────────────────────────────────────────────────

describe('medication lines', () => {
  test('carry language-neutral codes so the page renders in the READER language', () => {
    const item = project().items[0];
    expect(item.doseUnitCode).toBe('drop');
    expect(item.routeCode).toBe('affected_eye');
    expect(item.frequencyCode).toBe('qid');
    expect(item.durationValue).toBe(7);
  });

  test('carry no translated medication names (ADR-014)', () => {
    const item = project().items[0];
    expect(item.nameAr).toBeUndefined();
    expect(item.nameKu).toBeUndefined();
    expect(item.displayName).toBe('Moxifloxacin 0.5% Ophthalmic Solution');
  });

  test('carry what the prescriber actually approved', () => {
    expect(project().items[0].directionsAuthored)
      .toEqual({ text: 'ONE DROP...', locale: 'en' });
  });

  test('preserve issue order', () => {
    const p = project({
      items: [
        { ...MOXI_ITEM, sortOrder: 1 },
        { ...MOXI_ITEM, displayName: 'Amoxicillin 500 mg Capsule', sortOrder: 0 },
      ],
    });
    expect(p.items.map((i) => i.displayName)).toEqual([
      'Amoxicillin 500 mg Capsule',
      'Moxifloxacin 0.5% Ophthalmic Solution',
    ]);
  });

  test('drop a nameless line rather than rendering a blank row', () => {
    expect(projectVerificationItem({ displayName: '' })).toBeNull();
    expect(projectVerificationItem(null)).toBeNull();
    expect(project({ items: [{ strength: '5' }] }).items).toEqual([]);
  });

  test('a prescription with no lines projects empty, not broken', () => {
    expect(project({ items: [] }).items).toEqual([]);
    expect(project({ items: undefined }).items).toEqual([]);
  });
});

// ─── Electronic dispensing ────────────────────────────────────────────────────

describe('dispensing status', () => {
  test('is null when the prescription never went to a TrustyDr pharmacy', () => {
    // Absence means "TrustyDr does not know", never "not dispensed" — which is
    // exactly why the printed sheet also carries a manual PHARMACY USE block.
    expect(summarizeDispensing([])).toBeNull();
    expect(summarizeDispensing(null)).toBeNull();
    expect(project().dispensing).toBeNull();
  });

  test('reports the furthest-along state across every pharmacy sent to', () => {
    const d = summarizeDispensing([
      { partnerStatus: 'sent', partnerName_en: 'Pharmacy A' },
      { partnerStatus: 'dispensed', partnerName_en: 'Pharmacy B',
        updatedAt: ts(NOW - DAY) },
      { partnerStatus: 'received', partnerName_en: 'Pharmacy C' },
    ]);
    expect(d.status).toBe('dispensed');
    expect(d.pharmacyName).toBe('Pharmacy B');
    expect(d.isDispensed).toBe(true);
    expect(d.pharmacyCount).toBe(3);
  });

  test('names the pharmacy that acted, which is the point of showing it', () => {
    const d = summarizeDispensing([
      { partnerStatus: 'preparing', partnerName_en: 'Al Noor Pharmacy' },
    ]);
    expect(d.pharmacyName).toBe('Al Noor Pharmacy');
    expect(d.isDispensed).toBe(false);
  });

  test('an unrecognised status does not masquerade as dispensed', () => {
    const d = summarizeDispensing([{ partnerStatus: 'weird_new_state' }]);
    expect(d.isDispensed).toBe(false);
  });

  test('reaches the projection when requests exist', () => {
    const p = project({}, {
      clinicalRequests: [
        { partnerStatus: 'dispensed', partnerName_en: 'Pharmacy B' },
      ],
    });
    expect(p.dispensing.isDispensed).toBe(true);
  });
});

// ─── The boundary ─────────────────────────────────────────────────────────────

describe('scope boundary', () => {
  test('the projection asserts no clinical or legal verdict', () => {
    // TrustyDr confirms a document matches a record it issued. It does not
    // certify appropriateness and does not decide whether dispensing is
    // permitted, so no field here may carry such a claim.
    const p = project();
    for (const key of ['isValid', 'isLegal', 'approved', 'certified',
      'eligible', 'canDispense', 'expiresAtMs']) {
      expect(p[key]).toBeUndefined();
    }
  });

  test('the verification module exposes no write path', () => {
    const mod = require('../functions/prescriptions/verifyPrescription');
    expect(Object.keys(mod).sort())
      .toEqual(['ensurePrescriptionVerification', 'verifyPrescription']);
  });

  test('the projection module is pure — it exports no Firestore writer', () => {
    const mod = require('../functions/prescriptions/verificationProjection');
    for (const [, value] of Object.entries(mod)) {
      expect(typeof value === 'function' || typeof value === 'number' ||
        Array.isArray(value)).toBe(true);
    }
  });
});
