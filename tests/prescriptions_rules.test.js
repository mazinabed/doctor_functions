'use strict';

/**
 * Prescription rules — Prescription Platform Phase 3 (ADR-013).
 *
 * The contract these tests exist to defend:
 *
 *   1. **An issued prescription is an immutable receipt.** Once status is
 *      'issued', no client may reach any clinical field. This is the single
 *      most important property in the whole feature.
 *   2. **Issue is one-way**, and only the authoring doctor may do it.
 *   3. **Identity is frozen from creation** — no update path may rewrite who
 *      the patient or prescriber was.
 *   4. **Patients never read `prescriptions`** — only the projection.
 */

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
} = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

const RX = 'prescriptions';

const ITEM = {
  id: 'rxitem-1',
  displayName: 'Moxifloxacin 0.5% Ophthalmic Solution',
  genericName: 'Moxifloxacin',
  doseAmount: 1,
  doseUnitCode: 'drop',
  routeCode: 'affected_eye',
  frequencyCode: 'four_times_daily',
  durationValue: 7,
  durationUnitCode: 'day',
  prn: false,
  sortOrder: 0,
};

const identityFields = (overrides = {}) => ({
  appointmentId: 'appt_1',
  centerId: 'center1',
  dateKey: '2026-08-28',
  patientId: 'uid_patient1',
  patientName: 'Test Patient',
  doctorId: 'uid_doc_member',
  doctorName: 'Dr Zainab',
  doctorSpecialty: 'Ophthalmology',
  doctorLicenseNumber: 'LIC-123',
  centerName: 'Test Center',
  createdByUid: 'uid_doc_member',
  createdByRole: 'doctor',
  ...overrides,
});

const draftPayload = (overrides = {}) => ({
  ...identityFields(),
  items: [ITEM],
  status: 'draft',
  printCount: 0,
  sentToPharmacyCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  schemaVersion: 1,
  ...overrides,
});

async function seedFixtures(env) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // A doctor who is a member of center1 — the authoring case.
    await setDoc(doc(db, 'users', 'uid_doc_member'), { role: 'doctor' });
    await setDoc(doc(db, 'doctors', 'uid_doc_member'), {
      name_en: 'Dr Zainab', isActive: true,
    });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_doc_member'), {
      uid: 'uid_doc_member', role: 'doctor', isActive: true,
    });

    // A second doctor at the same centre — a colleague, not the author.
    await setDoc(doc(db, 'users', 'uid_other_doc'), { role: 'doctor' });
    await setDoc(doc(db, 'doctors', 'uid_other_doc'), {
      name_en: 'Dr Omar', isActive: true,
    });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_other_doc'), {
      uid: 'uid_other_doc', role: 'doctor', isActive: true,
    });

    await setDoc(doc(db, RX, 'rx_draft'), draftPayload());
    await setDoc(doc(db, RX, 'rx_issued'), draftPayload({
      status: 'issued', issuedAt: new Date(),
    }));

    await setDoc(doc(db, 'patient_prescriptions', 'rx_issued'), {
      prescriptionId: 'rx_issued',
      patientId: 'uid_patient1',
      doctorName: 'Dr Zainab',
      items: [{ id: 'rxitem-1', displayName: ITEM.displayName }],
      status: 'issued',
    });
  });
}

beforeAll(async () => { testEnv = await createTestEnv(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedDatabase(testEnv);
  await seedFixtures(testEnv);
});
afterAll(async () => { await testEnv.cleanup(); });


// ─────────────────────────────────────────────────────────────────────────────
describe('prescriptions — create', () => {
  test('the authoring doctor CAN create a draft at their own centre', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(setDoc(doc(db, RX, 'new_1'), draftPayload()));
  });

  test('CANNOT create already issued — issue is a transition, not a state', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(setDoc(doc(db, RX, 'new_2'),
      draftPayload({ status: 'issued', issuedAt: new Date() })));
  });

  test('CANNOT create on behalf of another doctor', async () => {
    const db = testEnv.authenticatedContext('uid_other_doc').firestore();
    await assertFails(setDoc(doc(db, RX, 'new_3'), draftPayload()));
  });

  test('CANNOT create at a centre the doctor does not belong to', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(setDoc(doc(db, RX, 'new_4'),
      draftPayload({ ...identityFields({ centerId: 'expired_center' }) })));
  });

  test('CANNOT create with distribution counters pre-set', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(setDoc(doc(db, RX, 'new_5'),
      draftPayload({ printCount: 5 })));
    await assertFails(setDoc(doc(db, RX, 'new_6'),
      draftPayload({ sentToPharmacyCount: 2 })));
  });

  test('a patient CANNOT create a prescription', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(setDoc(doc(db, RX, 'new_7'),
      draftPayload({ doctorId: 'uid_patient1', createdByUid: 'uid_patient1' })));
  });
});


describe('prescriptions — draft editing', () => {
  test('the author CAN edit clinical content while it is a draft', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_draft'), {
      items: [ITEM, { ...ITEM, id: 'rxitem-2', displayName: 'Amoxicillin 500mg Capsule' }],
      diagnosisNote: 'Bacterial conjunctivitis',
      updatedAt: new Date(),
    }));
  });

  test('a colleague CANNOT edit someone else\'s draft', async () => {
    const db = testEnv.authenticatedContext('uid_other_doc').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), { items: [] }));
  });

  test('the author CANNOT rewrite identity on a draft', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), { patientId: 'uid_doctor2' }));
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), { doctorId: 'uid_other_doc' }));
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), { centerId: 'expired_center' }));
  });

  test('the author CANNOT bump the print counter on a draft', async () => {
    // Nothing has been issued, so nothing can have been printed.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), { printCount: 1 }));
  });
});


describe('prescriptions — issuing', () => {
  test('the author CAN issue their own draft', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_draft'), {
      status: 'issued',
      issuedAt: new Date(),
      items: [ITEM],
      updatedAt: new Date(),
    }));
  });

  test('a colleague CANNOT issue someone else\'s draft', async () => {
    const db = testEnv.authenticatedContext('uid_other_doc').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), {
      status: 'issued', issuedAt: new Date(),
    }));
  });

  test('issuing CANNOT smuggle a print count through', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), {
      status: 'issued', issuedAt: new Date(), printCount: 3,
    }));
  });

  test('issuing CANNOT rewrite identity in the same update', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft'), {
      status: 'issued', issuedAt: new Date(), patientName: 'Someone Else',
    }));
  });

  test('an issued prescription CANNOT be returned to draft', async () => {
    // The lifecycle is one-way. Re-opening would let clinical content change
    // after the patient already holds a copy.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_issued'), { status: 'draft' }));
  });
});


describe('prescriptions — an issued prescription is immutable', () => {
  const clinicalEdits = {
    'medication lines': { items: [] },
    'diagnosis note': { diagnosisNote: 'changed' },
    'patient instructions': { patientInstructions: 'changed' },
  };

  for (const [what, patch] of Object.entries(clinicalEdits)) {
    test(`the author CANNOT change ${what} after issue`, async () => {
      const db = testEnv.authenticatedContext('uid_doc_member').firestore();
      await assertFails(updateDoc(doc(db, RX, 'rx_issued'), patch));
    });
  }

  test('the author CAN record a print', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_issued'), {
      printCount: 1, printedAt: new Date(), updatedAt: new Date(),
    }));
  });

  test('the author CAN record a pharmacy transmission', async () => {
    // Phase 5 writes these; the ceiling already permits them so the two phases
    // do not need a rules change between them.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_issued'), {
      sentToPharmacyCount: 1, lastSentAt: new Date(), updatedAt: new Date(),
    }));
  });

  test('the author CAN cancel an issued prescription', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_issued'), {
      status: 'cancelled', cancelledAt: new Date(), cancelReason: 'error',
      updatedAt: new Date(),
    }));
  });

  test('a non-author centre member CAN record a reprint but nothing else', async () => {
    const db = testEnv.authenticatedContext('uid_other_doc').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_issued'), {
      printCount: 1, printedAt: new Date(), updatedAt: new Date(),
    }));
    await assertFails(updateDoc(doc(db, RX, 'rx_issued'), { items: [] }));
    await assertFails(updateDoc(doc(db, RX, 'rx_issued'), { status: 'cancelled' }));
  });
});


describe('prescriptions — delete', () => {
  test('the author CAN discard their own draft', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(deleteDoc(doc(db, RX, 'rx_draft')));
  });

  test('an issued prescription can NEVER be deleted', async () => {
    for (const uid of ['uid_doc_member', 'uid_center_admin', 'uid_admin']) {
      const db = testEnv.authenticatedContext(uid).firestore();
      await assertFails(deleteDoc(doc(db, RX, 'rx_issued')));
    }
  });
});


describe('prescriptions — read access', () => {
  test('the authoring doctor CAN read', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(getDoc(doc(db, RX, 'rx_issued')));
  });

  test('a centre member CAN read', async () => {
    const db = testEnv.authenticatedContext('uid_center_admin').firestore();
    await assertSucceeds(getDoc(doc(db, RX, 'rx_issued')));
  });

  test('the PATIENT CANNOT read the clinical record directly', async () => {
    // Patients read the projection, which omits diagnosisNote. Reading this
    // collection would expose the doctor-only note.
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(getDoc(doc(db, RX, 'rx_issued')));
  });

  test('a doctor with no membership at this centre CANNOT read', async () => {
    // uid_doctor1 is center1's ownerId but has no members/ document, so
    // isCenterMember is false. Ownership alone does not grant clinical read —
    // membership is the gate everywhere else in these rules, and prescriptions
    // follow the same line.
    const db = testEnv.authenticatedContext('uid_doctor1').firestore();
    await assertFails(getDoc(doc(db, RX, 'rx_issued')));
  });

  test('a centre member who is not the author CAN read', async () => {
    // uid_doctor2 is a center1 member (role receptionist in the shared seed).
    // Clinical colleagues at the same centre can see the prescription; the
    // patient-facing exposure question is settled separately by the projection.
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertSucceeds(getDoc(doc(db, RX, 'rx_issued')));
  });
});


describe('patient_prescriptions — the projection', () => {
  test('the patient CAN read their own', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertSucceeds(getDoc(doc(db, 'patient_prescriptions', 'rx_issued')));
  });

  test('another patient CANNOT read it', async () => {
    const db = testEnv.authenticatedContext('uid_doctor2').firestore();
    await assertFails(getDoc(doc(db, 'patient_prescriptions', 'rx_issued')));
  });

  test('no client may write the projection', async () => {
    // Written exclusively by onPrescriptionIssued via the Admin SDK.
    for (const uid of ['uid_patient1', 'uid_doc_member', 'uid_admin']) {
      const db = testEnv.authenticatedContext(uid).firestore();
      await assertFails(
        setDoc(doc(db, 'patient_prescriptions', 'forged'), {
          patientId: uid, items: [],
        }),
      );
    }
  });

  test('the patient CANNOT tamper with their own projection', async () => {
    const db = testEnv.authenticatedContext('uid_patient1').firestore();
    await assertFails(
      updateDoc(doc(db, 'patient_prescriptions', 'rx_issued'), { items: [] }),
    );
  });
});
