'use strict';

// Tests that accountLifecycle writes are blocked on the client side
// (only Cloud Functions admin SDK may write accountLifecycle),
// and that account_deletion_log / account_deletion_requests deny all client access.

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, collection, addDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

// ─── accountLifecycle write protection — users ───────────────────────────────

describe('lifecycle — users accountLifecycle write protection', () => {
  test('LC-U1 patient cannot add accountLifecycle to own user doc', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_patient1'), {
        'accountLifecycle.status': 'deletionPending',
      })
    );
  });

  test('LC-U2 doctor cannot add accountLifecycle to own user doc', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_doctor1'), {
        accountLifecycle: { status: 'deletionPending' },
      })
    );
  });

  test('LC-U3 admin auth token cannot write accountLifecycle via client SDK', async () => {
    // Even admin custom-claim users are blocked — only admin SDK (bypasses rules) may write lifecycle.
    const db = testEnv.authenticatedContext('uid_admin', { role: 'admin' }).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_patient1'), {
        'accountLifecycle.status': 'deletionPending',
      })
    );
  });

  test('LC-U4 patient CAN update non-lifecycle fields on own doc', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', 'uid_patient1'), { phone: '07701111111' })
    );
  });

  test('LC-U5 unauthenticated cannot write accountLifecycle', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'uid_patient1'), {
        'accountLifecycle.status': 'deletionPending',
      })
    );
  });
});

// ─── accountLifecycle write protection — doctors ─────────────────────────────

describe('lifecycle — doctors accountLifecycle write protection', () => {
  test('LC-D1 doctor cannot add accountLifecycle to own doctors doc', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), {
        'accountLifecycle.status': 'deletionPending',
      })
    );
  });

  test('LC-D2 doctor cannot set accountLifecycle object on own doctors doc', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), {
        accountLifecycle: { status: 'deletionPending', scheduledDeletionAt: null },
      })
    );
  });

  test('LC-D3 doctor CAN update non-lifecycle fields on own doctors doc', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { about_en: 'Updated bio' })
    );
  });

  test('LC-D4 admin auth token cannot write accountLifecycle to doctors via client SDK', async () => {
    const db = testEnv.authenticatedContext('uid_admin', { role: 'admin' }).firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), {
        'accountLifecycle.status': 'deletionPending',
      })
    );
  });
});

// ─── accountLifecycle write protection — medical_centers ─────────────────────

describe('lifecycle — medical_centers accountLifecycle write protection', () => {
  test('LC-C1 center owner cannot add accountLifecycle to center doc', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        'accountLifecycle.status': 'closurePending',
      })
    );
  });

  test('LC-C2 center admin member cannot write accountLifecycle to center', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        'accountLifecycle.status': 'closurePending',
      })
    );
  });

  test('LC-C3 center owner CAN update non-lifecycle center fields', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), { name_en: 'Updated Center Name' })
    );
  });

  test('LC-C4 center member subcollection create WITHOUT accountLifecycle works', async () => {
    // Regression: touchesLifecycle() null-dereference on creates was fixed.
    // This test confirms the fix holds: a new member doc (resource==null) with no
    // accountLifecycle field must be allowed.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_new_member'), {
        uid: 'uid_doctor2',
        role: 'receptionist',
        isActive: true,
      })
    );
  });

  test('LC-C5 center member subcollection create WITH accountLifecycle is blocked', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_lifecycle_member'), {
        uid: 'uid_doctor2',
        role: 'receptionist',
        accountLifecycle: { status: 'active' },
      })
    );
  });
});

// ─── account_deletion_log — deny all ─────────────────────────────────────────

describe('lifecycle — account_deletion_log deny all', () => {
  test('LC-L1 unauthenticated cannot read account_deletion_log', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'account_deletion_log', 'event1')));
  });

  test('LC-L2 patient cannot read account_deletion_log', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'account_deletion_log', 'event1')));
  });

  test('LC-L3 admin auth token cannot read account_deletion_log via client SDK', async () => {
    const db = testEnv.authenticatedContext('uid_admin', { role: 'admin' }).firestore();
    await assertFails(getDoc(doc(db, 'account_deletion_log', 'event1')));
  });

  test('LC-L4 patient cannot write to account_deletion_log', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'account_deletion_log', 'my_event'), { uid: 'uid_patient1', event: 'deletion_requested' })
    );
  });

  test('LC-L5 admin auth token cannot write to account_deletion_log via client SDK', async () => {
    const db = testEnv.authenticatedContext('uid_admin', { role: 'admin' }).firestore();
    await assertFails(
      addDoc(collection(db, 'account_deletion_log'), { uid: 'uid_patient1', event: 'deletion_requested' })
    );
  });
});

// ─── account_deletion_requests — deny all ────────────────────────────────────

describe('lifecycle — account_deletion_requests deny all', () => {
  test('LC-R1 unauthenticated cannot read account_deletion_requests', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'account_deletion_requests', 'req1')));
  });

  test('LC-R2 patient cannot read account_deletion_requests', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'account_deletion_requests', 'req1')));
  });

  test('LC-R3 admin auth token cannot read account_deletion_requests via client SDK', async () => {
    const db = testEnv.authenticatedContext('uid_admin', { role: 'admin' }).firestore();
    await assertFails(getDoc(doc(db, 'account_deletion_requests', 'req1')));
  });

  test('LC-R4 patient cannot write to account_deletion_requests', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'account_deletion_requests', 'my_req'), { userId: 'uid_patient1', status: 'pending' })
    );
  });

  test('LC-R5 admin auth token cannot write to account_deletion_requests via client SDK', async () => {
    const db = testEnv.authenticatedContext('uid_admin', { role: 'admin' }).firestore();
    await assertFails(
      addDoc(collection(db, 'account_deletion_requests'), { userId: 'uid_patient1', status: 'pending' })
    );
  });
});

// ─── Legacy docs (no accountLifecycle field) — existing ops not blocked ───────

describe('lifecycle — legacy docs regression (no accountLifecycle present)', () => {
  test('LC-LEG1 patient without accountLifecycle can update own phone', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', 'uid_patient1'), { phone: '07709999999' })
    );
  });

  test('LC-LEG2 doctor without accountLifecycle can update own about_en', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), { about_en: 'Legacy doctor bio' })
    );
  });

  test('LC-LEG3 center owner without accountLifecycle can update center name', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), { name_en: 'Legacy Center' })
    );
  });
});
