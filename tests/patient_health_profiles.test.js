'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
} = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });


// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL BASE PAYLOADS
// ─────────────────────────────────────────────────────────────────────────────

// Valid full profile for uid_patient1.
const validProfile = {
  patientId:          'uid_patient1',
  dateOfBirth:        new Date('1990-01-15'),
  gender:             'male',
  bloodType:          'O+',
  allergies:          ['penicillin'],
  chronicConditions:  ['diabetes type 2'],
  currentMedications: ['metformin 500mg'],
  updatedAt:          new Date(),
  schemaVersion:      1,
};

// Seed a health profile for uid_patient1 bypassing rules — used in tests that
// need the document to pre-exist (reads, updates, deletes).
async function seedHealthProfile(data = validProfile) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'patient_health_profiles', 'uid_patient1'), data);
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// READS
// ─────────────────────────────────────────────────────────────────────────────

describe('patient_health_profiles — reads', () => {

  test('PHR-1 patient can get their own health profile', async () => {
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'patient_health_profiles', 'uid_patient1')));
  });

  test('PHR-2 patient cannot list the patient_health_profiles collection', async () => {
    // Only allow get is granted to patients — allow list is intentionally absent.
    // A list query must be denied to prevent a patient enumerating all profiles.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDocs(collection(db, 'patient_health_profiles')));
  });

  test('PHR-3 patient cannot get another user\'s health profile', async () => {
    // Seed a second profile under uid_doctor1 (rule: auth.uid must match doc ID).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'patient_health_profiles', 'uid_doctor1'), {
        ...validProfile,
        patientId: 'uid_doctor1',
      });
    });
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'patient_health_profiles', 'uid_doctor1')));
  });

  test('PHR-4 unauthenticated user cannot get any health profile', async () => {
    await seedHealthProfile();
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'patient_health_profiles', 'uid_patient1')));
  });

  test('PHR-5 admin can get any health profile (audit access)', async () => {
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'patient_health_profiles', 'uid_patient1')));
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// ACCESS CONTROL — DOCTOR AND RECEPTION
// Critical: no direct read path must exist for doctors or center staff.
// They read health data only through appointments/{id}.patientHealthSnapshot.
// ─────────────────────────────────────────────────────────────────────────────

describe('patient_health_profiles — access control (doctor and reception)', () => {

  test('PHR-6 doctor cannot directly get a patient health profile', async () => {
    // uid_doctor1 is a verified doctor (doctors/uid_doctor1 exists).
    // isDoctor() is true, but there is no allow get/read rule for doctors here.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(getDoc(doc(db, 'patient_health_profiles', 'uid_patient1')));
  });

  test('PHR-7 center receptionist cannot get a patient health profile', async () => {
    // uid_doctor2 is a receptionist of center1 — isCenterMember returns true.
    // That role grants no access to patient_health_profiles.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(getDoc(doc(db, 'patient_health_profiles', 'uid_patient1')));
  });

  test('PHR-8 doctor cannot list the patient_health_profiles collection', async () => {
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(getDocs(collection(db, 'patient_health_profiles')));
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// CREATES
// ─────────────────────────────────────────────────────────────────────────────

describe('patient_health_profiles — creates', () => {

  test('PHR-9 patient can create own profile with full valid payload', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), validProfile)
    );
  });

  test('PHR-10 patient can create own profile with minimal fields only', async () => {
    // All clinical fields are optional. Only patientId + schemaVersion are required
    // by the rule. This locks the "recommended, not required" product decision.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        patientId:     'uid_patient1',
        schemaVersion: 1,
        updatedAt:     new Date(),
      })
    );
  });

  test('PHR-11 patient cannot create a profile at another user\'s document path', async () => {
    // Document ID is uid_doctor1 but caller is uid_patient1.
    // Rule: request.auth.uid == patientId (the document wildcard).
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'patient_health_profiles', 'uid_doctor1'), {
        ...validProfile,
        patientId: 'uid_doctor1',
      })
    );
  });

  test('PHR-12 patient cannot create with patientId field not matching caller uid', async () => {
    // Correct document path (own uid), but patientId field spoofed to another uid.
    // Rule: request.resource.data.patientId == patientId (doc wildcard).
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        ...validProfile,
        patientId: 'uid_doctor1',
      })
    );
  });

  test('PHR-13 patient cannot create with schemaVersion != 1', async () => {
    // schemaVersion on create must be exactly 1.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        ...validProfile,
        schemaVersion: 2,
      })
    );
  });

  test('PHR-14 unauthenticated user cannot create a health profile', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), validProfile)
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// UPDATES
// ─────────────────────────────────────────────────────────────────────────────

describe('patient_health_profiles — updates', () => {

  test('PHR-15 patient can update allowed mutable fields (gender, bloodType)', async () => {
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        gender:    'female',
        bloodType: 'A+',
        updatedAt: new Date(),
      })
    );
  });

  test('PHR-16 patient can update allergies array', async () => {
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        allergies: ['penicillin', 'aspirin'],
        updatedAt: new Date(),
      })
    );
  });

  test('PHR-17 patient can clear a field by setting it to null', async () => {
    // Patients remove sensitive data via null — no delete operation needed.
    // This is the intended "clear my allergies" pattern.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        allergies:          null,
        chronicConditions:  null,
        currentMedications: null,
        updatedAt:          new Date(),
      })
    );
  });

  test('PHR-18 patient cannot update patientId (immutable after creation)', async () => {
    // patientId is not in the hasOnly() allowed-keys list.
    // Also fails the patientId equality guard.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        patientId: 'uid_doctor1',
        updatedAt: new Date(),
      })
    );
  });

  test('PHR-19 patient cannot update schemaVersion (immutable after creation)', async () => {
    // schemaVersion is not in the hasOnly() allowed-keys list.
    // Also fails the schemaVersion equality guard.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        schemaVersion: 2,
        updatedAt:     new Date(),
      })
    );
  });

  test('PHR-20 patient cannot update an arbitrary unknown field', async () => {
    // hasOnly() blocks any key not in the approved mutable-fields list.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        emergencyContact: 'someone',
        updatedAt:        new Date(),
      })
    );
  });

  test('PHR-21 doctor cannot update a patient health profile', async () => {
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'patient_health_profiles', 'uid_patient1'), {
        gender:    'female',
        updatedAt: new Date(),
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// DELETES
// ─────────────────────────────────────────────────────────────────────────────

describe('patient_health_profiles — deletes', () => {

  test('PHR-22 patient cannot delete their own health profile', async () => {
    // allow delete: if false — no client role can delete this collection.
    // Patients clear data by nulling fields via update (see PHR-17).
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      deleteDoc(doc(db, 'patient_health_profiles', 'uid_patient1'))
    );
  });

  test('PHR-23 admin cannot delete a health profile via client SDK', async () => {
    // allow read: if isAdmin() grants read only — no write or delete.
    // allow delete: if false applies to all callers including admin.
    // Cloud Functions (Admin SDK) bypass rules and can delete if required.
    await seedHealthProfile();
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertFails(
      deleteDoc(doc(db, 'patient_health_profiles', 'uid_patient1'))
    );
  });

});
