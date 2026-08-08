'use strict';

/**
 * Legal Consent Modernization (Healthcare Phase 4) — focused test for
 * placeMarketplaceOrder/quoteMarketplaceCart's new legal-coverage guard,
 * exercising the REAL resolvePharmacyLegalCoverageCurrent (functions/
 * commerce/marketplaceCheckout.js), which itself calls the REAL
 * isFacilityLegalCurrent (functions/legal/facilityLegalConsent.js) — not a
 * duplicate re-implementation of the guard logic. Same convention as the
 * existing marketplace_checkout_guards.test.js (GUARD 1, billing).
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest marketplace_checkout_legal_gate --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  resolvePharmacyLegalCoverageCurrent,
  pharmacyOwnerUidFromOrgId,
} = require('../functions/commerce/marketplaceCheckout');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('platformConfig');
  await clearCollection('pharmacy_providers');
});

afterAll(async () => {
  await admin.app().delete();
});

describe('resolvePharmacyLegalCoverageCurrent (real Firestore reads)', () => {
  test('MCL-1 healthcare-origin + current Pharmacy Agreement acceptance -> true (allowed)', async () => {
    await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v2' });
    await db.collection('pharmacy_providers').doc('uid_mcl_owner1').set({
      userId: 'uid_mcl_owner1',
      legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v2' } },
    });

    const current = await resolvePharmacyLegalCoverageCurrent(db, 'hc_pharmacy_uid_mcl_owner1');
    expect(current).toBe(true);
  });

  test('MCL-2 healthcare-origin + stale Pharmacy Agreement acceptance -> false (blocked)', async () => {
    await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v3' });
    await db.collection('pharmacy_providers').doc('uid_mcl_owner2').set({
      userId: 'uid_mcl_owner2',
      legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v2' } },
    });

    const current = await resolvePharmacyLegalCoverageCurrent(db, 'hc_pharmacy_uid_mcl_owner2');
    expect(current).toBe(false);
  });

  test('MCL-3 healthcare-origin + no acceptance at all -> false (blocked, not fail-open)', async () => {
    await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v1' });
    await db.collection('pharmacy_providers').doc('uid_mcl_owner3').set({ userId: 'uid_mcl_owner3' });

    const current = await resolvePharmacyLegalCoverageCurrent(db, 'hc_pharmacy_uid_mcl_owner3');
    expect(current).toBe(false);
  });

  test('MCL-4 healthcare-origin + no facility doc at all -> false (blocked, not fail-open)', async () => {
    const current = await resolvePharmacyLegalCoverageCurrent(db, 'hc_pharmacy_uid_mcl_no_facility');
    expect(current).toBe(false);
  });

  test('MCL-5 a standalone (non hc_pharmacy_) orgId resolves null -> the guard never fires for it, commerce-only checkout is unaffected', async () => {
    expect(pharmacyOwnerUidFromOrgId('OIH67W4vZjLPV7SVa3bd')).toBeNull();
    const current = await resolvePharmacyLegalCoverageCurrent(db, 'OIH67W4vZjLPV7SVa3bd');
    expect(current).toBeNull();
    const guardFires = Boolean(pharmacyOwnerUidFromOrgId('OIH67W4vZjLPV7SVa3bd')) && !current;
    expect(guardFires).toBe(false);
  });

  test('MCL-6 combined guard condition: a real, non-current pharmacy still trips the guard', async () => {
    await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v2' });
    await db.collection('pharmacy_providers').doc('uid_mcl_owner6').set({ userId: 'uid_mcl_owner6' });

    const orgId = 'hc_pharmacy_uid_mcl_owner6';
    const current = await resolvePharmacyLegalCoverageCurrent(db, orgId);
    const guardFires = Boolean(pharmacyOwnerUidFromOrgId(orgId)) && !current;
    expect(guardFires).toBe(true);
  });

  test('MCL-7 combined guard condition: a real, current pharmacy does not trip the guard', async () => {
    await db.collection('platformConfig').doc('legal').set({ pharmacyAgreementVersion: 'v2' });
    await db.collection('pharmacy_providers').doc('uid_mcl_owner7').set({
      userId: 'uid_mcl_owner7',
      legalAcceptances: { pharmacyAgreement: { accepted: true, version: 'v2' } },
    });

    const orgId = 'hc_pharmacy_uid_mcl_owner7';
    const current = await resolvePharmacyLegalCoverageCurrent(db, orgId);
    const guardFires = Boolean(pharmacyOwnerUidFromOrgId(orgId)) && !current;
    expect(guardFires).toBe(false);
  });
});
