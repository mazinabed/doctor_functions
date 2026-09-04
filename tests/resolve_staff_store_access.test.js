'use strict';

/**
 * resolveStaffStoreAccess — caller authorization.
 *
 * ── What this covers ────────────────────────────────────────────────────────
 *
 * This endpoint was built for ONE caller shape: an owner/admin saving the
 * Add/Edit Staff sheet on someone ELSE's behalf. Commerce's
 * establishStaffCommerceSession reused it for the opposite shape — a staff
 * member opening Store for the first time, where the actor IS the subject —
 * and the owner/admin guard refused it with 403. establishStaffCommerceSession
 * did not catch that, so it surfaced as an opaque HTTP 500 and no invited
 * pharmacy staff member could ever open Store.
 *
 * The guard was unsatisfiable for them, not merely strict: firestore.rules
 * forbids an invite from creating a 'pharmacy_admin' and blocks client-side
 * promotion to it, so no invited staff account can ever be one.
 *
 * Two layers are asserted here:
 *   - the pure decision (isCallerAuthorizedForStaffRecord), and
 *   - the REAL HTTP handler against the Firestore emulator, with only
 *     verifyIdToken stubbed — so the path-scoping, the {found:false} early
 *     return and the response projection are all exercised for real.
 *
 * The security property under test is TWO-SIDED: self-resolution must open,
 * and everything else must stay exactly as closed as it was. A caller must
 * still never read ANOTHER member's record without owner/admin authority.
 *
 * It must also GRANT nothing. This endpoint only reports what an owner or
 * manager already assigned in Healthcare — a member without store_access is
 * still reported without it, and a narrow permission set stays narrow.
 */

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

// Reuses the functions/ workspace's own firebase-admin install — this test
// package.json is scoped to the client SDK / rules-unit-testing only. Same
// convention as phase1b_expire_centers_integration.test.js.
const admin = require('../functions/node_modules/firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}

// Only the identity check is stubbed. Firestore is the real emulator, and the
// handler below is the real exported onRequest — not a reimplementation.
const TOKENS = {
  'token-owner': 'uid_pharm_owner',
  'token-staff': 'uid_pharm_staff',
  'token-staff2': 'uid_pharm_staff2',
  'token-inactive': 'uid_pharm_staff_inactive',
  'token-admin-member': 'uid_pharm_admin_member',
  'token-outsider': 'uid_outsider',
  'token-other-pharmacy-staff': 'uid_pharm2_staff',
};

jest.spyOn(admin, 'auth').mockReturnValue({
  verifyIdToken: async (token) => {
    const uid = TOKENS[token];
    if (!uid) throw new Error('invalid token');
    return { uid };
  },
});

// The raw handler, not the onRequest wrapper — that one expects a full
// Express response object (res.on, etc). This is the same function the
// deployed endpoint runs, just without the transport wrapper.
const {
  _resolveStaffStoreAccessHandler: handler,
  isCallerAuthorizedForStaffRecord,
} = require('../functions/commerce/resolveStaffStoreAccess');

const db = admin.firestore();

const PHARMACY = 'uid_pharm_owner';
const PHARMACY_2 = 'uid_pharm2_owner';

// Minimal fake req/res — the handler only uses req.method, req.body,
// res.status() and res.json().
function invoke(body, method = 'POST') {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    handler({ method, body }, res);
  });
}

async function seed() {
  const members = db
    .collection('pharmacy_providers')
    .doc(PHARMACY)
    .collection('pharmacy_members');

  await db.collection('users').doc(PHARMACY).set({
    role: 'pharmacy_provider',
    // No centerId — keeps the optional billing lookup a no-op, so these
    // tests assert authorization only.
  });

  // An ordinary staff member WITH Store access, granted a narrow set.
  await members.doc('uid_pharm_staff').set({
    uid: 'uid_pharm_staff',
    role: 'pharmacist',
    isActive: true,
    status: 'active',
    displayName: 'Staff One',
    phoneNumber: '+9647700000011',
    permissions: [
      'store_access',
      'store_inventory',
      // Healthcare-only keys that must never cross the bridge.
      'team_management',
      'pharmacy_settings',
    ],
    storeCommercePermissions: ['inventory_view'],
  });

  // A second staff member — the "someone else" in the isolation tests.
  await members.doc('uid_pharm_staff2').set({
    uid: 'uid_pharm_staff2',
    role: 'pharmacist',
    isActive: true,
    status: 'active',
    permissions: ['store_access', 'store_sales'],
  });

  // A staff member WITHOUT store_access at all.
  await members.doc('uid_pharm_no_store').set({
    uid: 'uid_pharm_no_store',
    role: 'receptionist',
    isActive: true,
    status: 'active',
    permissions: ['pharmacy_requests'],
  });

  // A deactivated staff member.
  await members.doc('uid_pharm_staff_inactive').set({
    uid: 'uid_pharm_staff_inactive',
    role: 'pharmacist',
    isActive: false,
    status: 'inactive',
    permissions: ['store_access'],
  });

  // An active pharmacy_admin member (the only non-owner the old guard
  // admitted — unreachable for invited staff, but its path must not change).
  await members.doc('uid_pharm_admin_member').set({
    uid: 'uid_pharm_admin_member',
    role: 'pharmacy_admin',
    isActive: true,
    status: 'active',
    permissions: ['store_access'],
  });

  // A DIFFERENT pharmacy, with its own staff member.
  await db
    .collection('pharmacy_providers')
    .doc(PHARMACY_2)
    .collection('pharmacy_members')
    .doc('uid_pharm2_staff')
    .set({
      uid: 'uid_pharm2_staff',
      role: 'pharmacist',
      isActive: true,
      status: 'active',
      permissions: ['store_access'],
    });
}

async function clearFirestore() {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/doctorapp-7e8b3/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
}

beforeEach(async () => {
  await clearFirestore();
  await seed();
});

// ── The pure decision ────────────────────────────────────────────────────────

describe('isCallerAuthorizedForStaffRecord', () => {
  test('D-1 a caller reading their OWN record is authorized', () => {
    expect(
      isCallerAuthorizedForStaffRecord({
        callerUid: 'uid_a',
        staffMemberId: 'uid_a',
        callerIsOwnerOrAdmin: false,
      }),
    ).toBe(true);
  });

  test('D-2 a caller reading ANOTHER record without owner/admin is refused', () => {
    expect(
      isCallerAuthorizedForStaffRecord({
        callerUid: 'uid_a',
        staffMemberId: 'uid_b',
        callerIsOwnerOrAdmin: false,
      }),
    ).toBe(false);
  });

  test('D-3 an owner/admin reading another record is authorized', () => {
    expect(
      isCallerAuthorizedForStaffRecord({
        callerUid: 'uid_a',
        staffMemberId: 'uid_b',
        callerIsOwnerOrAdmin: true,
      }),
    ).toBe(true);
  });

  test('D-4 missing ids are refused rather than matching each other', () => {
    // undefined === undefined would otherwise read as "self".
    expect(
      isCallerAuthorizedForStaffRecord({
        callerUid: undefined,
        staffMemberId: undefined,
        callerIsOwnerOrAdmin: false,
      }),
    ).toBe(false);
    expect(
      isCallerAuthorizedForStaffRecord({
        callerUid: '',
        staffMemberId: '',
        callerIsOwnerOrAdmin: false,
      }),
    ).toBe(false);
  });
});

// ── The real handler ─────────────────────────────────────────────────────────

describe('resolveStaffStoreAccess — self-resolution (the fix)', () => {
  test('R-1 a staff member CAN resolve their OWN Store permissions', async () => {
    const res = await invoke({
      idToken: 'token-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.isActive).toBe(true);
    expect(res.body.storePermissions).toEqual(['store_access', 'store_inventory']);
  });

  test('R-2 self-resolution reports the assigned set — it does not widen it', async () => {
    // The permission model is the owner's to set; this endpoint only reports
    // it. store_sales was never granted and must not appear.
    const res = await invoke({
      idToken: 'token-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.body.storePermissions).not.toContain('store_sales');
    expect(res.body.storePermissions).not.toContain('store_finance');
    expect(res.body.storeCommercePermissions).toEqual(['inventory_view']);
  });

  test('R-3 a member WITHOUT store_access self-resolves without it', async () => {
    // Store access stays denied for them: establishStaffCommerceSession's own
    // pharmacyStaffStoreAccess gate rejects before it ever calls this, and
    // nothing here would hand them the key either.
    TOKENS['token-no-store'] = 'uid_pharm_no_store';
    const res = await invoke({
      idToken: 'token-no-store',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_no_store',
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.storePermissions).toEqual([]);
    expect(res.body.storePermissions).not.toContain('store_access');
  });

  test('R-4 a DEACTIVATED member self-resolves as isActive:false', async () => {
    // Reported, not refused — Commerce derives storeAccess:false from this
    // and routes to its deactivate branch.
    const res = await invoke({
      idToken: 'token-inactive',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff_inactive',
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.isActive).toBe(false);
  });

  test('R-5 self-resolution in a pharmacy they do not belong to leaks nothing', async () => {
    const res = await invoke({
      idToken: 'token-other-pharmacy-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm2_staff',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false });
  });
});

describe('resolveStaffStoreAccess — everything else stays closed', () => {
  test('R-6 a staff member CANNOT read ANOTHER member\'s record', async () => {
    // The self branch must not become a general staff read.
    const res = await invoke({
      idToken: 'token-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff2',
    });
    expect(res.status).toBe(403);
    expect(res.body.found).toBeUndefined();
  });

  test('R-7 an unrelated signed-in user CANNOT read a member record', async () => {
    const res = await invoke({
      idToken: 'token-outsider',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.status).toBe(403);
  });

  test('R-8 a staff member of another pharmacy CANNOT read this one\'s members', async () => {
    const res = await invoke({
      idToken: 'token-other-pharmacy-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.status).toBe(403);
  });

  test('R-9 an invalid/expired token is rejected before anything is read', async () => {
    const res = await invoke({
      idToken: 'not-a-real-token',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.status).toBe(401);
  });

  test('R-10 a non-POST method is rejected', async () => {
    const res = await invoke({}, 'GET');
    expect(res.status).toBe(405);
  });
});

describe('resolveStaffStoreAccess — owner/admin paths unchanged', () => {
  test('R-11 the OWNER can still read any member record', async () => {
    const res = await invoke({
      idToken: 'token-owner',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
  });

  test('R-12 an active pharmacy_admin member can still read another record', async () => {
    const res = await invoke({
      idToken: 'token-admin-member',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
  });

  test('R-13 the owner reading a member of a pharmacy they do not own is refused', async () => {
    const res = await invoke({
      idToken: 'token-owner',
      pharmacyId: PHARMACY_2,
      staffMemberId: 'uid_pharm2_staff',
    });
    expect(res.status).toBe(403);
  });
});

describe('resolveStaffStoreAccess — minimum data exchange', () => {
  test('R-14 the response carries no Healthcare-only or identity fields', async () => {
    const res = await invoke({
      idToken: 'token-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    const forbidden = [
      'nationalIdNumber', 'idFrontUrl', 'idBackUrl', 'licenseDocUrl',
      'permissions', 'email', 'joinedAt', 'activatedFrom', 'phoneNormalized',
    ];
    for (const field of forbidden) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  test('R-15 Healthcare-only permission keys never cross the bridge', async () => {
    // The seeded member holds team_management and pharmacy_settings; only the
    // store_* subset may be returned.
    const res = await invoke({
      idToken: 'token-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(res.body.storePermissions).not.toContain('team_management');
    expect(res.body.storePermissions).not.toContain('pharmacy_settings');
  });

  test('R-16 a self-response is shaped identically to an owner-issued one', async () => {
    // Self-resolution is a change of WHO MAY ASK, never of what is returned.
    const asSelf = await invoke({
      idToken: 'token-staff',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    const asOwner = await invoke({
      idToken: 'token-owner',
      pharmacyId: PHARMACY,
      staffMemberId: 'uid_pharm_staff',
    });
    expect(asSelf.body).toEqual(asOwner.body);
  });
});
