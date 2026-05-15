'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

describe('users — reads', () => {
  test('1.1 patient can read their own doc', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'users', 'uid_patient1')));
  });

  test('1.2 doctor can read patient doc (phone search)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'users', 'uid_patient1')));
  });

  test('1.3 admin can read any user doc', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'users', 'uid_patient1')));
  });

  test('1.4 unauthenticated cannot read any user doc', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users', 'uid_patient1')));
  });

  test('1.5 patient (non-doctor) cannot read another user doc', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'users', 'uid_doctor1')));
  });
});

describe('users — privilege escalation (critical)', () => {
  test('1.6 user cannot create own doc with role:admin', async () => {
    const db = testEnv.authenticatedContext('uid_newuser').firestore();
    await assertFails(
      setDoc(doc(db, 'users', 'uid_newuser'), { role: 'admin', phone: '0770000000' })
    );
  });

  test('1.7 user cannot update own doc to set role:admin', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_patient1'), { role: 'admin' })
    );
  });
});
