'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => { await testEnv.clearFirestore(); await seedDatabase(testEnv); });
afterAll(async () => { await testEnv.cleanup(); });


// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL BASE PAYLOADS
// Reflect the production contract as of Phase 1 rules deployment.
// ─────────────────────────────────────────────────────────────────────────────

// Path A — patient self-booking via TrustyDr-pwa
const patientApptBase = {
  patientId:      'uid_patient1',
  doctorId:       'uid_doctor1',
  centerId:       'center1',
  source:         'patient_app',
  status:         'pending',        // Path A always creates as pending
  visitStatus:    'waiting',        // Phase 1: 'scheduled' is rejected by rules
  paymentStatus:  'unpaid',
  bookedByUserId: 'uid_patient1',
  bookedByRole:   'patient',
  appointmentAt:  new Date('2026-07-01T10:00:00Z'),
  dateKey:        '2026-07-01',
  slotId:         'slot_patient',
  createdAt:      new Date(),
};

// Path B — walk-in (no registered patient account)
const walkInApptBase = {
  patientId:      null,             // canonical: null — never a sentinel string
  doctorId:       'uid_doctor1',
  centerId:       'center1',
  source:         'walk_in',
  status:         'confirmed',      // walk-in is always confirmed at creation
  visitStatus:    'waiting',        // Phase 1: 'scheduled' is rejected by rules
  paymentStatus:  'unpaid',
  bookedByUserId: 'uid_doctor2',    // uid_doctor2 is a center member
  bookedByRole:   'doctor',         // users/uid_doctor2.role == 'doctor'
  appointmentAt:  new Date('2026-07-01T11:00:00Z'),
  dateKey:        '2026-07-01',
  slotId:         'slot_walkin',
  createdAt:      new Date(),
};

// Path B — reception (known registered patient, booked by staff)
const receptionApptBase = {
  patientId:      'uid_patient1',   // real UID — known patient
  doctorId:       'uid_doctor1',
  centerId:       'center1',
  source:         'reception',
  status:         'confirmed',      // reception is always confirmed at creation
  visitStatus:    'waiting',
  paymentStatus:  'unpaid',
  bookedByUserId: 'uid_doctor2',    // uid_doctor2 is a center member
  bookedByRole:   'doctor',         // users/uid_doctor2.role == 'doctor'
  appointmentAt:  new Date('2026-07-01T12:00:00Z'),
  dateKey:        '2026-07-01',
  slotId:         'slot_reception',
  createdAt:      new Date(),
};


// ─────────────────────────────────────────────────────────────────────────────
// READS
// ─────────────────────────────────────────────────────────────────────────────

describe('appointments — reads', () => {

  test('4.1 patient can read their own appointment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt1')));
  });

  test('4.2 doctor can read their own appointment', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt1')));
  });

  test('4.3 center member can read appointment for their center', async () => {
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

  test('4.6 [Phase 1] pre-write resource==null read succeeds for authenticated user', async () => {
    // AppointmentBuilder.create() calls tx.get(docRef) before writing.
    // Phase 1 added resource == null as the first branch of the read rule so
    // this non-existent-doc read never 403s during a transaction.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt_does_not_exist')));
  });

  test('4.7 walk-in appointment (patientId null) is NOT readable by a third-party patient', async () => {
    // patientId null means resource.data.patientId == request.auth.uid is false.
    // The patient branch of the read rule does not grant access to walk-in docs.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'appointments', 'appt_walkin_r'), {
        ...walkInApptBase,
        slotId: 'slot_walkin_r',
      });
    });
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'appointments', 'appt_walkin_r')));
  });

  test('4.8 walk-in appointment (patientId null) IS readable by center member', async () => {
    // isCenterMember branch covers center staff regardless of patientId value.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'appointments', 'appt_walkin_r2'), {
        ...walkInApptBase,
        slotId: 'slot_walkin_r2',
      });
    });
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(getDoc(doc(db, 'appointments', 'appt_walkin_r2')));
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// CREATES — Path A (patient self-booking)
// ─────────────────────────────────────────────────────────────────────────────

describe('appointments — creates (Path A: patient self-booking)', () => {

  test('4.9 patient can create a valid self-booked appointment', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_pa_ok'), patientApptBase)
    );
  });

  test('4.10 [Phase 1 regression] patient self-book with visitStatus scheduled is rejected', async () => {
    // Before Phase 1, visitStatus 'scheduled' was accepted.
    // Phase 1 rule change: visitStatus == 'waiting' is the only valid creation value.
    // This test locks that behaviour so a rules regression is immediately caught.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_pa_sched'), {
        ...patientApptBase,
        visitStatus: 'scheduled',
        slotId:      'slot_pa_sched',
      })
    );
  });

  test('4.11 patient cannot spoof bookedByRole as doctor', async () => {
    // Path A rule checks bookedByRole == 'patient' explicitly.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_pa_role'), {
        ...patientApptBase,
        bookedByRole: 'doctor',
        slotId:       'slot_pa_role',
      })
    );
  });

  test('4.12 patient cannot create with status confirmed on Path A', async () => {
    // Path A rule enforces status == 'pending'.
    // Confirmed appointments are only created by Path B (reception/walk-in).
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_pa_conf'), {
        ...patientApptBase,
        status: 'confirmed',
        slotId: 'slot_pa_conf',
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// CREATES — Path B (walk-in and reception)
// ─────────────────────────────────────────────────────────────────────────────

describe('appointments — creates (Path B: walk-in)', () => {

  test('4.13 center member can create a walk-in appointment (patientId null, status confirmed)', async () => {
    // Canonical walk-in: patientId is null (never 'walk_in' sentinel),
    // status is confirmed, visitStatus is waiting.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_wi_ok'), walkInApptBase)
    );
  });

  test('4.14 center member can create a reception appointment (known patient, status confirmed)', async () => {
    // Source 'reception' with a real patientId — staff books for a registered patient.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_rec_ok'), receptionApptBase)
    );
  });

  test('4.15 [Phase 1 regression] walk-in with visitStatus scheduled is rejected', async () => {
    // Path B also requires visitStatus == 'waiting'. 'scheduled' is retired.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_wi_sched'), {
        ...walkInApptBase,
        visitStatus: 'scheduled',
        slotId:      'slot_wi_sched',
      })
    );
  });

  test('4.16 non-center-member cannot create a walk-in appointment', async () => {
    // uid_doctor1 owns center1 but has no entry in the members subcollection.
    // isCenterMember() checks members/{uid} existence — ownership alone is not enough.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_wi_denied'), {
        ...walkInApptBase,
        bookedByUserId: 'uid_doctor1',
        slotId:         'slot_wi_denied',
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// UPDATES
// ─────────────────────────────────────────────────────────────────────────────

describe('appointments — updates', () => {

  test('4.17 doctor can update non-core fields (status)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), { status: 'confirmed' })
    );
  });

  test('4.18 center member can update visitStatus to in_service', async () => {
    // in_service is the canonical active-visit value (replaces retired checked_in).
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), { visitStatus: 'in_service' })
    );
  });

  test('4.19 center member can update visitStatus to no_show', async () => {
    // no_show is a canonical terminal visitStatus — patient did not arrive.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), { visitStatus: 'no_show' })
    );
  });

  test('4.20 doctor cannot change core field (doctorId)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { doctorId: 'uid_other' })
    );
  });

  test('4.21 patient can cancel with status cancelled (two l\'s)', async () => {
    // Production rule enforces status == 'cancelled' (British spelling, two l's).
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), {
        status:      'cancelled',
        cancelledAt: new Date(),
        updatedAt:   new Date(),
      })
    );
  });

  test('4.22 patient cancel with status canceled (one l) is rejected by rule', async () => {
    // The patient app historically wrote 'canceled' (one l). The Firestore rule
    // enforces 'cancelled' (two l's). This test locks that contract.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), {
        status:      'canceled',   // one l — rule rejects this
        cancelledAt: new Date(),
        updatedAt:   new Date(),
      })
    );
  });

  test('4.23 patient cannot update visitStatus (not in patient allowed fields)', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { visitStatus: 'done' })
    );
  });

  test('4.24 patient cannot mark appointment as paid', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { paymentStatus: 'paid' })
    );
  });

});
