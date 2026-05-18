'use strict';

/**
 * Phase 1 — centerIsOperational enforcement regression tests.
 *
 * Tests that expired centers block schedule create/update and appointment
 * create (Path A patient + Path B reception), while leaving reads, deletes,
 * and appointment updates unaffected.
 *
 * Mirrors centerAccessProvider date-only logic: a center is operational when
 * request.time < trialEnds  OR  request.time < subscriptionEnd  OR  request.time < gracePeriodEnds.
 */

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, getDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase, FUTURE } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULES — CREATE
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — schedules: create gated by centerIsOperational', () => {

  test('P1-1 ALLOW doctor create schedule in ACTIVE center (trialEnds future)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'schedules', 'new_sched_active'), {
        doctorId: 'uid_doctor1',
        centerId: 'center1',
        status: 'draft',
        isActive: false,
      })
    );
  });

  test('P1-2 DENY doctor create schedule in EXPIRED center (all dates past)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      setDoc(doc(db, 'schedules', 'new_sched_expired'), {
        doctorId: 'uid_doctor1',
        centerId: 'expired_center',
        status: 'draft',
        isActive: false,
      })
    );
  });

  test('P1-3 ALLOW doctor create schedule in GRACE PERIOD center (gracePeriodEnds future)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'schedules', 'new_sched_grace'), {
        doctorId: 'uid_doctor1',
        centerId: 'grace_center',
        status: 'draft',
        isActive: false,
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULES — UPDATE
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — schedules: update gated by centerIsOperational', () => {

  test('P1-4 ALLOW doctor update schedule in ACTIVE center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'schedules', 'sched2'), { status: 'published' })
    );
  });

  test('P1-5 DENY doctor update schedule in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'schedules', 'sched_expired'), { status: 'published' })
    );
  });

  test('P1-6 ALLOW doctor update schedule in GRACE PERIOD center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'schedules', 'sched_grace'), { status: 'published' })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULES — DELETE (must stay open for expired centers — cleanup path)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — schedules: delete remains allowed for expired centers', () => {

  test('P1-7 ALLOW doctor delete schedule from EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      deleteDoc(doc(db, 'schedules', 'sched_expired'))
    );
  });

  test('P1-8 ALLOW doctor delete schedule from ACTIVE center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      deleteDoc(doc(db, 'schedules', 'sched1'))
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULES — READ (must stay open regardless of center operational state)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — schedules: reads unaffected by operational state', () => {

  test('P1-9 ALLOW doctor read own schedule in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      getDoc(doc(db, 'schedules', 'sched_expired'))
    );
  });

  test('P1-10 ALLOW public read of published+active schedule regardless of center state', async () => {
    // sched1 is status=published, isActive=true in center1 (active). Public guest should see it.
    const db = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(
      getDoc(doc(db, 'schedules', 'sched1'))
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// APPOINTMENTS — Path A (patient self-booking)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — appointments Path A: patient booking gated by centerIsOperational', () => {

  const patientBase = {
    patientId:      'uid_patient1',
    doctorId:       'uid_doctor1',
    source:         'patient_app',
    status:         'pending',
    visitStatus:    'waiting',
    paymentStatus:  'unpaid',
    bookedByUserId: 'uid_patient1',
    bookedByRole:   'patient',
    appointmentAt:  new Date('2026-08-01T10:00:00Z'),
    dateKey:        '2026-08-01',
    slotId:         'slot_test',
    createdAt:      new Date(),
  };

  test('P1-11 ALLOW patient book appointment in ACTIVE center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_pa_active'), {
        ...patientBase,
        centerId: 'center1',
        slotId: 'slot_pa_active',
      })
    );
  });

  test('P1-12 DENY patient book appointment in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_pa_expired'), {
        ...patientBase,
        centerId: 'expired_center',
        slotId: 'slot_pa_exp',
      })
    );
  });

  test('P1-13 ALLOW patient book appointment in GRACE PERIOD center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_pa_grace'), {
        ...patientBase,
        centerId: 'grace_center',
        slotId: 'slot_pa_grace',
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// APPOINTMENTS — Path B (reception / walk-in)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — appointments Path B: walk-in gated by centerIsOperational', () => {

  const walkInBase = {
    patientId:      null,
    doctorId:       'uid_doctor1',
    source:         'walk_in',
    status:         'confirmed',
    visitStatus:    'waiting',
    paymentStatus:  'unpaid',
    bookedByUserId: 'uid_doctor2',
    bookedByRole:   'doctor',
    appointmentAt:  new Date('2026-08-01T11:00:00Z'),
    dateKey:        '2026-08-01',
    createdAt:      new Date(),
  };

  test('P1-14 ALLOW center member walk-in booking in ACTIVE center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_wi_active'), {
        ...walkInBase,
        centerId: 'center1',
        slotId: 'slot_wi_active',
      })
    );
  });

  test('P1-15 DENY center member walk-in booking in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_wi_expired'), {
        ...walkInBase,
        centerId: 'expired_center',
        slotId: 'slot_wi_exp',
      })
    );
  });

  test('P1-16 DENY reception booking in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_rec_expired'), {
        ...walkInBase,
        patientId: 'uid_patient1',
        source: 'reception',
        centerId: 'expired_center',
        slotId: 'slot_rec_exp',
      })
    );
  });

  test('P1-17 ALLOW center member walk-in booking in GRACE PERIOD center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_wi_grace'), {
        ...walkInBase,
        centerId: 'grace_center',
        slotId: 'slot_wi_grace',
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// APPOINTMENTS — UPDATES (no operational gate — must stay open for expired centers)
// Existing appointments in expired centers must still be updatable by doctors
// and patients. The operational gate only blocks NEW writes, not operational ops.
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — appointments: updates unaffected by expired center state', () => {

  test('P1-18 ALLOW doctor update existing appointment in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt_expired'), {
        visitStatus: 'in_service',
        updatedAt: new Date(),
      })
    );
  });

  test('P1-19 ALLOW patient cancel existing appointment in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt_expired'), {
        status: 'cancelled',
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
    );
  });

  test('P1-20 ALLOW center member update appointment in EXPIRED center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt_expired'), {
        visitStatus: 'no_show',
        updatedAt: new Date(),
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION — existing active-center tests must still pass
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1 — regression: active center path unchanged', () => {

  test('P1-21 existing appointment create Path A still works for active center', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_regression_pa'), {
        patientId:      'uid_patient1',
        doctorId:       'uid_doctor1',
        centerId:       'center1',
        source:         'patient_app',
        status:         'pending',
        visitStatus:    'waiting',
        paymentStatus:  'unpaid',
        bookedByUserId: 'uid_patient1',
        bookedByRole:   'patient',
        appointmentAt:  new Date('2026-09-01T10:00:00Z'),
        dateKey:        '2026-09-01',
        slotId:         'slot_reg_pa',
        createdAt:      new Date(),
      })
    );
  });

  test('P1-22 existing schedule create still works for active center', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'schedules', 'sched_regression'), {
        doctorId: 'uid_doctor1',
        centerId: 'center1',
        status: 'draft',
        isActive: false,
      })
    );
  });

});
