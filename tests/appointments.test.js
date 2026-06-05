'use strict';

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } = require('firebase/firestore');
const { createTestEnv, seedDatabase, FUTURE } = require('./helpers');

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

// ─────────────────────────────────────────────────────────────────────────────
// CREATES — Phase 3: health snapshot validation
// ─────────────────────────────────────────────────────────────────────────────

describe('appointments — health snapshot (Phase 3)', () => {

  test('APH-1 patient self-book with null patientHealthSnapshot is accepted', async () => {
    // null = missing health profile. Path A rule: validHealthSnapshot(null) === true.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_aph1'), {
        ...patientApptBase,
        patientHealthSnapshot: null,
        slotId: 'slot_aph1',
      })
    );
  });

  test('APH-2 patient self-book with a valid health snapshot is accepted', async () => {
    // schemaVersion 1, no dateOfBirth → validHealthSnapshot returns true.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_aph2'), {
        ...patientApptBase,
        patientHealthSnapshot: {
          ageAtAppointment: 34,
          gender:           'male',
          bloodType:        'O+',
          allergies:        ['penicillin'],
          chronicConditions:  [],
          currentMedications: [],
          schemaVersion:    1,
          snapshotAt:       new Date(),
        },
        slotId: 'slot_aph2',
      })
    );
  });

  test('APH-3 patient booking with snapshot containing dateOfBirth is rejected', async () => {
    // DOB must never be stored in an appointment document.
    // validHealthSnapshot rejects any map whose keys include dateOfBirth.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_aph3'), {
        ...patientApptBase,
        patientHealthSnapshot: {
          dateOfBirth:   new Date('1990-01-15'), // forbidden
          gender:        'male',
          schemaVersion: 1,
        },
        slotId: 'slot_aph3',
      })
    );
  });

  test('APH-4 patient booking with snapshot schemaVersion != 1 is rejected', async () => {
    // validHealthSnapshot requires schemaVersion == 1.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_aph4'), {
        ...patientApptBase,
        patientHealthSnapshot: {
          gender:        'male',
          schemaVersion: 2,   // wrong version
        },
        slotId: 'slot_aph4',
      })
    );
  });

  test('APH-5 Path B (walk-in) booking with non-null snapshot is rejected', async () => {
    // Reception has no access to patient_health_profiles.
    // Path B rule enforces patientHealthSnapshot == null unconditionally.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_aph5'), {
        ...walkInApptBase,
        patientHealthSnapshot: { gender: 'male', schemaVersion: 1 },
        slotId: 'slot_aph5',
      })
    );
  });

  test('APH-6 doctor cannot update patientHealthSnapshot after creation (immutable)', async () => {
    // patientHealthSnapshot is in appointmentCoreUnchanged() — locked after write.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), {
        patientHealthSnapshot: { gender: 'female', schemaVersion: 1 },
      })
    );
  });

});


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

// ─────────────────────────────────────────────────────────────────────────────
// 7. appointments — paymentStatus update (unpaid → paid)
// ─────────────────────────────────────────────────────────────────────────────
describe('7. appointments — paymentStatus update', () => {

  const validPaymentUpdate = (uid) => ({
    paymentStatus:            'paid',
    paymentStatusUpdatedAt:   new Date(),
    paymentStatusUpdatedBy:   uid,
    updatedAt:                new Date(),
  });

  test('7.1 center staff (receptionist) can mark unpaid → paid with all audit fields', async () => {
    // uid_doctor2 is a receptionist member of center1; appt1 is unpaid.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'appointments', 'appt1'), validPaymentUpdate('uid_doctor2'))
    );
  });

  test('7.2 center staff cannot mark paid without audit fields', async () => {
    // Only paymentStatus written — required audit fields missing → hasOnly fails.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), { paymentStatus: 'paid' })
    );
  });

  test('7.3 center staff cannot omit paymentStatusUpdatedBy', async () => {
    // Partial audit fields: missing paymentStatusUpdatedBy → hasOnly fails.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), {
        paymentStatus:          'paid',
        paymentStatusUpdatedAt: new Date(),
        updatedAt:              new Date(),
      })
    );
  });

  test('7.4 doctor cannot update paymentStatus (view-only)', async () => {
    // uid_doctor1 owns appt1 but the doctor rule now excludes paymentStatus fields.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), validPaymentUpdate('uid_doctor1'))
    );
  });

  test('7.5 non-member cannot mark as paid', async () => {
    // uid_patient1 has no membership in center1 (only uid_doctor2 + uid_center_admin are seeded).
    // appt1 belongs to center1 → isCenterMember(center1) is false for uid_patient1.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), validPaymentUpdate('uid_patient1'))
    );
  });

  test('7.6 already-paid appointment cannot be marked paid again', async () => {
    // Seed an appointment that is already paid.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'appointments', 'appt_paid'), {
        patientId: 'uid_patient1', doctorId: 'uid_doctor1', centerId: 'center1',
        source: 'patient_app', status: 'confirmed', visitStatus: 'waiting',
        paymentStatus: 'paid',
        bookedByUserId: 'uid_patient1', bookedByRole: 'patient',
        slotId: 'slot_paid', createdAt: new Date(), appointmentAt: new Date(),
      });
    });
    // isPaymentStatusUpdate checks resource.data.paymentStatus == 'unpaid' → fails.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt_paid'), validPaymentUpdate('uid_doctor2'))
    );
  });

  test('7.7 center staff cannot set arbitrary paymentStatus value', async () => {
    // rule enforces request.resource.data.paymentStatus == 'paid' exactly.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      updateDoc(doc(db, 'appointments', 'appt1'), {
        paymentStatus:          'refunded',
        paymentStatusUpdatedAt: new Date(),
        paymentStatusUpdatedBy: 'uid_doctor2',
        updatedAt:              new Date(),
      })
    );
  });

});


// ─────────────────────────────────────────────────────────────────────────────
// 8. appointments — Path B paid-at-creation (reception booking with payment)
// ─────────────────────────────────────────────────────────────────────────────
describe('8. appointments — Path B paid-at-creation', () => {

  // Minimal valid Path B base (walk-in, unpaid by default)
  const pathBBase = (uid) => ({
    patientId:      null,
    doctorId:       'uid_doctor1',
    centerId:       'center1',
    source:         'walk_in',
    status:         'confirmed',
    visitStatus:    'waiting',
    paymentStatus:  'unpaid',
    bookedByUserId: uid,
    bookedByRole:   'doctor',
    appointmentAt:  new Date(),
    dateKey:        '2026-07-01',
    slotId:         'slot_new8',
    createdAt:      new Date(),
  });

  test('8.1 center staff can create walk-in with paymentStatus unpaid (baseline)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_b_unpaid'), pathBBase('uid_doctor2'))
    );
  });

  test('8.2 center staff can create walk-in with paymentStatus paid and audit fields', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'appointments', 'appt_b_paid'), {
        ...pathBBase('uid_doctor2'),
        paymentStatus:          'paid',
        paymentStatusUpdatedBy: 'uid_doctor2',
        paymentStatusUpdatedAt: new Date(),
        paymentMethod:          'front_desk_cash',
      })
    );
  });

  test('8.3 center staff cannot create with paymentStatus paid but wrong updatedBy', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_b_spoofed'), {
        ...pathBBase('uid_doctor2'),
        paymentStatus:          'paid',
        paymentStatusUpdatedBy: 'uid_other',   // spoofed — not the caller
        paymentStatusUpdatedAt: new Date(),
        paymentMethod:          'front_desk_cash',
      })
    );
  });

  test('8.4 center staff cannot create with paymentStatus paid but wrong paymentMethod', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_b_bad_method'), {
        ...pathBBase('uid_doctor2'),
        paymentStatus:          'paid',
        paymentStatusUpdatedBy: 'uid_doctor2',
        paymentStatusUpdatedAt: new Date(),
        paymentMethod:          'bank_transfer',   // not front_desk_cash
      })
    );
  });

  test('8.5 patient cannot create appointment with paymentStatus paid (Path A enforces unpaid)', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'appointments', 'appt_a_paid'), {
        patientId:      'uid_patient1',
        doctorId:       'uid_doctor1',
        centerId:       'center1',
        source:         'patient_app',
        status:         'pending',
        visitStatus:    'waiting',
        paymentStatus:  'paid',                    // Path A rule: must be 'unpaid'
        bookedByUserId: 'uid_patient1',
        bookedByRole:   'patient',
        appointmentAt:  new Date(),
        dateKey:        '2026-07-01',
        slotId:         'slot_pa_paid',
        createdAt:      new Date(),
        patientHealthSnapshot: null,
      })
    );
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 5. doctors/{uid} — center admin read access (ManageDoctors tab)
// ─────────────────────────────────────────────────────────────────────────────
describe('5. doctors/{uid} — center admin read access', () => {

  test('5.1 patient cannot read a private doctor document', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, 'doctors', 'uid_doctor1')));
  });

  test('5.2 center admin (non-doctor) can read a doctor document', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(getDoc(doc(db, 'doctors', 'uid_doctor1')));
  });

  test('5.3 center admin can list doctors by centerId (approvedDoctors query)', async () => {
    // Seed a doctor doc with centerId so the query has a match.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const { doc: d, setDoc: s } = require('firebase/firestore');
      await s(d(ctx.firestore(), 'doctors', 'uid_doctor1'), { centerId: 'center1', name_en: 'Dr Ali' });
    });
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      getDocs(query(collection(db, 'doctors'), where('centerId', '==', 'center1')))
    );
  });

  test('5.4 patient cannot list doctors by centerId', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      getDocs(query(collection(db, 'doctors'), where('centerId', '==', 'center1')))
    );
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 6. approve join request flow — Firestore rules for each write
// ─────────────────────────────────────────────────────────────────────────────
describe('6. approve join request — individual write permissions', () => {

  // ── doctors/{uid} link update ────────────────────────────────────────────

  test('6.1 center owner can update doctor centerId/centerJoinStatus (link fields only)', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'doctors', 'uid_doctor2'), {
        centerId: 'center1',
        centerJoinStatus: 'approved',
        centerJoinApprovedAt: new Date(),
      })
    );
  });

  test('6.2 center owner cannot update admin-protected fields on another doctor', async () => {
    // uid_doctor2 seed has no canBook field, so setting it produces a real diff entry.
    // isDoctorCenterLinkUpdate hasOnly check fails → the whole update is denied.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor2'), {
        centerId: 'center1',
        centerJoinStatus: 'approved',
        canBook: true,  // admin-protected field — must be rejected
      })
    );
  });

  test('6.3 patient cannot update doctor link fields', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'doctors', 'uid_doctor1'), {
        centerId: 'center1',
        centerJoinStatus: 'approved',
        centerJoinApprovedAt: new Date(),
      })
    );
  });

  test('6.4 scoped center admin can update doctor link fields', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'doctors', 'uid_doctor2'), {
        centerId: 'center1',
        centerJoinStatus: 'approved',
        centerJoinApprovedAt: new Date(),
      })
    );
  });

  // ── center_join_requests update ───────────────────────────────────────────

  test('6.5 center owner can update join request status to approved', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'center_join_requests', 'req1'), {
        status: 'approved',
        updatedAt: new Date(),
      })
    );
  });

  test('6.6 scoped center admin can update join request status', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'center_join_requests', 'req1'), {
        status: 'approved',
        updatedAt: new Date(),
      })
    );
  });

  test('6.7 patient cannot update a join request', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'center_join_requests', 'req1'), {
        status: 'approved',
      })
    );
  });

  // ── medical_centers/members set ───────────────────────────────────────────

  test('6.8 center owner can set a member doc for a doctor', async () => {
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'), {
        uid: 'uid_doctor2',
        role: 'doctor',
        isActive: true,
        joinedAt: new Date(),
      })
    );
  });

  test('6.9 scoped center admin can set a member doc', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'), {
        uid: 'uid_doctor2',
        role: 'doctor',
        isActive: true,
        joinedAt: new Date(),
      })
    );
  });

  test('6.10 patient cannot set a member doc', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      setDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'), {
        uid: 'uid_doctor2',
        role: 'doctor',
        isActive: true,
      })
    );
  });

});
