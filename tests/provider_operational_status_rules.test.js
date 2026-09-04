'use strict';

// Invited Pharmacy / Lab staff -> organization workspace.
//
// A pharmacy or lab staff member is an active member of the provider but is
// NOT the provider: request.auth.uid != the provider document id, and they are
// not an admin. The parent read rule allows only those two, so
// centerAccessProvider's subscription stream failed with permission-denied and
// CenterDashboardPage rendered its error branch — a blank page reading
// "Access error" — for every pharmacy and lab staff member.
//
// The parent must STAY closed: it carries the owner's nationalIdNumber,
// idFrontUrl, idBackUrl, licenseDocUrl and personal phone/email. These tests
// assert both halves — the mirror opens for active members, and the parent does
// not.
//
// Query shape matches what the portal actually issues:
//   centerAccessProvider -> collection('<providers>/<orgId>/operational')
//                             .doc('status').snapshots()

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
} = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Self-contained: seeded on top of the shared seed rather than inside it, so no
// existing suite's expectations can shift underneath these tests.
async function seedProviderFixtures(env) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // ── Pharmacy A (operating) ──────────────────────────────────────────────
    await setDoc(doc(db, 'users', 'uid_pharm_owner'), { role: 'pharmacy_provider' });
    await setDoc(doc(db, 'users', 'uid_pharm_staff'), { role: 'staff' });
    await setDoc(doc(db, 'users', 'uid_pharm_staff_inactive'), { role: 'staff' });
    await setDoc(doc(db, 'pharmacy_providers', 'uid_pharm_owner'), {
      userId: 'uid_pharm_owner',
      status: 'active',
      subscriptionStatus: 'active',
      subscriptionEnd: FUTURE,
      // The private fields the mirror exists to keep private.
      nationalIdNumber: '19900101234',
      idFrontUrl: 'https://example.test/id-front.jpg',
      idBackUrl: 'https://example.test/id-back.jpg',
      licenseDocUrl: 'https://example.test/licence.pdf',
      phone: '+9647700000001',
      email: 'owner@pharmacy.test',
    });
    await setDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/pharmacy_members', 'uid_pharm_staff'), {
      uid: 'uid_pharm_staff', role: 'pharmacist', isActive: true, status: 'active',
    });
    await setDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/pharmacy_members', 'uid_pharm_staff_inactive'), {
      uid: 'uid_pharm_staff_inactive', role: 'pharmacist', isActive: false, status: 'inactive',
    });
    await setDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/operational', 'status'), {
      status: 'active', subscriptionStatus: 'active',
      trialEnds: null, subscriptionEnd: FUTURE, gracePeriodEnds: null,
    });

    // ── Pharmacy B (a DIFFERENT employer) ───────────────────────────────────
    await setDoc(doc(db, 'users', 'uid_pharm2_owner'), { role: 'pharmacy_provider' });
    await setDoc(doc(db, 'pharmacy_providers', 'uid_pharm2_owner'), {
      userId: 'uid_pharm2_owner', status: 'active', subscriptionStatus: 'active', subscriptionEnd: FUTURE,
    });
    await setDoc(doc(db, 'pharmacy_providers/uid_pharm2_owner/operational', 'status'), {
      status: 'active', subscriptionStatus: 'active',
      trialEnds: null, subscriptionEnd: FUTURE, gracePeriodEnds: null,
    });

    // ── Lab A (lapsed — the state the gate must still be able to observe) ────
    await setDoc(doc(db, 'users', 'uid_lab_owner'), { role: 'diagnostic_provider' });
    await setDoc(doc(db, 'users', 'uid_lab_staff'), { role: 'staff' });
    await setDoc(doc(db, 'users', 'uid_lab_staff_inactive'), { role: 'staff' });
    await setDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner'), {
      userId: 'uid_lab_owner',
      status: 'active',
      subscriptionStatus: 'active',
      subscriptionEnd: PAST,
      nationalIdNumber: '19900101235',
      idFrontUrl: 'https://example.test/lab-id-front.jpg',
      licenseDocUrl: 'https://example.test/lab-licence.pdf',
      phone: '+9647700000002',
      email: 'owner@lab.test',
    });
    await setDoc(doc(db, 'diagnostic_providers/uid_lab_owner/lab_members', 'uid_lab_staff'), {
      uid: 'uid_lab_staff', role: 'lab_technician', isActive: true, status: 'active',
    });
    await setDoc(doc(db, 'diagnostic_providers/uid_lab_owner/lab_members', 'uid_lab_staff_inactive'), {
      uid: 'uid_lab_staff_inactive', role: 'lab_technician', isActive: false, status: 'inactive',
    });
    await setDoc(doc(db, 'diagnostic_providers/uid_lab_owner/operational', 'status'), {
      status: 'active', subscriptionStatus: 'active',
      trialEnds: null, subscriptionEnd: PAST, gracePeriodEnds: null,
    });

    // ── Lab B (a DIFFERENT employer) ────────────────────────────────────────
    await setDoc(doc(db, 'users', 'uid_lab2_owner'), { role: 'diagnostic_provider' });
    await setDoc(doc(db, 'diagnostic_providers', 'uid_lab2_owner'), {
      userId: 'uid_lab2_owner', status: 'active', subscriptionStatus: 'active', subscriptionEnd: FUTURE,
    });
    await setDoc(doc(db, 'diagnostic_providers/uid_lab2_owner/operational', 'status'), {
      status: 'active', subscriptionStatus: 'active',
      trialEnds: null, subscriptionEnd: FUTURE, gracePeriodEnds: null,
    });
  });
}

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedDatabase(testEnv);
  await seedProviderFixtures(testEnv);
});
afterAll(async () => { await testEnv.cleanup(); });

const mirror = (db, providers, orgId) =>
  getDoc(doc(db, providers + '/' + orgId + '/operational', 'status'));

// ── Pharmacy staff ───────────────────────────────────────────────────────────

describe('pharmacy staff — operational status mirror read', () => {
  test('P-1 active pharmacy staff CAN read their own pharmacy operational status', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertSucceeds(mirror(db, 'pharmacy_providers', 'uid_pharm_owner'));
  });

  test('P-2 active pharmacy staff CANNOT read ANOTHER pharmacy operational status', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertFails(mirror(db, 'pharmacy_providers', 'uid_pharm2_owner'));
  });

  test('P-3 DEACTIVATED pharmacy staff CANNOT read the operational status', async () => {
    // isActive:false — a dismissed employee loses the signal immediately.
    const db = testEnv.authenticatedContext('uid_pharm_staff_inactive').firestore();
    await assertFails(mirror(db, 'pharmacy_providers', 'uid_pharm_owner'));
  });

  test('P-4 a signed-in non-member CANNOT read the operational status', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(mirror(db, 'pharmacy_providers', 'uid_pharm_owner'));
  });

  test('P-5 unauthenticated CANNOT read the operational status', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(mirror(db, 'pharmacy_providers', 'uid_pharm_owner'));
  });

  test('P-6 the pharmacy OWNER can read the operational status', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_owner').firestore();
    await assertSucceeds(mirror(db, 'pharmacy_providers', 'uid_pharm_owner'));
  });

  test('P-7 an admin can read the operational status', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(mirror(db, 'pharmacy_providers', 'uid_pharm_owner'));
  });
});

// ── Lab staff ────────────────────────────────────────────────────────────────

describe('lab staff — operational status mirror read', () => {
  test('L-1 active lab staff CAN read their own lab operational status', async () => {
    const db = testEnv.authenticatedContext('uid_lab_staff').firestore();
    await assertSucceeds(mirror(db, 'diagnostic_providers', 'uid_lab_owner'));
  });

  test('L-2 active lab staff CANNOT read ANOTHER lab operational status', async () => {
    const db = testEnv.authenticatedContext('uid_lab_staff').firestore();
    await assertFails(mirror(db, 'diagnostic_providers', 'uid_lab2_owner'));
  });

  test('L-3 DEACTIVATED lab staff CANNOT read the operational status', async () => {
    const db = testEnv.authenticatedContext('uid_lab_staff_inactive').firestore();
    await assertFails(mirror(db, 'diagnostic_providers', 'uid_lab_owner'));
  });

  test('L-4 a signed-in non-member CANNOT read the operational status', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(mirror(db, 'diagnostic_providers', 'uid_lab_owner'));
  });

  test('L-5 unauthenticated CANNOT read the operational status', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(mirror(db, 'diagnostic_providers', 'uid_lab_owner'));
  });

  test('L-6 the lab OWNER can read the operational status', async () => {
    const db = testEnv.authenticatedContext('uid_lab_owner').firestore();
    await assertSucceeds(mirror(db, 'diagnostic_providers', 'uid_lab_owner'));
  });

  test('L-7 a LAPSED lab still exposes its status to its own staff', async () => {
    // The whole point of the mirror: staff must be able to OBSERVE that their
    // employer is no longer operational, not be denied and fall through to a
    // blank page. subscriptionEnd is in the past for this fixture.
    const db = testEnv.authenticatedContext('uid_lab_staff').firestore();
    const snap = await assertSucceeds(mirror(db, 'diagnostic_providers', 'uid_lab_owner'));
    expect(snap.data().subscriptionEnd.toDate().getTime()).toBeLessThan(Date.now());
  });
});

// ── The parent document stays private ────────────────────────────────────────

describe('parent provider documents remain owner-and-admin-only', () => {
  test('S-1 pharmacy staff STILL cannot read pharmacy_providers/{id}', async () => {
    // The regression this whole change exists to avoid: the parent carries
    // nationalIdNumber, idFrontUrl, idBackUrl, licenseDocUrl, phone and email.
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertFails(getDoc(doc(db, 'pharmacy_providers', 'uid_pharm_owner')));
  });

  test('S-2 lab staff STILL cannot read diagnostic_providers/{id}', async () => {
    const db = testEnv.authenticatedContext('uid_lab_staff').firestore();
    await assertFails(getDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner')));
  });

  test('S-3 pharmacy OWNER still reads their own parent document', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_owner').firestore();
    await assertSucceeds(getDoc(doc(db, 'pharmacy_providers', 'uid_pharm_owner')));
  });

  test('S-4 lab OWNER still reads their own parent document', async () => {
    const db = testEnv.authenticatedContext('uid_lab_owner').firestore();
    await assertSucceeds(getDoc(doc(db, 'diagnostic_providers', 'uid_lab_owner')));
  });
});

// ── Server-owned in both directions ──────────────────────────────────────────

describe('operational status is server-owned', () => {
  test('W-1 pharmacy staff CANNOT create an operational status doc', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertFails(setDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/operational', 'forged'), {
      status: 'active', subscriptionEnd: FUTURE,
    }));
  });

  test('W-2 pharmacy staff CANNOT extend their employer subscription', async () => {
    // A staff member who could write this could grant unlimited free operation.
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertFails(updateDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/operational', 'status'), {
      subscriptionEnd: FUTURE,
    }));
  });

  test('W-3 the pharmacy OWNER cannot write it either', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_owner').firestore();
    await assertFails(updateDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/operational', 'status'), {
      subscriptionEnd: FUTURE,
    }));
  });

  test('W-4 an ADMIN cannot write it either — admin SDK only', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(updateDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/operational', 'status'), {
      subscriptionEnd: FUTURE,
    }));
  });

  test('W-5 nobody can delete it', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_owner').firestore();
    await assertFails(deleteDoc(doc(db, 'pharmacy_providers/uid_pharm_owner/operational', 'status')));
  });

  test('W-6 lab staff CANNOT write their lab operational status', async () => {
    const db = testEnv.authenticatedContext('uid_lab_staff').firestore();
    await assertFails(updateDoc(doc(db, 'diagnostic_providers/uid_lab_owner/operational', 'status'), {
      subscriptionEnd: FUTURE,
    }));
  });
});

// ── Scope containment ────────────────────────────────────────────────────────

describe('the grant does not widen beyond one organization', () => {
  test('C-1 pharmacy staff cannot list another pharmacy operational collection', async () => {
    // The grant is scoped to a member's own organization.
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertFails(getDocs(collection(db, 'pharmacy_providers/uid_pharm2_owner/operational')));
  });

  test('C-2 pharmacy staff cannot read the pharmacy_members of another pharmacy', async () => {
    const db = testEnv.authenticatedContext('uid_pharm_staff').firestore();
    await assertFails(getDocs(collection(db, 'pharmacy_providers/uid_pharm2_owner/pharmacy_members')));
  });
});
