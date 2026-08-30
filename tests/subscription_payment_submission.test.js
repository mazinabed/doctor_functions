'use strict';

/**
 * Subscription renewal submission — the payments write path for all three org
 * shapes, plus the billing-field boundary on the org documents themselves.
 *
 * ── The reported blocker ────────────────────────────────────────────────────
 *
 * An expired lab clicking Subscribe got permission-denied. The open payment doc
 * (`open_lab_{uid}`) already exists from the previous cycle with
 * status 'completed', so `.set(merge:true)` evaluates as an UPDATE, and the
 * renewal branch of match /payments/{paymentId} read:
 *
 *     request.resource.data.centerId == resource.data.centerId
 *
 * Lab payment docs carry `labId`, pharmacy docs carry `pharmacyId`, and neither
 * carries `centerId` at all. Dereferencing that missing field errors, so the
 * branch could never pass for a provider — while the identical center flow,
 * which does write centerId, worked fine. A provider's FIRST subscription also
 * worked, because with no prior doc the write hits `allow create` instead.
 * That is why this survived until a renewal.
 *
 * ── The second defect these tests pin ───────────────────────────────────────
 *
 * Operational access is derived from the DATES on the org document. The
 * provider self-update rules blocked `subscriptionStatus` but not
 * `subscriptionEnd`, and the center rules blocked `subscriptionEnd` but not
 * `gracePeriodEnds` — so an owner could write a future date to their own
 * document and unlock unlimited operation with no payment ever approved.
 */

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
afterAll(async () => { await testEnv.cleanup(); });

const LAB = 'uid_lab_sub';
const PHARM = 'uid_pharm_sub';
const CENTER_OWNER = 'uid_center_owner_sub';
const CENTER = 'center_sub';
const OUTSIDER = 'uid_outsider_sub';

const PAST = new Date(Date.now() - 30 * 24 * 3600 * 1000);
const FUTURE = new Date(Date.now() + 365 * 24 * 3600 * 1000);

/** The exact doc LabBillingPage writes, minus status. */
function labPayload(overrides = {}) {
  const now = new Date();
  return {
    payerType: 'lab',
    payerId: `lab_${LAB}`,
    labId: LAB,
    uid: LAB,
    userId: LAB,
    payerUid: LAB,
    payerName: 'Test Lab',
    payerPhone: '07700000000',
    planTier: 'lab',
    billingCycle: '6_months',
    amountIQD: 125000,
    currency: 'IQD',
    provider: 'zaincash_manual',
    status: 'awaiting_transfer',
    proof: null,
    createdAt: now,
    updatedAt: now,
    paymentCode: '1234',
    ...overrides,
  };
}

function pharmacyPayload(overrides = {}) {
  const now = new Date();
  return {
    payerType: 'pharmacy',
    payerId: `pharmacy_${PHARM}`,
    pharmacyId: PHARM,
    uid: PHARM,
    userId: PHARM,
    payerUid: PHARM,
    payerName: 'Test Pharmacy',
    payerPhone: '07700000001',
    planTier: 'pharmacy',
    billingCycle: '6_months',
    amountIQD: 125000,
    currency: 'IQD',
    provider: 'zaincash_manual',
    status: 'awaiting_transfer',
    proof: null,
    createdAt: now,
    updatedAt: now,
    paymentCode: '5678',
    ...overrides,
  };
}

function centerPayload(overrides = {}) {
  const now = new Date();
  return {
    payerType: 'center',
    payerId: `center_${CENTER}`,
    centerId: CENTER,
    uid: CENTER_OWNER,
    userId: CENTER_OWNER,
    planTier: 'center',
    billingCycle: '6_months',
    amountIQD: 200000,
    currency: 'IQD',
    provider: 'zaincash_manual',
    status: 'awaiting_transfer',
    proof: null,
    createdAt: now,
    updatedAt: now,
    paymentCode: '9012',
    ...overrides,
  };
}

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedDatabase(testEnv);

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    // Three EXPIRED organizations — the state the user is actually in.
    await setDoc(doc(db, 'users', LAB), { role: 'diagnostic_provider' });
    await setDoc(doc(db, 'diagnostic_providers', LAB), {
      userId: LAB,
      status: 'active',
      subscriptionStatus: 'active',
      subscriptionEnd: PAST,
    });

    await setDoc(doc(db, 'users', PHARM), { role: 'pharmacy_provider' });
    await setDoc(doc(db, 'pharmacy_providers', PHARM), {
      userId: PHARM,
      status: 'active',
      subscriptionStatus: 'active',
      subscriptionEnd: PAST,
    });

    await setDoc(doc(db, 'users', CENTER_OWNER), { role: 'doctor' });
    await setDoc(doc(db, 'doctors', CENTER_OWNER), { name_en: 'Dr Owner' });
    await setDoc(doc(db, 'medical_centers', CENTER), {
      ownerId: CENTER_OWNER,
      isActive: true,
      subscriptionStatus: 'active',
      subscriptionEnd: PAST,
    });

    await setDoc(doc(db, 'users', OUTSIDER), { role: 'doctor' });

    // The completed payment docs left behind by the previous cycle.
    await setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ status: 'completed' }));
    await setDoc(doc(db, 'payments', `open_pharmacy_${PHARM}`),
      pharmacyPayload({ status: 'completed' }));
    await setDoc(doc(db, 'payments', `open_center_${CENTER}`),
      centerPayload({ status: 'completed' }));
  });
});

// ── 1. The reported blocker, all three shapes ──────────────────────────────

describe('an expired organization can submit a renewal request', () => {
  test('expired LAB can re-initiate its open payment', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertSucceeds(setDoc(
      doc(db, 'payments', `open_lab_${LAB}`), labPayload(), { merge: true }));
  });

  test('expired PHARMACY can re-initiate its open payment', async () => {
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertSucceeds(setDoc(
      doc(db, 'payments', `open_pharmacy_${PHARM}`), pharmacyPayload(), { merge: true }));
  });

  test('expired MEDICAL CENTER can still re-initiate — unregressed', async () => {
    const db = testEnv.authenticatedContext(CENTER_OWNER).firestore();
    await assertSucceeds(setDoc(
      doc(db, 'payments', `open_center_${CENTER}`), centerPayload(), { merge: true }));
  });

  test('the REAL center payload — which omits userId entirely — still works', async () => {
    // billing.dart writes payerType/payerId/uid/centerId and no userId at all.
    // The payer check reads userId through a .get() default for exactly this
    // shape; uid still pins the caller.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const payload = centerPayload({ status: 'completed' });
      delete payload.userId;
      await setDoc(doc(ctx.firestore(), 'payments', `open_center_${CENTER}`), payload);
    });
    const db = testEnv.authenticatedContext(CENTER_OWNER).firestore();
    const payload = centerPayload();
    delete payload.userId;
    await assertSucceeds(setDoc(
      doc(db, 'payments', `open_center_${CENTER}`), payload, { merge: true }));
  });

  test('a doc carrying someone else userId is still rejected', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', `open_center_${CENTER}`),
        centerPayload({ status: 'completed' }));
    });
    const db = testEnv.authenticatedContext(CENTER_OWNER).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_center_${CENTER}`),
      centerPayload({ userId: OUTSIDER }), { merge: true }));
  });

  test('a rejected payment can be resubmitted by a lab', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', `open_lab_${LAB}`),
        labPayload({ status: 'rejected', rejectedBy: 'uid_admin' }));
    });
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertSucceeds(setDoc(
      doc(db, 'payments', `open_lab_${LAB}`), labPayload(), { merge: true }));
  });
});

// ── 2. Step 2 of the flow: submitted -> pending approval ───────────────────

describe('submitting marks the request for review, and nothing more', () => {
  async function setAwaitingTransfer(id, payload) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', id),
        payload({ status: 'awaiting_transfer' }));
    });
  }

  test('lab can confirm transfer: awaiting_transfer -> under_review', async () => {
    await setAwaitingTransfer(`open_lab_${LAB}`, labPayload);
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertSucceeds(updateDoc(doc(db, 'payments', `open_lab_${LAB}`), {
      status: 'under_review', submittedAt: new Date(), updatedAt: new Date(),
    }));
  });

  test('pharmacy can confirm transfer the same way', async () => {
    await setAwaitingTransfer(`open_pharmacy_${PHARM}`, pharmacyPayload);
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertSucceeds(updateDoc(doc(db, 'payments', `open_pharmacy_${PHARM}`), {
      status: 'under_review', submittedAt: new Date(), updatedAt: new Date(),
    }));
  });

  test('lab may record its pending plan on its own provider doc', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertSucceeds(setDoc(doc(db, 'diagnostic_providers', LAB), {
      pendingPlan: 'lab', pendingBillingCycle: '6_months', updatedAt: new Date(),
    }, { merge: true }));
  });
});

// ── 3. Cross-organization isolation ────────────────────────────────────────

describe('nobody can submit for an organization that is not theirs', () => {
  test('an outsider cannot re-initiate the lab payment', async () => {
    const db = testEnv.authenticatedContext(OUTSIDER).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload(), { merge: true }));
  });

  test('a pharmacy cannot re-initiate the lab payment', async () => {
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload(), { merge: true }));
  });

  test('a lab cannot retarget its own payment doc at another org', async () => {
    // The doc is the caller's, but the org key must be immutable — otherwise a
    // renewal could be booked against someone else's subscription.
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ labId: 'some_other_lab' }), { merge: true }));
  });

  test('a lab cannot bolt a centerId onto its payment doc', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ centerId: CENTER }), { merge: true }));
  });

  test('a lab cannot reassign the payment uid to another user', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ uid: OUTSIDER }), { merge: true }));
  });

  test('an outsider cannot read another org payment', async () => {
    const db = testEnv.authenticatedContext(OUTSIDER).firestore();
    const { getDoc } = require('firebase/firestore');
    await assertFails(getDoc(doc(db, 'payments', `open_lab_${LAB}`)));
  });
});

// ── 4. Admin approval remains the only activation authority ────────────────

describe('a payer can request, never approve', () => {
  test('a lab cannot set its payment to completed', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ status: 'completed' }), { merge: true }));
  });

  test('a lab cannot write approval fields while renewing', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ approvedBy: LAB, approvedAt: new Date() }), { merge: true }));
  });

  test('a lab cannot self-activate via activatedAt', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload({ activatedAt: new Date() }), { merge: true }));
  });

  test('a pharmacy cannot mark its own payment completed', async () => {
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertFails(setDoc(doc(db, 'payments', `open_pharmacy_${PHARM}`),
      pharmacyPayload({ status: 'completed' }), { merge: true }));
  });

  test('an admin CAN approve, so the lifecycle still completes', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'payments', `open_lab_${LAB}`),
        labPayload({ status: 'under_review' }));
    });
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(updateDoc(doc(db, 'payments', `open_lab_${LAB}`), {
      status: 'completed', approvedAt: new Date(),
      approvedBy: 'uid_admin', activatedAt: new Date(),
    }));
  });
});

// ── 5. The org document's billing fields are admin-only ────────────────────

describe('an owner cannot self-grant operational access', () => {
  // Access is derived from these dates. Writing one is equivalent to
  // approving your own payment.
  test('lab cannot self-write subscriptionEnd', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(updateDoc(doc(db, 'diagnostic_providers', LAB),
      { subscriptionEnd: FUTURE }));
  });

  test('lab cannot self-write gracePeriodEnds', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(updateDoc(doc(db, 'diagnostic_providers', LAB),
      { gracePeriodEnds: FUTURE }));
  });

  test('pharmacy cannot self-write subscriptionEnd', async () => {
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertFails(updateDoc(doc(db, 'pharmacy_providers', PHARM),
      { subscriptionEnd: FUTURE }));
  });

  test('pharmacy cannot self-write gracePeriodEnds', async () => {
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertFails(updateDoc(doc(db, 'pharmacy_providers', PHARM),
      { gracePeriodEnds: FUTURE }));
  });

  test('center owner cannot self-write gracePeriodEnds', async () => {
    const db = testEnv.authenticatedContext(CENTER_OWNER).firestore();
    await assertFails(updateDoc(doc(db, 'medical_centers', CENTER),
      { gracePeriodEnds: FUTURE }));
  });

  test('center owner still cannot self-write subscriptionEnd', async () => {
    const db = testEnv.authenticatedContext(CENTER_OWNER).firestore();
    await assertFails(updateDoc(doc(db, 'medical_centers', CENTER),
      { subscriptionEnd: FUTURE }));
  });

  test('lab cannot self-write currentPlan or nextBillingDate', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(updateDoc(doc(db, 'diagnostic_providers', LAB),
      { currentPlan: 'lab', nextBillingDate: FUTURE }));
  });

  test('lab cannot forge the scheduled job stamp', async () => {
    // statusSyncedAt is written only by expireCenters (admin SDK).
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(updateDoc(doc(db, 'diagnostic_providers', LAB),
      { statusSyncedAt: new Date() }));
  });

  test('ordinary provider profile edits still work', async () => {
    // The tightened blocklist must not have caught legitimate fields.
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertSucceeds(updateDoc(doc(db, 'diagnostic_providers', LAB),
      { facilityName_en: 'Renamed Lab', phone: '07709999999' }));
  });
});

// ── 6. Administrative suspension survives a payment ────────────────────────

describe('suspension cannot be bypassed by paying', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'diagnostic_providers', LAB), {
        userId: LAB, status: 'suspended',
        subscriptionStatus: 'active', subscriptionEnd: PAST,
      });
      await setDoc(doc(db, 'pharmacy_providers', PHARM), {
        userId: PHARM, status: 'rejected',
        subscriptionStatus: 'active', subscriptionEnd: PAST,
      });
    });
  });

  test('a suspended lab cannot clear its own status', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(updateDoc(doc(db, 'diagnostic_providers', LAB),
      { status: 'active' }));
  });

  test('a rejected pharmacy cannot clear its own status', async () => {
    const db = testEnv.authenticatedContext(PHARM).firestore();
    await assertFails(updateDoc(doc(db, 'pharmacy_providers', PHARM),
      { status: 'active' }));
  });

  test('a suspended lab cannot buy its way out via the pending-plan write', async () => {
    // The write it IS allowed to make must not carry a status change.
    const db = testEnv.authenticatedContext(LAB).firestore();
    await assertFails(setDoc(doc(db, 'diagnostic_providers', LAB), {
      pendingPlan: 'lab', status: 'active',
    }, { merge: true }));
  });

  test('a suspended lab submitting a payment leaves its status suspended', async () => {
    const db = testEnv.authenticatedContext(LAB).firestore();
    // Submitting the payment is permitted — it is a request for money to be
    // reviewed, and it touches the payments doc only.
    await assertSucceeds(setDoc(doc(db, 'payments', `open_lab_${LAB}`),
      labPayload(), { merge: true }));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { getDoc } = require('firebase/firestore');
      const snap = await getDoc(doc(ctx.firestore(), 'diagnostic_providers', LAB));
      // The administrative decision is untouched by the payment write.
      expect(snap.data().status).toBe('suspended');
    });
  });
});
