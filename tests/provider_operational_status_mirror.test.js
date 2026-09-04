'use strict';

// The operational-status projection, tested without Firestore.
//
// WHICH fields cross the boundary IS the security property here — the mirror
// exists precisely so that pharmacy/lab staff can resolve their employer's
// operational state without being handed the owner's identity documents. So
// the projection is a pure function and is asserted directly, the same
// discipline SubscriptionAccessRules.sourceFor uses on the client side.

const {
  MIRRORED_FIELDS,
  buildOperationalStatus,
  operationalStatusChanged,
} = require('../functions/lib/operationalStatusMirror');

// A realistic parent document: the five subscription fields the access gate
// needs, surrounded by everything it must never carry across.
const PARENT = {
  status: 'active',
  subscriptionStatus: 'active',
  trialEnds: null,
  subscriptionEnd: { toMillis: () => 1800000000000, isEqual(o) { return o && o.toMillis && o.toMillis() === this.toMillis(); } },
  gracePeriodEnds: null,

  // Owner identity + onboarding — the reason the parent stays owner-only.
  nationalIdNumber: '19900101234',
  idFrontUrl: 'https://example.test/id-front.jpg',
  idBackUrl: 'https://example.test/id-back.jpg',
  licenseDocUrl: 'https://example.test/licence.pdf',
  phone: '+9647700000001',
  email: 'owner@pharmacy.test',
  contactName_en: 'Owner Name',
  facilityName_en: 'Test Pharmacy',
  facilityAddress: 'Somewhere',
  province_en: 'Baghdad',
  city_en: 'Baghdad',
  userId: 'uid_pharm_owner',
  claimedByUserId: 'uid_pharm_owner',
  onboardingStep: 5,
  verificationStatus: 'approved',
  isVerified: true,
  legalAcceptances: { pharmacy_agreement: { accepted: true } },
  currentPlan: 'standard',
  billingCycle: 'yearly',
  lastPaymentAt: 'X',
  lastPaymentAmountIQD: 250000,
  nextBillingDate: 'X',
  subscriptionStart: 'X',
  trialStart: 'X',
};

describe('buildOperationalStatus — projection shape', () => {
  test('M-1 exposes EXACTLY the five access fields, and nothing else', () => {
    const out = buildOperationalStatus(PARENT);
    expect(Object.keys(out).sort()).toEqual([
      'gracePeriodEnds',
      'status',
      'subscriptionEnd',
      'subscriptionStatus',
      'trialEnds',
    ]);
  });

  test('M-2 carries no owner identity, document, contact or billing-detail field', () => {
    // Named individually rather than by diff, so adding one to MIRRORED_FIELDS
    // fails HERE with the field name rather than somewhere downstream.
    const forbidden = [
      'nationalIdNumber', 'idFrontUrl', 'idBackUrl', 'licenseDocUrl',
      'phone', 'email', 'contactName_en', 'facilityName_en', 'facilityAddress',
      'province_en', 'city_en', 'userId', 'claimedByUserId', 'onboardingStep',
      'verificationStatus', 'isVerified', 'legalAcceptances',
      'currentPlan', 'billingCycle', 'lastPaymentAt', 'lastPaymentAmountIQD',
      'nextBillingDate', 'subscriptionStart', 'trialStart',
    ];
    const out = buildOperationalStatus(PARENT);
    for (const field of forbidden) {
      expect(out).not.toHaveProperty(field);
    }
  });

  test('M-3 the field list itself is exactly the documented five', () => {
    expect(MIRRORED_FIELDS).toEqual([
      'status', 'subscriptionStatus', 'trialEnds', 'subscriptionEnd', 'gracePeriodEnds',
    ]);
  });

  test('M-4 preserves the values the access rule reads', () => {
    const out = buildOperationalStatus(PARENT);
    expect(out.status).toBe('active');
    expect(out.subscriptionStatus).toBe('active');
    expect(out.subscriptionEnd).toBe(PARENT.subscriptionEnd);
  });

  test('M-5 writes explicit nulls for absent fields', () => {
    // A value CLEARED on the parent must be cleared on the mirror, not left
    // lingering there keeping a lapsed organization operational.
    const out = buildOperationalStatus({ status: 'active' });
    expect(out.subscriptionEnd).toBeNull();
    expect(out.trialEnds).toBeNull();
    expect(out.gracePeriodEnds).toBeNull();
    expect(out.subscriptionStatus).toBeNull();
  });

  test('M-6 a missing/empty parent projects all nulls, never throws', () => {
    expect(buildOperationalStatus(undefined).status).toBeNull();
    expect(buildOperationalStatus(null).subscriptionEnd).toBeNull();
    expect(buildOperationalStatus({}).gracePeriodEnds).toBeNull();
  });
});

describe('operationalStatusChanged — write suppression', () => {
  const ts = (ms) => ({
    toMillis: () => ms,
    isEqual(o) { return !!o && typeof o.toMillis === 'function' && o.toMillis() === ms; },
  });

  test('M-7 a profile-only edit does NOT trigger a mirror write', () => {
    // The trigger fires on every parent write — renames, document uploads,
    // opening-hours edits. Writing the mirror anyway would double the write
    // cost of every provider profile save.
    const before = { status: 'active', subscriptionEnd: ts(1), facilityName_en: 'Old' };
    const after = { status: 'active', subscriptionEnd: ts(1), facilityName_en: 'New' };
    expect(operationalStatusChanged(before, after)).toBe(false);
  });

  test('M-8 a subscription renewal DOES trigger a mirror write', () => {
    const before = { status: 'active', subscriptionEnd: ts(1) };
    const after = { status: 'active', subscriptionEnd: ts(2) };
    expect(operationalStatusChanged(before, after)).toBe(true);
  });

  test('M-9 an administrative suspension DOES trigger a mirror write', () => {
    expect(operationalStatusChanged({ status: 'active' }, { status: 'suspended' })).toBe(true);
  });

  test('M-10 clearing a date DOES trigger a mirror write', () => {
    expect(operationalStatusChanged({ trialEnds: ts(1) }, {})).toBe(true);
  });

  test('M-11 identical documents do not trigger a write', () => {
    expect(operationalStatusChanged(PARENT, PARENT)).toBe(false);
  });
});
