'use strict';

/**
 * Phase 1B — integration smoke test for the ACTUAL expireCenters scheduled
 * function (not just the pure deriveCommerceTargetStatus/deriveCommerceReminderStage
 * logic, already covered in phase2_expire_logic.test.js). Exercises the real
 * batch-merge wiring against the Firestore emulator via firebase-admin,
 * bypassing security rules entirely (Cloud Functions always use the Admin SDK).
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest phase1b_expire_centers_integration --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

// Reuses the functions/ workspace's own firebase-admin install (this test
// package.json is scoped to @firebase/rules-unit-testing / client SDK only)
// rather than adding a second, redundant admin-SDK dependency here.
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const { expireCenters } = require('../functions/expireCenters');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('medical_centers');
  await clearCollection('pharmacy_providers');
  await clearCollection('diagnostic_providers');
});

afterAll(async () => {
  await admin.app().delete();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (days) => admin.firestore.Timestamp.fromMillis(Date.now() + days * DAY_MS);

test('IB-1 Commerce trial expired, Healthcare untouched: writes commerceSubscriptionStatus only, never centerStatus/subscriptionStatus', async () => {
  await db.collection('medical_centers').doc('center_ib1').set({
    ownerId: 'uid_owner_ib1',
    centerStatus: 'operational',
    subscriptionStatus: 'active',
    trialEnds: addDays(60), // Healthcare still fully active
    commerceTrialEnds: addDays(-40),
    commerceGracePeriodEnds: addDays(-33), // grace also passed
    commerceSubscriptionStatus: 'trial',
  });

  await expireCenters.run({});

  const after = (await db.collection('medical_centers').doc('center_ib1').get()).data();
  expect(after.commerceSubscriptionStatus).toBe('expired');
  expect(after.commerceSubscriptionStatusSyncedAt).toBeTruthy();
  // Healthcare fields must be completely untouched.
  expect(after.centerStatus).toBe('operational');
  expect(after.subscriptionStatus).toBe('active');
});

test('IB-2 Healthcare expired, Commerce still in trial: writes centerStatus/subscriptionStatus only, Commerce untouched', async () => {
  await db.collection('medical_centers').doc('center_ib2').set({
    ownerId: 'uid_owner_ib2',
    centerStatus: 'operational',
    subscriptionStatus: 'active',
    trialEnds: addDays(-40),
    gracePeriodEnds: addDays(-33), // Healthcare grace also passed → expired/locked
    commerceTrialEnds: addDays(20), // Commerce still well within trial
    commerceSubscriptionStatus: 'trial',
  });

  await expireCenters.run({});

  const after = (await db.collection('medical_centers').doc('center_ib2').get()).data();
  expect(after.centerStatus).toBe('locked');
  expect(after.subscriptionStatus).toBe('expired');
  expect(after.commerceSubscriptionStatus).toBe('trial'); // untouched
  expect(after.commerceSubscriptionStatusSyncedAt).toBeUndefined();
});

test('IB-3 a center already locked for Healthcare still gets its Commerce trial expired (second pass)', async () => {
  await db.collection('medical_centers').doc('center_ib3').set({
    ownerId: 'uid_owner_ib3',
    centerStatus: 'locked', // excluded from the main query entirely
    subscriptionStatus: 'expired',
    trialEnds: addDays(-90),
    gracePeriodEnds: addDays(-80),
    commerceTrialEnds: addDays(-40),
    commerceGracePeriodEnds: addDays(-33),
    commerceSubscriptionStatus: 'trial',
  });

  await expireCenters.run({});

  const after = (await db.collection('medical_centers').doc('center_ib3').get()).data();
  expect(after.commerceSubscriptionStatus).toBe('expired');
  expect(after.centerStatus).toBe('locked'); // still locked, unrelated
});

test('IB-4 migration-grandfathered pharmacy (no Commerce dates) is left completely untouched', async () => {
  await db.collection('medical_centers').doc('center_ib4').set({
    ownerId: 'uid_owner_ib4',
    centerStatus: 'operational',
    subscriptionStatus: 'active',
    trialEnds: addDays(60),
    commerceSubscriptionStatus: 'active',
    commercePlanId: 'starter',
    commerceTrialCompleted: true,
    // Deliberately no commerceTrialEnds/commerceSubscriptionEnd/commerceGracePeriodEnds.
  });

  await expireCenters.run({});

  const after = (await db.collection('medical_centers').doc('center_ib4').get()).data();
  expect(after.commerceSubscriptionStatus).toBe('active'); // unchanged
  expect(after.commerceSubscriptionStatusSyncedAt).toBeUndefined();
});

test('IB-5 reminder stage fires exactly once: writes a notification doc and commerceLastReminderStage, then does not re-fire on a second run', async () => {
  await db.collection('medical_centers').doc('center_ib5').set({
    ownerId: 'uid_owner_ib5',
    centerStatus: 'operational',
    subscriptionStatus: 'active',
    trialEnds: addDays(60),
    commerceTrialEnds: addDays(7), // exactly the 7d reminder trigger
    commerceSubscriptionStatus: 'trial',
  });

  await expireCenters.run({});

  const afterFirst = (await db.collection('medical_centers').doc('center_ib5').get()).data();
  expect(afterFirst.commerceLastReminderStage).toBe('7d');

  const notifSnap = await db
    .collection('users')
    .doc('uid_owner_ib5')
    .collection('notifications')
    .doc('commerce_reminder_center_ib5_7d')
    .get();
  expect(notifSnap.exists).toBe(true);
  expect(notifSnap.data().type).toBe('commerce_billing_reminder');
  expect(notifSnap.data().stage).toBe('7d');

  // Re-running the SAME day must not re-send or error.
  await expireCenters.run({});
  const afterSecond = (await db.collection('medical_centers').doc('center_ib5').get()).data();
  expect(afterSecond.commerceLastReminderStage).toBe('7d');
});

/**
 * Provider expiry passes — the actual batch wiring for pharmacy_providers and
 * diagnostic_providers, not just the pure derivation.
 *
 * These exist because the failure they cover was entirely a wiring failure: the
 * derivation for a lapsed subscription was always correct, the job simply never
 * looked at these two collections.
 */

test('IB-6 an expired diagnostic provider is expired, and its account status survives', async () => {
  await db.collection('diagnostic_providers').doc('lab_ib6').set({
    ownerId: 'uid_owner_ib6',
    status: 'active',
    subscriptionStatus: 'active',
    subscriptionStart: addDays(-70),
    subscriptionEnd: addDays(-40),
  });

  await expireCenters.run({});

  const after = (await db.collection('diagnostic_providers').doc('lab_ib6').get()).data();
  expect(after.subscriptionStatus).toBe('expired');
  expect(after.statusSyncedAt).toBeTruthy();
  // The administrative account status is a separate decision — untouched.
  expect(after.status).toBe('active');
  expect(after.centerStatus).toBeUndefined();
});

test('IB-7 an expired pharmacy provider is expired the same way', async () => {
  await db.collection('pharmacy_providers').doc('pharm_ib7').set({
    ownerId: 'uid_owner_ib7',
    status: 'active',
    subscriptionStatus: 'active',
    subscriptionEnd: addDays(-5),
  });

  await expireCenters.run({});

  const after = (await db.collection('pharmacy_providers').doc('pharm_ib7').get()).data();
  expect(after.subscriptionStatus).toBe('expired');
  expect(after.status).toBe('active');
});

test('IB-8 a provider with a future subscriptionEnd, or a valid grace window, is untouched', async () => {
  await db.collection('pharmacy_providers').doc('pharm_ib8_future').set({
    status: 'active',
    subscriptionStatus: 'active',
    subscriptionEnd: addDays(120),
  });
  await db.collection('diagnostic_providers').doc('lab_ib8_grace').set({
    status: 'active',
    subscriptionStatus: 'grace',
    subscriptionEnd: addDays(-10),
    gracePeriodEnds: addDays(4),
  });

  await expireCenters.run({});

  const future = (await db.collection('pharmacy_providers').doc('pharm_ib8_future').get()).data();
  expect(future.subscriptionStatus).toBe('active');
  expect(future.statusSyncedAt).toBeUndefined();

  const grace = (await db.collection('diagnostic_providers').doc('lab_ib8_grace').get()).data();
  expect(grace.subscriptionStatus).toBe('grace');
  expect(grace.statusSyncedAt).toBeUndefined();
});

test('IB-9 pending_activation and suspended/rejected accounts are never rewritten', async () => {
  await db.collection('diagnostic_providers').doc('lab_ib9_pending').set({
    status: 'active',
    subscriptionStatus: 'pending_activation',
    subscriptionEnd: addDays(-30), // lapsed, but a payment is awaiting approval
  });
  await db.collection('pharmacy_providers').doc('pharm_ib9_suspended').set({
    status: 'suspended',
    subscriptionStatus: 'active',
    subscriptionEnd: addDays(-30),
  });
  await db.collection('pharmacy_providers').doc('pharm_ib9_rejected').set({
    status: 'rejected',
    subscriptionStatus: 'active',
    subscriptionEnd: addDays(-30),
  });

  await expireCenters.run({});

  const pending = (await db.collection('diagnostic_providers').doc('lab_ib9_pending').get()).data();
  expect(pending.subscriptionStatus).toBe('pending_activation');
  expect(pending.statusSyncedAt).toBeUndefined();

  for (const id of ['pharm_ib9_suspended', 'pharm_ib9_rejected']) {
    const doc = (await db.collection('pharmacy_providers').doc(id).get()).data();
    expect(doc.subscriptionStatus).toBe('active'); // billing field untouched
    expect(doc.statusSyncedAt).toBeUndefined();
    expect(['suspended', 'rejected']).toContain(doc.status); // account state intact
  }
});

test('IB-10 a provider with no subscription dates at all is left completely untouched', async () => {
  await db.collection('pharmacy_providers').doc('pharm_ib10').set({
    status: 'active',
    subscriptionStatus: 'active',
    currentPlan: 'pharmacy',
    // Deliberately no trialEnds/subscriptionEnd/gracePeriodEnds — a
    // grandfathered record the job has nothing to reason from.
  });

  await expireCenters.run({});

  const after = (await db.collection('pharmacy_providers').doc('pharm_ib10').get()).data();
  expect(after.subscriptionStatus).toBe('active');
  expect(after.statusSyncedAt).toBeUndefined();
});

test('IB-11 the provider passes are idempotent, and never touch medical_centers', async () => {
  await db.collection('medical_centers').doc('center_ib11').set({
    ownerId: 'uid_owner_ib11',
    centerStatus: 'operational',
    subscriptionStatus: 'active',
    trialEnds: addDays(60),
  });
  await db.collection('diagnostic_providers').doc('lab_ib11').set({
    status: 'active',
    subscriptionStatus: 'active',
    subscriptionEnd: addDays(-20),
  });

  await expireCenters.run({});
  const first = (await db.collection('diagnostic_providers').doc('lab_ib11').get()).data();
  expect(first.subscriptionStatus).toBe('expired');
  const firstSync = first.statusSyncedAt.toMillis();

  // A second run must find nothing to do — no write, so the sync stamp is
  // identical rather than merely re-stamped.
  await expireCenters.run({});
  const second = (await db.collection('diagnostic_providers').doc('lab_ib11').get()).data();
  expect(second.subscriptionStatus).toBe('expired');
  expect(second.statusSyncedAt.toMillis()).toBe(firstSync);

  // The healthy center is unaffected by either provider pass.
  const center = (await db.collection('medical_centers').doc('center_ib11').get()).data();
  expect(center.centerStatus).toBe('operational');
  expect(center.subscriptionStatus).toBe('active');
});
