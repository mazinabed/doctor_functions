'use strict';

const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'doctorapp-7e8b3';
const RULES_PATH = path.resolve(__dirname, '../firestore.rules');

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
    await setDoc(doc(db, 'users', 'uid_admin'),    { role: 'admin' });
    await setDoc(doc(db, 'users', 'uid_patient1'), { role: 'patient', phone: '07701234567' });
    await setDoc(doc(db, 'users', 'uid_doctor1'),  { role: 'doctor' });
    await setDoc(doc(db, 'users', 'uid_doctor2'),  { role: 'doctor' });

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
    await setDoc(doc(db, 'medical_centers', 'center1'), {
      ownerId: 'uid_doctor1',
      isActive: true,
      subscriptionStatus: 'active',
      name_en: 'Test Center',
    });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_doctor2'), {
      role: 'receptionist',
    });

    // schedules
    await setDoc(doc(db, 'schedules', 'sched1'), { doctorId: 'uid_doctor1', status: 'published' });
    await setDoc(doc(db, 'schedules', 'sched2'), { doctorId: 'uid_doctor1', status: 'draft' });

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

module.exports = { createTestEnv, seedDatabase };
