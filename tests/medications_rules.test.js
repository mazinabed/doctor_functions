'use strict';

/**
 * Medication vocabulary rules — Prescription Platform Phase 1 (ADR-014).
 *
 * Proves the authorization seam `canAuthorMedications(centerId)`:
 *   (isDoctor() && isCenterMember(centerId)) || isCenterAdminMember(centerId)
 *
 * and the three protections that make the model safe:
 *   - global catalog is client-read-only (no typo can become trusted data)
 *   - server-derived fields (normalizedKey/searchTokens) are unwritable
 *   - doctor self-correction cannot reach ownership/lifecycle fields
 */

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

// Seed adds: uid_doctor1 (doctors doc, owns center1, NO member doc),
//            uid_doctor2 (doctors doc + center1 member role 'receptionist'),
//            uid_center_admin (center1 member role 'center_admin', no doctors doc),
//            uid_patient1.
// This suite adds the two members the seed lacks: a clinician member and a
// nurse member, so both sides of the seam are covered.
const MED_PATH = 'medical_centers/center1/medications';

async function seedMedicationFixtures(env) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // A doctor who IS a member of center1 (the intended authoring case).
    await setDoc(doc(db, 'users', 'uid_doc_member'), { role: 'doctor' });
    await setDoc(doc(db, 'doctors', 'uid_doc_member'), { name_en: 'Dr Zainab', isActive: true });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_doc_member'), {
      uid: 'uid_doc_member', role: 'doctor', isActive: true,
    });

    // A nurse member — holds clinical_tasks in CenterPermission, and must
    // still be refused: a clinical UI permission is not prescribing authority.
    await setDoc(doc(db, 'users', 'uid_nurse'), { role: 'nurse' });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_nurse'), {
      uid: 'uid_nurse', role: 'nurse', isActive: true,
      permissions: ['clinical_tasks', 'appointments'],
    });

    // An existing medication created by uid_doc_member, with server-derived
    // fields already populated as the trigger would leave them.
    await setDoc(doc(db, MED_PATH, 'med_existing'), {
      centerId: 'center1',
      displayName: 'Moxifloxacin 0.5% Ophthalmic Solution',
      genericName: 'Moxifloxacin',
      strength: '0.5',
      strengthUnit: '%',
      dosageForm: 'Ophthalmic Solution',
      isLocal: true,
      isActive: true,
      sortOrder: 0,
      createdBy: 'uid_doc_member',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      normalizedKey: 'moxifloxacin|ophthalmic solution|0.5|%',
      searchTokens: ['mox', 'moxi', 'moxifloxacin'],
    });

    // Global catalog entry + a submission, for the read/write tests.
    await setDoc(doc(db, 'medication_catalog', 'cat_1'), {
      displayName: 'Prednisolone Acetate 1% Ophthalmic Suspension',
      status: 'active',
      source: 'admin',
      searchTokens: ['pre', 'pred', 'prednisolone'],
    });
    await setDoc(doc(db, 'medication_submissions', 'center1__med_existing'), {
      centerId: 'center1', status: 'pending', normalizedKey: 'moxifloxacin|ophthalmic solution|0.5|%',
    });

    // Phase 2 — RxNorm query cache and a materialised catalog entry.
    await setDoc(doc(db, 'rxnorm_cache', 'moxifloxacin'), {
      query: 'moxifloxacin', items: [], expiresAt: new Date(Date.now() + 3600_000),
    });
    await setDoc(doc(db, 'medication_catalog', 'rxnorm_403818'), {
      displayName: 'moxifloxacin 5 MG/ML Ophthalmic Solution',
      source: 'rxnorm', rxcui: '403818', status: 'active',
    });
  });
}

const validCreate = (createdBy) => ({
  centerId: 'center1',
  displayName: 'Amoxicillin 500mg Capsule',
  genericName: 'Amoxicillin',
  strength: '500',
  strengthUnit: 'mg',
  dosageForm: 'Capsule',
  isLocal: true,
  isActive: true,
  sortOrder: 0,
  createdBy,
  createdAt: new Date(),
});

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedDatabase(testEnv);
  await seedMedicationFixtures(testEnv);
});
afterAll(async () => { await testEnv.cleanup(); });


// ─────────────────────────────────────────────────────────────────────────────
// canAuthorMedications — who may create
// ─────────────────────────────────────────────────────────────────────────────
describe('center medications — create authority', () => {
  test('doctor who is a member of the center CAN create', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(
      setDoc(doc(db, MED_PATH, 'new_1'), validCreate('uid_doc_member')),
    );
  });

  test('center admin CAN create', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      setDoc(doc(db, MED_PATH, 'new_2'), validCreate('uid_center_admin')),
    );
  });

  test('nurse member CANNOT create despite holding clinical_tasks', async () => {
    const db = testEnv.authenticatedContext('uid_nurse').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_3'), validCreate('uid_nurse')),
    );
  });

  test('doctor who is NOT a member of this center CANNOT create', async () => {
    // uid_doctor1 owns center1 but has no member doc — isCenterMember is false.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_4'), validCreate('uid_doctor1')),
    );
  });

  test('patient CANNOT create', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_5'), validCreate('uid_patient1')),
    );
  });

  test('unauthenticated CANNOT create', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_6'), validCreate('uid_doc_member')),
    );
  });

  test('CANNOT create on behalf of another user (createdBy spoofing)', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_7'), validCreate('uid_center_admin')),
    );
  });

  test('CANNOT create with a forged normalizedKey', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_8'), {
        ...validCreate('uid_doc_member'),
        normalizedKey: 'anything|i|want|here',
      }),
    );
  });

  test('CANNOT create with forged searchTokens', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_9'), {
        ...validCreate('uid_doc_member'),
        searchTokens: ['a', 'b'],
      }),
    );
  });

  test('CANNOT create archived (isActive must be true)', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_10'), {
        ...validCreate('uid_doc_member'),
        isActive: false,
      }),
    );
  });

  test('CANNOT create with an empty displayName', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_11'), {
        ...validCreate('uid_doc_member'),
        displayName: '',
      }),
    );
  });

  test('CANNOT create into a different centerId than the path', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, MED_PATH, 'new_12'), {
        ...validCreate('uid_doc_member'),
        centerId: 'expired_center',
      }),
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Read access — reception included, non-members excluded
// ─────────────────────────────────────────────────────────────────────────────
describe('center medications — read access', () => {
  test('center member (reception) CAN read the library', async () => {
    // uid_doctor2 is a center1 member with role 'receptionist'.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(getDoc(doc(db, MED_PATH, 'med_existing')));
  });

  test('nurse member CAN read (reading vocabulary is not authoring)', async () => {
    const db = testEnv.authenticatedContext('uid_nurse').firestore();
    await assertSucceeds(getDoc(doc(db, MED_PATH, 'med_existing')));
  });

  test('non-member CANNOT read another centre library', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, MED_PATH, 'med_existing')));
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Doctor self-correction — restricted field set
// ─────────────────────────────────────────────────────────────────────────────
describe('center medications — doctor self-correction', () => {
  test('creator CAN correct identity fields on their own entry', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(
      updateDoc(doc(db, MED_PATH, 'med_existing'), {
        displayName: 'Moxifloxacin 0.5% Ophthalmic Solution (preservative free)',
        genericName: 'Moxifloxacin',
        updatedAt: new Date(),
      }),
    );
  });

  test('creator CANNOT archive their own entry (admin-only)', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { isActive: false }),
    );
  });

  test('creator CANNOT change createdBy', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { createdBy: 'uid_nurse' }),
    );
  });

  test('creator CANNOT change centerId', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { centerId: 'expired_center' }),
    );
  });

  test('creator CANNOT overwrite the server-derived normalizedKey', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { normalizedKey: 'forged|||' }),
    );
  });

  test('a different doctor CANNOT correct someone else\'s entry', async () => {
    // uid_doctor2 is a member of center1 and has a doctors doc, so passes
    // canAuthorMedications — but is not the creator, so the self-correction
    // path must still refuse.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { displayName: 'Hijacked' }),
    );
  });

  test('nurse CANNOT update at all', async () => {
    const db = testEnv.authenticatedContext('uid_nurse').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { displayName: 'Nope' }),
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Center admin curation + archive-not-delete
// ─────────────────────────────────────────────────────────────────────────────
describe('center medications — admin curation and archive', () => {
  test('center admin CAN archive', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, MED_PATH, 'med_existing'), {
        isActive: false,
        updatedAt: new Date(),
      }),
    );
  });

  test('center admin CAN restore', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, MED_PATH, 'med_existing'), {
        isActive: true,
        updatedAt: new Date(),
      }),
    );
  });

  test('center admin CANNOT overwrite server-derived fields', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertFails(
      updateDoc(doc(db, MED_PATH, 'med_existing'), { searchTokens: ['x'] }),
    );
  });

  test('nobody may delete — archive only', async () => {
    for (const uid of ['uid_center_admin', 'uid_doc_member', 'uid_admin']) {
      const db = testEnv.authenticatedContext(uid).firestore();
      await assertFails(deleteDoc(doc(db, MED_PATH, 'med_existing')));
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Global catalog + submissions
// ─────────────────────────────────────────────────────────────────────────────
describe('medication_catalog — read-only to clients', () => {
  test('signed-in user CAN read a catalog entry by id', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(getDoc(doc(db, 'medication_catalog', 'cat_1')));
  });

  test('unauthenticated CANNOT read', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'medication_catalog', 'cat_1')));
  });

  test('doctor CANNOT write to the global catalog', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, 'medication_catalog', 'forged'), {
        displayName: 'Typo Drug 5mg', status: 'active',
      }),
    );
  });

  test('center admin CANNOT write to the global catalog', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'medication_catalog', 'cat_1'), { displayName: 'Changed' }),
    );
  });

  test('even a platform admin CANNOT write from the client', async () => {
    // Promotion happens only through Cloud Functions after review (Phase 6).
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'medication_catalog', 'cat_1'), { status: 'deprecated' }),
    );
  });
});

describe('medication_submissions — admin read, no client write', () => {
  test('platform admin CAN read', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'medication_submissions', 'center1__med_existing')));
  });

  test('doctor CANNOT read', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(getDoc(doc(db, 'medication_submissions', 'center1__med_existing')));
  });

  test('nobody may write from a client', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      setDoc(doc(db, 'medication_submissions', 'forged'), { status: 'approved' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — RxNorm cache and materialised catalog entries
// ─────────────────────────────────────────────────────────────────────────────
describe('rxnorm_cache — server-only', () => {
  test('no client may read the raw cache', async () => {
    // Results reach clients only through searchRxNormMedications, which applies
    // the source boundary, ranking and the degraded-source contract. Reading
    // the cache directly would bypass all three.
    for (const uid of ['uid_doc_member', 'uid_center_admin', 'uid_admin']) {
      const db = testEnv.authenticatedContext(uid).firestore();
      await assertFails(getDoc(doc(db, 'rxnorm_cache', 'moxifloxacin')));
    }
  });

  test('no client may write the cache', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      setDoc(doc(db, 'rxnorm_cache', 'forged'), { query: 'x', items: [] }),
    );
  });
});

describe('materialised RxNorm catalog entries', () => {
  test('a signed-in clinician CAN read one by id', async () => {
    // This is the point of materialisation: once picked, the medication is
    // served from Firestore rather than RxNav.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(getDoc(doc(db, 'medication_catalog', 'rxnorm_403818')));
  });

  test('a client still CANNOT write one directly', async () => {
    // materializeRxNormMedication re-reads the name from RxNorm server-side, so
    // no client can inject a medication name into the global catalog.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(
      setDoc(doc(db, 'medication_catalog', 'rxnorm_999999'), {
        displayName: 'Forged Drug 5mg', source: 'rxnorm', rxcui: '999999',
      }),
    );
  });

  test('a client CANNOT tamper with an existing materialised entry', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertFails(
      updateDoc(doc(db, 'medication_catalog', 'rxnorm_403818'), {
        displayName: 'Tampered',
      }),
    );
  });
});
