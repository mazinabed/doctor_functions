'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

describe('platformConfig/legal — server-only in both directions', () => {
  test('unauthenticated cannot read', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'platformConfig', 'legal')));
  });

  test('signed-in patient cannot read', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'platformConfig', 'legal')));
  });

  test('admin cannot read — no client read path exists at all', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(getDoc(doc(db, 'platformConfig', 'legal')));
  });

  test('no client, including admin, can write', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(setDoc(doc(db, 'platformConfig', 'legal'), { patientTermsVersion: 'v2' }));
  });
});

describe('users/{uid}.legalAcceptances — server-only write, matches accountLifecycle discipline', () => {
  test('patient cannot create their own doc with legalAcceptances set', async () => {
    const db = testEnv.authenticatedContext('uid_newuser').firestore();
    await assertFails(
      setDoc(doc(db, 'users', 'uid_newuser'), {
        role: 'patient',
        legalAcceptances: { terms: { accepted: true, version: 'v999-forged', acceptedAt: new Date() } },
      })
    );
  });

  test('patient cannot update their own doc to set legalAcceptances directly', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_patient1'), {
        legalAcceptances: { terms: { accepted: true, version: 'v999-forged', acceptedAt: new Date() } },
      })
    );
  });

  test('admin cannot write legalAcceptances either — no client path at all, matching accountLifecycle', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_patient1'), {
        legalAcceptances: { terms: { accepted: true, version: 'v1' } },
      })
    );
  });

  test('regression: patient can still update an ordinary field (phone) — the new guard does not over-block', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(updateDoc(doc(db, 'users', 'uid_patient1'), { phone: '07709999999' }));
  });
});

describe('users/{uid}/legalHistory — append-only, server-only in both directions', () => {
  test('the account owner cannot read their own legalHistory', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'users/uid_patient1/legalHistory', 'hist1')));
  });

  test('the account owner cannot write (forge) a legalHistory entry, even their own', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'users/uid_patient1/legalHistory', 'hist1'), {
        documentType: 'terms',
        version: 'v999-forged',
        acceptedAt: new Date(),
      })
    );
  });

  test('admin cannot write a legalHistory entry either', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      setDoc(doc(db, 'users/uid_patient1/legalHistory', 'hist1'), {
        documentType: 'terms',
        version: 'v1',
        acceptedAt: new Date(),
      })
    );
  });
});
