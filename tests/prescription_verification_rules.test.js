'use strict';

/**
 * Prescription verification — rules surface, Phase 7 (ADR-013 §8).
 *
 * Phase 7 puts a QR on a printed prescription that anyone may scan. The entire
 * safety of that rests on ONE property: the credential behind the QR is
 * unguessable AND is only ever minted by the server. This suite proves the
 * second half — that no client can read, write, list or plant a credential.
 *
 * If any test here fails, the public verification endpoint becomes reachable
 * with an attacker-chosen token, and the QR stops being a security boundary at
 * all.
 */

const { assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
} = require('firebase/firestore');
const { createTestEnv, seedDatabase } = require('./helpers');

let testEnv;

const RX = 'prescriptions';
const VERIF = 'prescription_verifications';

// A realistic minted token: 32 base64url characters.
const REAL_TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFC';
const ATTACKER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const identityFields = (overrides = {}) => ({
  appointmentId: 'appt_1',
  centerId: 'center1',
  dateKey: '2026-08-28',
  patientId: 'uid_patient1',
  patientName: 'Test Patient',
  doctorId: 'uid_doc_member',
  doctorName: 'Dr Zainab',
  centerName: 'Test Center',
  createdByUid: 'uid_doc_member',
  createdByRole: 'doctor',
  ...overrides,
});

const draftPayload = (overrides = {}) => ({
  ...identityFields(),
  items: [{ id: 'i1', displayName: 'Moxifloxacin 0.5% Ophthalmic Solution' }],
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

    await setDoc(doc(db, 'users', 'uid_doc_member'), { role: 'doctor' });
    await setDoc(doc(db, 'doctors', 'uid_doc_member'), {
      name_en: 'Dr Zainab', isActive: true,
    });
    await setDoc(doc(db, 'medical_centers/center1/members', 'uid_doc_member'), {
      uid: 'uid_doc_member', role: 'doctor', isActive: true,
    });

    await setDoc(doc(db, 'users', 'uid_outsider'), { role: 'patient' });

    // An issued prescription that already has a server-minted credential.
    await setDoc(doc(db, RX, 'rx_issued'), draftPayload({
      status: 'issued',
      issuedAt: new Date(),
      verificationToken: REAL_TOKEN,
    }));

    await setDoc(doc(db, VERIF, REAL_TOKEN), {
      prescriptionId: 'rx_issued',
      centerId: 'center1',
      createdAt: new Date(),
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
describe('prescription_verifications is server-only', () => {
  test('an anonymous client CANNOT read a mapping, even with the real token', async () => {
    // The public page never reads this collection — it calls the callable,
    // which resolves the token with the Admin SDK. If a client could read here,
    // holding a token would leak the prescription id directly.
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, VERIF, REAL_TOKEN)));
  });

  test('a signed-in outsider CANNOT read a mapping', async () => {
    const db = testEnv.authenticatedContext('uid_outsider').firestore();
    await assertFails(getDoc(doc(db, VERIF, REAL_TOKEN)));
  });

  test('even the authoring doctor CANNOT read a mapping', async () => {
    // Nobody needs client access: the doctor gets the token from the mint
    // callable and reads it off their own prescription document.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(getDoc(doc(db, VERIF, REAL_TOKEN)));
  });

  test('nobody can LIST the collection — there is no enumeration surface', async () => {
    // A list would defeat the unguessable token entirely: an attacker would
    // simply read every credential in one query.
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(anon, VERIF)));

    const doctor = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(getDocs(collection(doctor, VERIF)));
  });

  test('nobody can CREATE a mapping — a credential can only come from the server', async () => {
    // This is the attack that matters most: plant a mapping from a token you
    // chose to a prescription you do not own, then verify it publicly.
    const db = testEnv.authenticatedContext('uid_outsider').firestore();
    await assertFails(setDoc(doc(db, VERIF, ATTACKER_TOKEN), {
      prescriptionId: 'rx_issued', centerId: 'center1',
    }));
  });

  test('the authoring doctor cannot create a mapping either', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(setDoc(doc(db, VERIF, ATTACKER_TOKEN), {
      prescriptionId: 'rx_issued', centerId: 'center1',
    }));
  });

  test('nobody can REPOINT an existing mapping at another prescription', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, VERIF, REAL_TOKEN), {
      prescriptionId: 'someone_elses_rx',
    }));
  });

  test('nobody can DELETE a mapping to break verification of a real sheet', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(deleteDoc(doc(db, VERIF, REAL_TOKEN)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('verificationToken cannot be planted on a prescription', () => {
  test('CANNOT be supplied at create', async () => {
    // Without this, a doctor could create a draft whose token is a value they
    // chose — a predictable credential that a third party could then use to
    // pull the prescription publicly.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(setDoc(doc(db, RX, 'new_planted'),
      draftPayload({ verificationToken: ATTACKER_TOKEN })));
  });

  test('a normal draft create still succeeds', async () => {
    // Proving the guard above is targeted and did not break ordinary creation.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(setDoc(doc(db, RX, 'new_ok'), draftPayload()));
  });

  test('CANNOT be added while editing a draft', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), RX, 'rx_draft2'), draftPayload());
    });
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft2'), {
      verificationToken: ATTACKER_TOKEN, updatedAt: new Date(),
    }));
  });

  test('CANNOT be written as part of issuing', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), RX, 'rx_draft3'), draftPayload());
    });
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_draft3'), {
      status: 'issued',
      issuedAt: new Date(),
      verificationToken: ATTACKER_TOKEN,
      updatedAt: new Date(),
    }));
  });

  test('CANNOT be overwritten after issue', async () => {
    // The post-issue ceiling does not list verificationToken, so rotating a
    // credential to one the client knows is unreachable.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_issued'), {
      verificationToken: ATTACKER_TOKEN, updatedAt: new Date(),
    }));
  });

  test('CANNOT be removed after issue, which would orphan a printed QR', async () => {
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertFails(updateDoc(doc(db, RX, 'rx_issued'), {
      verificationToken: null, updatedAt: new Date(),
    }));
  });

  test('recording a print still works and does not touch the token', async () => {
    // The print path is exactly where the token is used, so this must keep
    // working after the guards above.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_issued'), {
      printCount: 1, printedAt: new Date(), updatedAt: new Date(),
    }));
  });

  test('cancelling still works and does not touch the token', async () => {
    // A cancelled prescription must stay verifiable — that is how a pharmacist
    // learns it was cancelled rather than mistaking it for a forgery.
    const db = testEnv.authenticatedContext('uid_doc_member').firestore();
    await assertSucceeds(updateDoc(doc(db, RX, 'rx_issued'), {
      status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date(),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the prescription itself stays unreachable to outsiders', () => {
  test('an anonymous client CANNOT read a prescription directly', async () => {
    // Holding a QR must grant the limited projection through the callable and
    // nothing more. Direct document access stays closed.
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, RX, 'rx_issued')));
  });

  test('a signed-in outsider CANNOT read a prescription directly', async () => {
    const db = testEnv.authenticatedContext('uid_outsider').firestore();
    await assertFails(getDoc(doc(db, RX, 'rx_issued')));
  });
});
