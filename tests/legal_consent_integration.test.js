'use strict';

/**
 * Legal Consent Modernization — integration smoke test for the ACTUAL
 * getAccountLegalStatus / acceptAccountLegalDocument handler logic (not
 * just the security-rules boundary, already covered in
 * legal_consent_rules.test.js). Exercises the real Firestore
 * reads/transaction against the emulator via firebase-admin, bypassing
 * security rules entirely (Cloud Functions always use the Admin SDK) —
 * same convention as phase1b_expire_centers_integration.test.js.
 *
 * 2026-08-08 redesign: documentType is now "patientTerms" / "providerTerms"
 * / "privacy" (previously a single ambiguous "terms" + role-based
 * resolution). See legalConsent.js's own header comment for the full
 * rationale — in short, the SAME uid can legitimately be a Patient in
 * TrustyDr-pwa and a Provider in doctor_portal at once, so users/{uid}.role
 * can no longer be the signal that picks the document. The client declares
 * which document it means; the server never reads role for this decision
 * anymore.
 *
 * Run with the Firestore emulator active:
 *   firebase emulators:exec --only firestore "cd tests && npx jest legal_consent_integration --runInBand --forceExit"
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'doctorapp-7e8b3';

// Reuses the functions/ workspace's own firebase-admin install (this test
// package.json is scoped to @firebase/rules-unit-testing / client SDK only)
// rather than adding a second, redundant admin-SDK dependency here.
const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'doctorapp-7e8b3' });
}
const db = admin.firestore();

const {
  _getAccountLegalStatusHandler: getAccountLegalStatus,
  _acceptAccountLegalDocumentHandler: acceptAccountLegalDocument,
} = require('../functions/legal/legalConsent');

async function clearCollection(collectionPath) {
  const snap = await db.collection(collectionPath).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.size > 0) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('platformConfig');
  await clearCollection('users');
});

afterAll(async () => {
  await admin.app().delete();
});

test('LC-1 fresh account with no platformConfig/legal doc defaults every version to v2 and is not current for any of the three documents', async () => {
  // Deliberately no `role` field anywhere in this test — resolution no
  // longer depends on it at all.
  await db.collection('users').doc('uid_lc1').set({});

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc1' }, data: {} });

  expect(status.patientTerms.version).toBe('v2');
  expect(status.providerTerms.version).toBe('v2');
  expect(status.privacy.version).toBe('v2');
  expect(status.patientTerms.current).toBe(false);
  expect(status.providerTerms.current).toBe(false);
  expect(status.privacy.current).toBe(false);
});

test('LC-2 accepting patientTerms stamps patientTermsVersion under legalAcceptances.patientTerms, writes legalHistory, and getAccountLegalStatus reflects it as current', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v5',
    privacyVersion: 'v2',
  });
  await db.collection('users').doc('uid_lc2').set({});

  const result = await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc2' },
    data: { documentType: 'patientTerms', locale: 'ar' },
  });
  expect(result.version).toBe('v3');

  const userSnap = await db.collection('users').doc('uid_lc2').get();
  const acceptance = userSnap.data().legalAcceptances.patientTerms;
  expect(acceptance.accepted).toBe(true);
  expect(acceptance.version).toBe('v3');
  expect(acceptance.acceptedAt).toBeTruthy();

  const historySnap = await db.collection('users/uid_lc2/legalHistory').get();
  expect(historySnap.size).toBe(1);
  const historyDoc = historySnap.docs[0].data();
  expect(historyDoc.documentType).toBe('patientTerms');
  expect(historyDoc.version).toBe('v3');
  expect(historyDoc.locale).toBe('ar');

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc2' }, data: {} });
  expect(status.patientTerms.current).toBe(true);
  expect(status.patientTerms.version).toBe('v3');
  // providerTerms and privacy still untouched/not current.
  expect(status.providerTerms.current).toBe(false);
  expect(status.privacy.current).toBe(false);
});

test('LC-3 accepting providerTerms stamps providerTermsVersion under legalAcceptances.providerTerms, independent of patientTerms', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v5',
    privacyVersion: 'v2',
  });
  await db.collection('users').doc('uid_lc3').set({});

  const result = await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc3' },
    data: { documentType: 'providerTerms' },
  });
  expect(result.version).toBe('v5');

  const userSnap = await db.collection('users').doc('uid_lc3').get();
  expect(userSnap.data().legalAcceptances.providerTerms.version).toBe('v5');
  expect(userSnap.data().legalAcceptances.patientTerms).toBeUndefined();
});

test('LC-4 accepting privacy does not clobber a prior patientTerms acceptance (merge:true on nested key)', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v3',
    providerTermsVersion: 'v5',
    privacyVersion: 'v2',
  });
  await db.collection('users').doc('uid_lc4').set({});

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc4' },
    data: { documentType: 'patientTerms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc4' },
    data: { documentType: 'privacy' },
  });

  const userSnap = await db.collection('users').doc('uid_lc4').get();
  const acceptances = userSnap.data().legalAcceptances;
  expect(acceptances.patientTerms.version).toBe('v3');
  expect(acceptances.privacy.version).toBe('v2');

  const historySnap = await db.collection('users/uid_lc4/legalHistory').get();
  expect(historySnap.size).toBe(2);
});

test('LC-5 a stale patientTerms acceptance (old version) after a config bump is reported as not current, providerTerms unaffected', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });
  await db.collection('users').doc('uid_lc5').set({});
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc5' },
    data: { documentType: 'patientTerms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc5' },
    data: { documentType: 'providerTerms' },
  });

  // Publish a Patient-Terms-only version bump.
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v2',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc5' }, data: {} });
  expect(status.patientTerms.current).toBe(false);
  expect(status.patientTerms.version).toBe('v2');
  // providerTerms was accepted at v1 and providerTermsVersion is still v1 —
  // must remain current. This is REQUIRED TEST #19: a patientTermsVersion
  // bump stales patientTerms only, never providerTerms.
  expect(status.providerTerms.current).toBe(true);
  expect(status.providerTerms.version).toBe('v1');
});

test('LC-5b a providerTermsVersion bump stales providerTerms only, patientTerms unaffected (REQUIRED TEST #20)', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });
  await db.collection('users').doc('uid_lc5b').set({});
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc5b' },
    data: { documentType: 'patientTerms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc5b' },
    data: { documentType: 'providerTerms' },
  });

  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v2',
    privacyVersion: 'v1',
  });

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc5b' }, data: {} });
  expect(status.providerTerms.current).toBe(false);
  expect(status.providerTerms.version).toBe('v2');
  expect(status.patientTerms.current).toBe(true);
  expect(status.patientTerms.version).toBe('v1');
});

test('LC-5c a privacyVersion bump stales privacy for both a patientTerms-accepted and a providerTerms-accepted context equally (REQUIRED TEST #21)', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });
  await db.collection('users').doc('uid_lc5c').set({});
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc5c' },
    data: { documentType: 'patientTerms' },
  });
  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc5c' },
    data: { documentType: 'providerTerms' },
  });
  await acceptAccountLegalDocument({ auth: { uid: 'uid_lc5c' }, data: { documentType: 'privacy' } });

  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v1',
    privacyVersion: 'v2',
  });

  const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc5c' }, data: {} });
  expect(status.privacy.current).toBe(false);
  expect(status.privacy.version).toBe('v2');
  // Terms acceptances are a completely separate key and must not be
  // affected by a privacy-only bump.
  expect(status.patientTerms.current).toBe(true);
  expect(status.providerTerms.current).toBe(true);
});

test('LC-6 rejects an invalid documentType, including the retired ambiguous "terms" value', async () => {
  await db.collection('users').doc('uid_lc6').set({});
  await expect(
    acceptAccountLegalDocument({
      auth: { uid: 'uid_lc6' },
      data: { documentType: 'merchant_agreement' },
    })
  ).rejects.toThrow();
  // "terms" is no longer a member of LEGAL_DOCUMENT_TYPES post-split — a
  // stale client build sending the old value must fail closed (invalid
  // argument), not silently write to some other key.
  await expect(
    acceptAccountLegalDocument({
      auth: { uid: 'uid_lc6' },
      data: { documentType: 'terms' },
    })
  ).rejects.toThrow();
});

test('LC-7 rejects an unauthenticated call', async () => {
  await expect(getAccountLegalStatus({ auth: null, data: {} })).rejects.toThrow();
  await expect(
    acceptAccountLegalDocument({ auth: null, data: { documentType: 'patientTerms' } })
  ).rejects.toThrow();
});

test(
  'LC-8 users/{uid}.role does NOT determine patientTerms vs providerTerms resolution ' +
    '(REQUIRED TEST #7): identical documentType requests resolve to the identical ' +
    'version regardless of what role (or absence of role) the account has',
  async () => {
    await db.collection('platformConfig').doc('legal').set({
      patientTermsVersion: 'v3',
      providerTermsVersion: 'v5',
      privacyVersion: 'v2',
    });

    for (const roleCase of [
      { uid: 'uid_lc8_norole', data: {} },
      { uid: 'uid_lc8_patient', data: { role: 'patient' } },
      { uid: 'uid_lc8_doctor', data: { role: 'doctor' } },
      { uid: 'uid_lc8_diagnostic', data: { role: 'diagnostic_provider' } },
      { uid: 'uid_lc8_pharmacy', data: { role: 'pharmacy_provider' } },
    ]) {
      await db.collection('users').doc(roleCase.uid).set(roleCase.data);

      const patientResult = await acceptAccountLegalDocument({
        auth: { uid: roleCase.uid },
        data: { documentType: 'patientTerms' },
      });
      expect(patientResult.version).toBe('v3');

      const providerResult = await acceptAccountLegalDocument({
        auth: { uid: roleCase.uid },
        data: { documentType: 'providerTerms' },
      });
      expect(providerResult.version).toBe('v5');
    }
  },
);

test(
  'LC-9 a dual-context uid (role: "doctor", the confirmed production shape of an ' +
    'account used in both doctor_portal AND TrustyDr-pwa) can independently accept ' +
    'BOTH patientTerms and providerTerms, and both remain current simultaneously ' +
    '(REQUIRED TESTS #2, #3, #8, #9)',
  async () => {
    await db.collection('platformConfig').doc('legal').set({
      patientTermsVersion: 'v2',
      providerTermsVersion: 'v2',
      privacyVersion: 'v2',
    });
    await db.collection('users').doc('uid_lc9_dual').set({
      role: 'doctor',
      centerRole: 'center_admin',
      hasCenter: true,
      centerId: 'center_abc',
    });

    // Doctor Portal accepts Provider Terms.
    await acceptAccountLegalDocument({
      auth: { uid: 'uid_lc9_dual' },
      data: { documentType: 'providerTerms' },
    });
    // The SAME uid, now in TrustyDr-pwa, accepts Patient Terms.
    await acceptAccountLegalDocument({
      auth: { uid: 'uid_lc9_dual' },
      data: { documentType: 'patientTerms' },
    });

    const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc9_dual' }, data: {} });
    expect(status.providerTerms.current).toBe(true);
    expect(status.patientTerms.current).toBe(true);

    // role was never read or required to be anything in particular for
    // either acceptance to succeed and remain independently current.
    const userSnap = await db.collection('users').doc('uid_lc9_dual').get();
    expect(userSnap.data().role).toBe('doctor');
    expect(userSnap.data().legalAcceptances.patientTerms.version).toBe('v2');
    expect(userSnap.data().legalAcceptances.providerTerms.version).toBe('v2');
  },
);

test(
  'LC-10 a shared privacy acceptance satisfies BOTH the Patient and Provider context ' +
    'for the same dual-context uid (REQUIRED TEST #4)',
  async () => {
    await db.collection('platformConfig').doc('legal').set({
      patientTermsVersion: 'v2',
      providerTermsVersion: 'v2',
      privacyVersion: 'v2',
    });
    await db.collection('users').doc('uid_lc10').set({ role: 'diagnostic_provider' });

    await acceptAccountLegalDocument({
      auth: { uid: 'uid_lc10' },
      data: { documentType: 'privacy' },
    });

    // One shared privacy record — both TrustyDr-pwa's status check and
    // doctor_portal's status check for the same uid see the same
    // "current: true", with no separate patient/provider privacy key at all.
    const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc10' }, data: {} });
    expect(status.privacy.current).toBe(true);

    const userSnap = await db.collection('users').doc('uid_lc10').get();
    expect(userSnap.data().legalAcceptances.patientTerms).toBeUndefined();
    expect(userSnap.data().legalAcceptances.providerTerms).toBeUndefined();
    expect(Object.keys(userSnap.data().legalAcceptances)).toEqual(['privacy']);
  },
);

test(
  'LC-11 the old ambiguous legalAcceptances.terms key satisfies NEITHER patientTerms ' +
    'nor providerTerms (REQUIRED TEST #5) — a pre-redesign acceptance requires a ' +
    'fresh accept under the correct new key',
  async () => {
    await db.collection('platformConfig').doc('legal').set({
      patientTermsVersion: 'v2',
      providerTermsVersion: 'v2',
      privacyVersion: 'v2',
    });
    // Simulates a uid that accepted under the OLD pre-split schema.
    await db.collection('users').doc('uid_lc11').set({
      role: 'patient',
      legalAcceptances: {
        terms: { accepted: true, version: 'v2', acceptedAt: admin.firestore.Timestamp.now() },
      },
    });

    const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc11' }, data: {} });
    expect(status.patientTerms.current).toBe(false);
    expect(status.providerTerms.current).toBe(false);

    // The old field is still there, untouched — not deleted, not migrated.
    const userSnap = await db.collection('users').doc('uid_lc11').get();
    expect(userSnap.data().legalAcceptances.terms.version).toBe('v2');
  },
);

test(
  'LC-12 the old flat legalAccepted/legalAcceptedAt/legalVersion (pre-v2, v1 flow) ' +
    'fields satisfy NEITHER patientTerms nor providerTerms nor privacy ' +
    '(REQUIRED TEST #6)',
  async () => {
    await db.collection('platformConfig').doc('legal').set({
      patientTermsVersion: 'v2',
      providerTermsVersion: 'v2',
      privacyVersion: 'v2',
    });
    await db.collection('users').doc('uid_lc12').set({
      legalAccepted: true,
      legalAcceptedAt: admin.firestore.Timestamp.now(),
      legalVersion: 'v1',
    });

    const { status } = await getAccountLegalStatus({ auth: { uid: 'uid_lc12' }, data: {} });
    expect(status.patientTerms.current).toBe(false);
    expect(status.providerTerms.current).toBe(false);
    expect(status.privacy.current).toBe(false);

    // Untouched, not deleted.
    const userSnap = await db.collection('users').doc('uid_lc12').get();
    expect(userSnap.data().legalAccepted).toBe(true);
    expect(userSnap.data().legalVersion).toBe('v1');
  },
);

test('LC-13 legalHistory remains append-only across repeated accept cycles for the same documentType (REQUIRED TEST #24)', async () => {
  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v1',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });
  await db.collection('users').doc('uid_lc13').set({});

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc13' },
    data: { documentType: 'patientTerms' },
  });

  await db.collection('platformConfig').doc('legal').set({
    patientTermsVersion: 'v2',
    providerTermsVersion: 'v1',
    privacyVersion: 'v1',
  });

  await acceptAccountLegalDocument({
    auth: { uid: 'uid_lc13' },
    data: { documentType: 'patientTerms' },
  });

  const historySnap = await db
    .collection('users/uid_lc13/legalHistory')
    .orderBy('version')
    .get();
  expect(historySnap.size).toBe(2);
  expect(historySnap.docs.map((d) => d.data().version)).toEqual(['v1', 'v2']);
  // The current record reflects only the latest, but history retains both.
  const userSnap = await db.collection('users').doc('uid_lc13').get();
  expect(userSnap.data().legalAcceptances.patientTerms.version).toBe('v2');
});
