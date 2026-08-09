'use strict';

// Regression coverage for the shared Provider onboarding permission-denied
// (2026-08-09 audit). Reproduces the exact ORIGINAL failing state first
// (proving the bug exists on the unmodified precondition), then proves the
// new isV2LegalConsentTransition() exemption fixes it — narrowly, without
// weakening touchesDoctorAdminFields() for anything else.
//
// Scenario shape mirrors the real client write exactly:
//   doctors/{uid}.status: 'legalConsent' -> 'onboarding'
// via DoctorOnboardingController.saveStep() (doctor_onboarding_controller.dart),
// the first Firestore write the shared onboarding wizard performs for
// Doctor, Pharmacy, and Lab/Imaging alike (before serviceGroup is even
// chosen).

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
afterAll(async () => { await testEnv.cleanup(); });

async function seedFreshDraft(uid, { legalAcceptances, legalAccepted } = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'doctors', uid), {
      phone: '07701112222',
      phoneVerified: true,
      status: 'legalConsent',
      onboardingStep: 1,
      ...(legalAccepted !== undefined ? { legalAccepted } : {}),
    });
    await setDoc(doc(db, 'users', uid), {
      role: 'doctor',
      ...(legalAcceptances !== undefined ? { legalAcceptances } : {}),
    });
  });
}

const CURRENT_ACCEPTANCE = {
  providerTerms: { accepted: true, version: 'v2', acceptedAt: new Date() },
  privacy: { accepted: true, version: 'v2', acceptedAt: new Date() },
};

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('doctors/{uid} legalConsent -> onboarding — V2 lifecycle transition', () => {
  test(
    'FIX — reproduces the exact ORIGINAL production state (legalConsent ' +
      'status, CURRENT V2 providerTerms + privacy acceptance, no legacy ' +
      'legalAccepted field at all) and proves the legitimate first ' +
      'onboarding-wizard write now succeeds. Before this fix, this exact ' +
      'scenario was denied — see the audit report — because ' +
      'isLegalConsentTransition() required legalAccepted:true, which the ' +
      'live V2 flow never writes.',
    async () => {
      const uid = 'uid_fresh_provider_2';
      await seedFreshDraft(uid, { legalAcceptances: CURRENT_ACCEPTANCE });
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertSucceeds(
        updateDoc(doc(db, 'doctors', uid), {
          status: 'onboarding',
          updatedAt: new Date(),
          licenseDocUrl: 'https://example.com/license.jpg',
          idFrontUrl: 'https://example.com/id_front.jpg',
          idBackUrl: 'https://example.com/id_back.jpg',
          nationalIdNumber: '1234567890',
          onboardingStep: 5,
        })
      );
    }
  );

  test(
    'DENY: legalConsent -> onboarding is REJECTED when there is no V2 ' +
      'acceptance at all and no legacy legalAccepted — the true baseline ' +
      '(neither exemption applies)',
    async () => {
      const uid = 'uid_no_acceptance';
      await seedFreshDraft(uid);
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertFails(
        updateDoc(doc(db, 'doctors', uid), {
          status: 'onboarding',
          updatedAt: new Date(),
        })
      );
    }
  );

  test('DENY: providerTerms current but privacy NOT current — both are required', async () => {
    const uid = 'uid_partial_acceptance';
    await seedFreshDraft(uid, {
      legalAcceptances: {
        providerTerms: { accepted: true, version: 'v2', acceptedAt: new Date() },
        privacy: { accepted: true, version: 'v1', acceptedAt: new Date() },
      },
    });
    const db = testEnv.authenticatedContext(uid).firestore();

    await assertFails(
      updateDoc(doc(db, 'doctors', uid), { status: 'onboarding', updatedAt: new Date() })
    );
  });

  test('DENY: privacy current but providerTerms NOT current — both are required', async () => {
    const uid = 'uid_partial_acceptance_2';
    await seedFreshDraft(uid, {
      legalAcceptances: {
        providerTerms: { accepted: true, version: 'v1', acceptedAt: new Date() },
        privacy: { accepted: true, version: 'v2', acceptedAt: new Date() },
      },
    });
    const db = testEnv.authenticatedContext(uid).firestore();

    await assertFails(
      updateDoc(doc(db, 'doctors', uid), { status: 'onboarding', updatedAt: new Date() })
    );
  });

  test(
    'DENY: acceptance record exists but version is stale relative to a ' +
      'published platformConfig/legal bump (proves the rule reads the LIVE ' +
      'config, not a hardcoded version string)',
    async () => {
      const uid = 'uid_stale_after_bump';
      await seedFreshDraft(uid, { legalAcceptances: CURRENT_ACCEPTANCE });
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(context.firestore().doc('platformConfig/legal'), {
          patientTermsVersion: 'v2',
          providerTermsVersion: 'v3',
          privacyVersion: 'v2',
          medicalCenterAgreementVersion: 'v2',
          pharmacyAgreementVersion: 'v2',
          labAgreementVersion: 'v2',
        });
      });
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertFails(
        updateDoc(doc(db, 'doctors', uid), { status: 'onboarding', updatedAt: new Date() })
      );
    }
  );

  test(
    'ALLOW: acceptance version matches a published platformConfig/legal ' +
      'bump exactly (proves the rule follows a real version bump, not just ' +
      'the code-level default)',
    async () => {
      const uid = 'uid_current_after_bump';
      await seedFreshDraft(uid, {
        legalAcceptances: {
          providerTerms: { accepted: true, version: 'v3', acceptedAt: new Date() },
          privacy: { accepted: true, version: 'v2', acceptedAt: new Date() },
        },
      });
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(context.firestore().doc('platformConfig/legal'), {
          patientTermsVersion: 'v2',
          providerTermsVersion: 'v3',
          privacyVersion: 'v2',
          medicalCenterAgreementVersion: 'v2',
          pharmacyAgreementVersion: 'v2',
          labAgreementVersion: 'v2',
        });
      });
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertSucceeds(
        updateDoc(doc(db, 'doctors', uid), { status: 'onboarding', updatedAt: new Date() })
      );
    }
  );

  test(
    'LEGACY COMPATIBILITY: an in-flight v1 account (legalAccepted:true, no ' +
      'V2 acceptance at all) can still complete the SAME transition via the ' +
      'preserved, unmodified isLegalConsentTransition() exemption',
    async () => {
      const uid = 'uid_legacy_v1_inflight';
      await seedFreshDraft(uid, { legalAccepted: true });
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertSucceeds(
        updateDoc(doc(db, 'doctors', uid), {
          status: 'onboarding',
          legalAccepted: true,
          updatedAt: new Date(),
        })
      );
    }
  );
});

describe('doctors/{uid} legalConsent -> onboarding — V2 transition security boundary', () => {
  test.each([
    ['isActive', true],
    ['isVerified', true],
    ['canBook', true],
    ['canCall', true],
    ['verificationStatus', 'approved'],
    ['subscriptionStatus', 'active'],
    ['isPaidUser', true],
  ])(
    'DENY: current V2 acceptance does NOT authorize smuggling %s into the same write',
    async (field, value) => {
      const uid = `uid_smuggle_${field}`;
      await seedFreshDraft(uid, { legalAcceptances: CURRENT_ACCEPTANCE });
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertFails(
        updateDoc(doc(db, 'doctors', uid), {
          status: 'onboarding',
          updatedAt: new Date(),
          [field]: value,
        })
      );
    }
  );

  test(
    'REGRESSION GUARD: with current V2 acceptance, the legitimate status-only ' +
      'transition (no privileged fields) still succeeds — the security check ' +
      'above must not over-block the real write',
    async () => {
      const uid = 'uid_smuggle_control';
      await seedFreshDraft(uid, { legalAcceptances: CURRENT_ACCEPTANCE });
      const db = testEnv.authenticatedContext(uid).firestore();

      await assertSucceeds(
        updateDoc(doc(db, 'doctors', uid), { status: 'onboarding', updatedAt: new Date() })
      );
    }
  );

  test('DENY: admin-field self-escalation is still blocked when status is unchanged (baseline, unaffected by this fix)', async () => {
    const uid = 'uid_baseline_admin_block';
    await seedFreshDraft(uid, { legalAcceptances: CURRENT_ACCEPTANCE });
    const db = testEnv.authenticatedContext(uid).firestore();

    await assertFails(updateDoc(doc(db, 'doctors', uid), { isActive: true }));
  });
});
