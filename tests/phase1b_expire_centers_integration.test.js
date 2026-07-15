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
