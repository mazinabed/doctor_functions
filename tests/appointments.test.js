'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });

// Base valid patient-app appointment for create tests
const patientApptBase = {
  patientId:      'uid_patient1',
  doctorId:       'uid_doctor1',
  centerId:       'center1',
  source:         'patient_app',
  status:         'pending',
  visitStatus:    'scheduled',
  paymentStatus:  'unpaid',
  bookedByUserId: 'uid_patient1',
  bookedByRole:   'patient',
  appointmentAt:  new Date('2026-07-01T10:00:00Z'),
  dateKey:        '2026-07-01',
  slotId:         'slot_new',
  createdAt:      new Date(),
};

describe('appointments — reads', () => {
  test('4.1 patient can read their own appointment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt1')));
  });

  test('4.2 doctor can read their own appointment', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt1')));
  });

  test('4.3 center member (receptionist) can read appointment for their center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt1')));
  });

  test('4.4 unauthenticated cannot read any appointment', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'appointments', 'appt1')));
  });

  test('4.5 admin can read any appointment', async () => {
    const db = testEnv.authenticatedContext('uid_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt1')));
  });
});

describe('appointments — creates (Path A: patient self-booking)', () => {
  test('4.6 patient can create a valid self-booked appointment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_new1'), patientApptBase)
    );
  });

  test('4.7 patient cannot spoof bookedByRole as doctor', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_new2'), {
        ...patientApptBase,
        bookedByRole: 'doctor',
      })
    );
  });
});

describe('appointments — creates (Path B: reception walk-in)', () => {
  test('4.8 center member can create a walk_in appointment', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_walkin'), {
        patientId:      'uid_patient1',
        doctorId:       'uid_doctor1',
        centerId:       'center1',
        source:         'walk_in',
        status:         'pending',
        visitStatus:    'scheduled',
        paymentStatus:  'unpaid',
        bookedByUserId: 'uid_doctor2',
        bookedByRole:   'receptionist',
        appointmentAt:  new Date('2026-07-01T11:00:00Z'),
        dateKey:        '2026-07-01',
        slotId:         'slot_walkin',
        createdAt:      new Date(),
      })
    );
  });

  test('4.9 non-center-member cannot create a walk_in appointment', async () => {
    // uid_doctor1 owns the center but is not listed in members subcollection
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_denied'), {
        patientId:      'uid_patient1',
        doctorId:       'uid_doctor1',
        centerId:       'center1',
        source:         'walk_in',
        status:         'pending',
        visitStatus:    'scheduled',
        paymentStatus:  'unpaid',
        bookedByUserId: 'uid_doctor1',
        bookedByRole:   'doctor',
        appointmentAt:  new Date('2026-07-01T12:00:00Z'),
        dateKey:        '2026-07-01',
        slotId:         'slot_denied',
        createdAt:      new Date(),
      })
    );
  });
});

describe('appointments — updates', () => {
  test('4.10 doctor can update non-core fields (status)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), { status: 'confirmed' })
    );
  });

  test('4.11 center member can update allowed fields (visitStatus)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), { visitStatus: 'checked_in' })
    );
  });

  test('4.12 doctor cannot change core field (doctorId)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { doctorId: 'uid_other' })
    );
  });

  test('4.13 patient can cancel their own appointment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), {
        status:      'cancelled',
        cancelledAt: new Date(),
        updatedAt:   new Date(),
      })
    );
  });

  test('4.14 patient cannot update visitStatus (not in patient allowed fields)', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { visitStatus: 'done' })
    );
  });

  test('4.15 patient cannot mark appointment as paid', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { paymentStatus: 'paid' })
    );
  });
});
