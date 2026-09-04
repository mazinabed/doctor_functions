'use strict';

// Center Reception -> New Appointment, staff account.
//
// A receptionist/nurse/technician/manager is an active member of the center but
// has no doctors/{uid} document and no users.centerRole == 'center_admin', so
// before the isActiveCenterMember() clauses every disjunct of the `doctors` and
// `schedules` read rules was false. The booking dialog's doctor list failed with
// permission-denied, no doctor could be selected, and Confirm stayed disabled.
//
// These tests use the EXACT query shapes the Doctor Portal issues:
//   centerDoctorsProvider  -> doctors.where('centerId', '==', centerId)
//   getPublishedShifts     -> schedules.where(doctorId).where(centerId).where(status)

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, getDocs, collection, query, where,
} = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

const doctorsInCenter = (db, centerId) =>
  getDocs(query(collection(db, 'doctors'), where('centerId', '==', centerId)));

const shiftsFor = (db, doctorId, centerId, status) =>
  getDocs(query(
    collection(db, 'schedules'),
    where('doctorId', '==', doctorId),
    where('centerId', '==', centerId),
    where('status', '==', status),
  ));

describe('reception staff — doctors read', () => {
  test('R-1 staff CAN list doctors of their own center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertSucceeds(doctorsInCenter(db, 'center1'));
  });

  test('R-2 staff CAN get a single doctor of their own center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertSucceeds(getDoc(doc(db, 'doctors', 'uid_center_doctor')));
  });

  test('R-3 staff CANNOT list doctors of another center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertFails(doctorsInCenter(db, 'center2'));
  });

  test('R-4 staff CANNOT get a doctor belonging to another center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertFails(getDoc(doc(db, 'doctors', 'uid_center2_doctor')));
  });

  test('R-5 staff CANNOT list all doctors (no centerId filter)', async () => {
    // The grant is scoped to the doctor's own centerId. An unfiltered list is
    // not provable to the rules engine and must stay denied — this is what
    // keeps the fix from becoming a broad staff read across every doctor.
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertFails(getDocs(collection(db, 'doctors')));
  });

  test('R-6 DEACTIVATED staff CANNOT list doctors of that center', async () => {
    const db = testEnv.authenticatedContext('uid_inactive_staff').firestore();
    await assertFails(doctorsInCenter(db, 'center1'));
  });

  test('R-7 non-member signed-in user CANNOT list doctors of a center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(doctorsInCenter(db, 'center1'));
  });

  test('R-8 unauthenticated CANNOT list doctors of a center', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(doctorsInCenter(db, 'center1'));
  });
});

describe('reception staff — schedules read', () => {
  test('R-9 staff CAN list published shifts for a doctor in their own center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertSucceeds(shiftsFor(db, 'uid_center_doctor', 'center1', 'published'));
  });

  test('R-10 staff CAN get a published schedule of their own center', async () => {
    // sched_c1_published has isActive:false, so the pre-existing public
    // "published && isActive" clause cannot be what allows this.
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertSucceeds(getDoc(doc(db, 'schedules', 'sched_c1_published')));
  });

  test('R-11 staff CANNOT read an unpublished (draft) schedule of their own center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertFails(getDoc(doc(db, 'schedules', 'sched_c1_draft')));
  });

  test('R-12 staff CANNOT list draft shifts of their own center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertFails(shiftsFor(db, 'uid_center_doctor', 'center1', 'draft'));
  });

  test('R-13 staff CANNOT read published schedules of another center', async () => {
    const db = testEnv.authenticatedContext('uid_center_staff').firestore();
    await assertFails(getDoc(doc(db, 'schedules', 'sched_c2_published')));
    await assertFails(shiftsFor(db, 'uid_center2_doctor', 'center2', 'published'));
  });

  test('R-14 DEACTIVATED staff CANNOT read published schedules of that center', async () => {
    const db = testEnv.authenticatedContext('uid_inactive_staff').firestore();
    await assertFails(getDoc(doc(db, 'schedules', 'sched_c1_published')));
  });

  test('R-15 non-member signed-in user CANNOT read a published-but-inactive schedule', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'schedules', 'sched_c1_published')));
  });
});

describe('reception staff — owner/doctor path unchanged', () => {
  test('R-16 owning doctor still reads their own draft schedule', async () => {
    const db = testEnv.authenticatedContext('uid_center_doctor').firestore();
    await assertSucceeds(getDoc(doc(db, 'schedules', 'sched_c1_draft')));
  });

  test('R-17 any doctor still reads doctor profiles (isDoctor path intact)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'doctors', 'uid_center2_doctor')));
  });

  test('R-18 center_admin still lists doctors of their center (isCenterAdmin path intact)', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(doctorsInCenter(db, 'center1'));
  });

  test('R-19 public guest still reads published+active schedules', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, 'schedules', 'sched1')));
  });
});
