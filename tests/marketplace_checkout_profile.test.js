'use strict';

/**
 * Phase 3 follow-up (2026-08-16) — checkout phone-autofill regression.
 *
 * Root cause: getMarketplaceCheckoutProfile read ONLY
 * users/{uid}.phoneNumber, with no fallback, while the (working) Healthcare
 * booking flow (confirm_booking_modal.dart) already falls back to the
 * Firebase Auth ID token's own phone_number claim when that Firestore
 * field is empty. Any patient whose Firestore phoneNumber was never
 * backfilled (it is only ever written once, at initial user-doc creation)
 * but who does have a verified Auth-level phone got name autofill (name
 * has no such gap) but NOT phone autofill, matching the reported symptom
 * exactly. This exercises the REAL resolveMarketplaceCheckoutProfile
 * (functions/commerce/marketplaceCheckout.js) against the Firestore
 * emulator, not a duplicate re-implementation.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest marketplace_checkout_profile --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  resolveMarketplaceCheckoutProfile,
} = require('../functions/commerce/marketplaceCheckout');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('users');
});

afterAll(async () => {
  await admin.app().delete();
});

describe('resolveMarketplaceCheckoutProfile', () => {
  test('stored name + stored phone: both prefill from Firestore', async () => {
    await db.collection('users').doc('uid1').set({
      name: 'Ali Hassan',
      phoneNumber: '07701234567',
    });

    const profile = await resolveMarketplaceCheckoutProfile(db, 'uid1', {});
    expect(profile.name).toBe('Ali Hassan');
    expect(profile.phone).toBe('07701234567');
  });

  test('name present, phone absent from Firestore but present on the Auth token: name from Firestore, phone falls back to Auth claim', async () => {
    await db.collection('users').doc('uid2').set({
      name: 'Sara Ahmed',
      phoneNumber: '',
    });

    const profile = await resolveMarketplaceCheckoutProfile(db, 'uid2', {
      phone_number: '+9647701234567',
    });
    expect(profile.name).toBe('Sara Ahmed');
    expect(profile.phone).toBe('+9647701234567');
  });

  test('name present, phone absent from both Firestore and Auth token: phone stays blank (editable), not fabricated', async () => {
    await db.collection('users').doc('uid3').set({
      name: 'Omar Karim',
    });

    const profile = await resolveMarketplaceCheckoutProfile(db, 'uid3', {});
    expect(profile.name).toBe('Omar Karim');
    expect(profile.phone).toBe('');
  });

  test('stored Firestore phone is never overridden by the Auth claim when both exist', async () => {
    await db.collection('users').doc('uid4').set({
      name: 'Layla Jabbar',
      phoneNumber: '07709998888',
    });

    const profile = await resolveMarketplaceCheckoutProfile(db, 'uid4', {
      phone_number: '+9647701112222',
    });
    expect(profile.phone).toBe('07709998888');
  });

  test('no user doc at all: name and phone both blank, no crash', async () => {
    const profile = await resolveMarketplaceCheckoutProfile(db, 'uid_missing', {});
    expect(profile.name).toBe('');
    expect(profile.phone).toBe('');
    expect(profile.homeAddress).toBeNull();
  });
});
