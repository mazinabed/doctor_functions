'use strict';

const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'doctorapp-7e8b3';
const RULES_PATH = path.resolve(__dirname, '../firestore.rules');

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);


async function createTestEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
}

async function seedDatabase(testEnv) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // users
    await setDoc(doc(db, 'users', 'uid_admin'),        { role: 'admin' });
    await setDoc(doc(db, 'users', 'uid_patient1'),     { role: 'patient', phone: '07701234567' });
    await setDoc(doc(db, 'users', 'uid_doctor1'),      { role: 'doctor' });
    await setDoc(doc(db, 'users', 'uid_doctor2'),      { role: 'doctor' });
    // Non-doctor center admin: centerRole='center_admin', no doctors/{uid} doc.
    await setDoc(doc(db, 'users', 'uid_center_admin'), { role: 'receptionist', centerRole: 'center_admin', centerId: 'center1' });

    // doctors
    await setDoc(doc(db, 'doctors', 'uid_doctor1'), {
      name_en: 'Dr Ali',
      isActive: true,
      subscriptionStatus: 'trial',
      isPaidUser: false,
      verificationStatus: 'pending',
      canBook: false,
      canCall: false,
      status: 'pending',
    });
    await setDoc(doc(db, 'doctors', 'uid_doctor2'), {
      name_en: 'Dr Sara',
      isActive: true,
    });

    // medical_centers + members
    // center1: active — trialEnds in future so centerIsOperational returns true.
    await setDoc(doc(db, 'medical_centers', 'center1'), {
      ownerId: 'uid_doctor1',
      isActive: true,
      subscriptionStatus: 'active',
      name_en: 'Test Center',
      trialEnds: FUTURE,
    });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'), {
      uid: 'uid_doctor2',
      role: 'receptionist',
      isActive: true,
    });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_center_admin'), {
      uid: 'uid_center_admin',
      role: 'center_admin',
      isActive: true,
    });

    // expired_center: all date windows expired — centerIsOperational returns false.
    await setDoc(doc(db, 'medical_centers', 'expired_center'), {
      ownerId: 'uid_doctor1',
      isActive: true,
      trialEnds: PAST,
      subscriptionEnd: PAST,
    });
    await setDoc(doc(db, 'medical_centers/expired_center/members', 'uid_doctor2'), {
      uid: 'uid_doctor2',
      role: 'receptionist',
      isActive: true,
    });

    // grace_center: past subscriptionEnd but future gracePeriodEnds — still operational.
    await setDoc(doc(db, 'medical_centers', 'grace_center'), {
      ownerId: 'uid_doctor1',
      isActive: true,
      trialEnds: PAST,
      subscriptionEnd: PAST,
      gracePeriodEnds: FUTURE,
    });
    await setDoc(doc(db, 'medical_centers/grace_center/members', 'uid_doctor2'), {
      uid: 'uid_doctor2',
      role: 'receptionist',
      isActive: true,
    });

    // schedules — centerId must be present for centerIsOperational rule evaluation.
    await setDoc(doc(db, 'schedules', 'sched1'), {
      doctorId: 'uid_doctor1', centerId: 'center1', status: 'published', isActive: true,
    });
    await setDoc(doc(db, 'schedules', 'sched2'), {
      doctorId: 'uid_doctor1', centerId: 'center1', status: 'draft', isActive: false,
    });
    // Schedule in an expired center — for update-deny and delete-allow tests.
    await setDoc(doc(db, 'schedules', 'sched_expired'), {
      doctorId: 'uid_doctor1', centerId: 'expired_center', status: 'draft', isActive: false,
    });
    // Schedule in a grace-period center — for create-allow test.
    await setDoc(doc(db, 'schedules', 'sched_grace'), {
      doctorId: 'uid_doctor1', centerId: 'grace_center', status: 'draft', isActive: false,
    });

    // appointments
    await setDoc(doc(db, 'appointments', 'appt1'), {
      patientId:       'uid_patient1',
      doctorId:        'uid_doctor1',
      centerId:        'center1',
      source:          'patient_app',
      status:          'pending',
      visitStatus:     'scheduled',
      paymentStatus:   'unpaid',
      bookedByUserId:  'uid_patient1',
      bookedByRole:    'patient',
      appointmentAt:   new Date('2026-06-01T10:00:00Z'),
      dateKey:         '2026-06-01',
      slotId:          'slot1',
      createdAt:       new Date(),
    });
    // Appointment in an expired center — update paths must still work.
    await setDoc(doc(db, 'appointments', 'appt_expired'), {
      patientId:       'uid_patient1',
      doctorId:        'uid_doctor1',
      centerId:        'expired_center',
      source:          'patient_app',
      status:          'pending',
      visitStatus:     'waiting',
      paymentStatus:   'unpaid',
      bookedByUserId:  'uid_patient1',
      bookedByRole:    'patient',
      appointmentAt:   new Date('2026-06-01T10:00:00Z'),
      dateKey:         '2026-06-01',
      slotId:          'slot_exp',
      createdAt:       new Date(),
    });

    // payments
    await setDoc(doc(db, 'payments', 'pay1'), {
      userId: 'uid_doctor1',
      status: 'pending',
    });

    // center_join_requests
    await setDoc(doc(db, 'center_join_requests', 'req1'), {
      doctorId: 'uid_doctor1',
      centerId: 'center1',
      status:   'pending',
    });
  });
}

module.exports = { createTestEnv, seedDatabase, FUTURE, PAST };
