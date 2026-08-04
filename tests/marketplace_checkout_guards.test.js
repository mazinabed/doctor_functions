'use strict';

/**
 * Focused test for placeMarketplaceOrder's GUARD 1 (Commerce billing
 * operational gate) — exercises the REAL resolveCommerceSubscriptionStatus/
 * isCommerceBillingOperational functions (functions/commerce/
 * marketplaceCheckout.js) against the Firestore emulator via firebase-admin,
 * not a duplicate re-implementation of the guard logic.
 *
 * Cross-store product ownership (GUARD 2) is enforced entirely on the
 * Commerce side (trustydr-commerce's isLineFromWrongStore) — its own
 * focused test lives there (functions/src/verifyCheckoutGuards.ts,
 * `npm run verify:checkout-guards`), not duplicated here since this repo
 * never resolves Odoo company ids itself.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest marketplace_checkout_guards --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  isCommerceBillingOperational,
  resolveCommerceSubscriptionStatus,
  pharmacyOwnerUidFromOrgId,
} = require('../functions/commerce/marketplaceCheckout');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('users');
  await clearCollection('medical_centers');
});

afterAll(async () => {
  await admin.app().delete();
});

describe('isCommerceBillingOperational', () => {
  test('trial/active/grace are operational', () => {
    expect(isCommerceBillingOperational('trial')).toBe(true);
    expect(isCommerceBillingOperational('active')).toBe(true);
    expect(isCommerceBillingOperational('grace')).toBe(true);
  });

  test('expired/null/undefined are NOT operational', () => {
    expect(isCommerceBillingOperational('expired')).toBe(false);
    expect(isCommerceBillingOperational(null)).toBe(false);
    expect(isCommerceBillingOperational(undefined)).toBe(false);
  });
});

describe('resolveCommerceSubscriptionStatus (real Firestore reads)', () => {
  test('resolves the live commerceSubscriptionStatus for a real, connected pharmacy', async () => {
    await db.collection('users').doc('uid_pharmacy_owner1').set({
      role: 'pharmacy_provider',
      centerId: 'center1',
    });
    await db.collection('medical_centers').doc('center1').set({
      commerceSubscriptionStatus: 'active',
    });

    const status = await resolveCommerceSubscriptionStatus(db, 'hc_pharmacy_uid_pharmacy_owner1');
    expect(status).toBe('active');
    expect(isCommerceBillingOperational(status)).toBe(true);
  });

  test('an expired store resolves to expired, and is rejected as not operational', async () => {
    await db.collection('users').doc('uid_pharmacy_owner2').set({
      role: 'pharmacy_provider',
      centerId: 'center2',
    });
    await db.collection('medical_centers').doc('center2').set({
      commerceSubscriptionStatus: 'expired',
    });

    const status = await resolveCommerceSubscriptionStatus(db, 'hc_pharmacy_uid_pharmacy_owner2');
    expect(status).toBe('expired');
    expect(isCommerceBillingOperational(status)).toBe(false);
  });

  test('an orgId with no matching user resolves to null (not operational)', async () => {
    const status = await resolveCommerceSubscriptionStatus(db, 'hc_pharmacy_does_not_exist');
    expect(status).toBeNull();
    expect(isCommerceBillingOperational(status)).toBe(false);
  });

  test('a pharmacy owner with no centerId (no facility yet) resolves to null', async () => {
    await db.collection('users').doc('uid_pharmacy_owner3').set({ role: 'pharmacy_provider' });

    const status = await resolveCommerceSubscriptionStatus(db, 'hc_pharmacy_uid_pharmacy_owner3');
    expect(status).toBeNull();
  });

  test('an orgId not matching the Healthcare-origin prefix resolves to null', async () => {
    const status = await resolveCommerceSubscriptionStatus(db, 'not_a_healthcare_org_id');
    expect(status).toBeNull();
  });
});

// Standalone Commerce orgId checkout bug fix (2026-08-04) — confirmed live:
// placeMarketplaceOrder/quoteMarketplaceCart's own GUARD 1 used to be
// `if (!isCommerceBillingOperational(commerceSubscriptionStatus))`, which
// always threw failed-precondition (HTTP 400) for ANY standalone orgId,
// since resolveCommerceSubscriptionStatus can only ever resolve a real
// status for an `hc_pharmacy_`-prefixed orgId — a fully operational
// standalone Demo Store got rejected here despite Commerce's own
// isOrgOperationalForCheckout (marketplaceCheckout.ts, the actual
// authoritative check for that org type) correctly considering it
// operational. Fixed by scoping GUARD 1 to
// `pharmacyOwnerUidFromOrgId(orgId) && !isCommerceBillingOperational(...)`.
// This suite has no emulator-backed way to invoke the full onCall handler
// (see this file's own header), so — matching this describe block's own
// established pattern of testing the real exported guard primitives
// directly rather than duplicating their logic — these verify the exact
// combined condition both GUARD 1 call sites now use.
describe('GUARD 1 combined condition (pharmacyOwnerUidFromOrgId(orgId) && !isCommerceBillingOperational(...))', () => {
  test('a standalone (non hc_pharmacy_) orgId never trips the guard, regardless of status', () => {
    const orgId = 'OIH67W4vZjLPV7SVa3bd';
    expect(pharmacyOwnerUidFromOrgId(orgId)).toBeNull();
    const guardFires = Boolean(pharmacyOwnerUidFromOrgId(orgId)) && !isCommerceBillingOperational(null);
    expect(guardFires).toBe(false);
  });

  test('a real, expired Healthcare pharmacy orgId still trips the guard (regression: pharmacy behavior unchanged)', () => {
    const orgId = 'hc_pharmacy_uid_pharmacy_owner2';
    expect(pharmacyOwnerUidFromOrgId(orgId)).toBe('uid_pharmacy_owner2');
    const guardFires = Boolean(pharmacyOwnerUidFromOrgId(orgId)) && !isCommerceBillingOperational('expired');
    expect(guardFires).toBe(true);
  });

  test('a real, active Healthcare pharmacy orgId does not trip the guard (regression: pharmacy behavior unchanged)', () => {
    const orgId = 'hc_pharmacy_uid_pharmacy_owner1';
    expect(pharmacyOwnerUidFromOrgId(orgId)).toBe('uid_pharmacy_owner1');
    const guardFires = Boolean(pharmacyOwnerUidFromOrgId(orgId)) && !isCommerceBillingOperational('active');
    expect(guardFires).toBe(false);
  });
});
