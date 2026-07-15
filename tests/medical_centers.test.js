'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

describe('medical_centers — reads', () => {
  test('5.1 any authenticated user can read an active center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'medical_centers', 'center1')));
  });

  test('5.1b center owner can read their inactive center', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'medical_centers', 'center_inactive'), {
        ownerId: 'uid_doctor1', isActive: false, name_en: 'Inactive Center',
      });
    });
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'medical_centers', 'center_inactive')));
  });

  test('5.1c center member can read their inactive center', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'medical_centers', 'center_inactive'), {
        ownerId: 'uid_doctor1', isActive: false, name_en: 'Inactive Center',
      });
      await setDoc(doc(db, 'medical_centers/center_inactive/members', 'uid_doctor2'), {
        uid: 'uid_doctor2', role: 'receptionist', isActive: true,
      });
    });
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(getDoc(doc(db, 'medical_centers', 'center_inactive')));
  });

  test('5.1d unrelated user cannot read an inactive center', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'medical_centers', 'center_inactive'), {
        ownerId: 'uid_doctor1', isActive: false, name_en: 'Inactive Center',
      });
    });
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'medical_centers', 'center_inactive')));
  });

  test('5.1e GET on a non-existent center doc returns not-found, not permission-denied', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'medical_centers', 'nonexistent_center_xyz')));
  });
});

describe('medical_centers — creates', () => {
  test('5.2 doctor can create a center they own', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers', 'center_new'), {
        ownerId:  'uid_doctor1',
        name_en:  'New Center',
        isActive: true,
      })
    );
  });

  test('5.3 patient (non-doctor) cannot create a center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers', 'center_fake'), {
        ownerId:  'uid_patient1',
        name_en:  'Fake Center',
      })
    );
  });
});

describe('medical_centers — updates (critical: billing fields)', () => {
  test('5.4 center owner can update non-billing fields (name)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), { name_en: 'Updated Name' })
    );
  });

  test('5.5 center owner cannot update subscriptionStatus (billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { subscriptionStatus: 'expired' })
    );
  });

  test('5.5b center owner cannot update currentPlan (billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { currentPlan: 'professional' })
    );
  });

  test('5.6 admin can update any billing field', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        subscriptionStatus: 'expired',
        currentPlan:        'solo',
      })
    );
  });

  // Phase 1B — Commerce billing fields must sit in the SAME protected tier
  // as the existing Healthcare billing fields above (5.5/5.5b/5.6).
  test('5.10 center owner cannot update commerceSubscriptionStatus (Commerce billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { commerceSubscriptionStatus: 'active' })
    );
  });

  test('5.10b center owner cannot update commercePlanId (Commerce billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { commercePlanId: 'professional' })
    );
  });

  test('5.10c center owner cannot update commerceTrialCompleted (Commerce billing field)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { commerceTrialCompleted: true })
    );
  });

  test('5.10d center owner cannot update commercePlanVersion (Commerce billing field)', async () => {
    // Phase 1B (Commerce Billing) approval — commercePlanVersion was the
    // one sibling billing field missing from this blocklist; added
    // alongside commercePlanId to close the gap before the admin approval
    // flow became the first real writer of Commerce billing fields.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'medical_centers', 'center1'), { commercePlanVersion: 1 })
    );
  });

  test('5.11 admin can update any Commerce billing field', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'medical_centers', 'center1'), {
        commerceSubscriptionStatus: 'active',
        commercePlanId:             'starter',
        commercePlanVersion:        1,
        commerceTrialCompleted:     true,
      })
    );
  });
});

describe('medical_centers — members subcollection', () => {
  test('5.7 center member can read the members list', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      getDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'))
    );
  });

  test('5.8 center member (non-owner) cannot add new members', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_intruder'), {
        role: 'receptionist',
      })
    );
  });

  test('5.9 center owner can add new members', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_newstaff'), {
        role: 'receptionist',
      })
    );
  });
});
