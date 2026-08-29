'use strict';

/**
 * Prescription verification callables — Prescription Platform Phase 7
 * (ADR-013 §8).
 *
 *   verifyPrescription             PUBLIC, unauthenticated, read-only
 *   ensurePrescriptionVerification authenticated, mints the QR credential
 *
 * ── Why verifyPrescription is deliberately not auth-gated ───────────────────
 *
 * The entire point of the QR is that ANY pharmacy can check a sheet — including
 * one that has never heard of TrustyDr, on a pharmacist's own phone, with no
 * account and no app. Requiring a login would make the feature useless for the
 * pharmacies that need it most.
 *
 * Same stance, and same reasoning, as `getMarketplaceCatalog`: what makes this
 * safe to expose is not a login check but a field-level guarantee. The function
 * accepts ONE input — an unguessable 192-bit token — and returns ONE
 * deliberately limited projection. It cannot be pointed at a patient, a doctor,
 * a centre, a date range, or a prescription id.
 *
 * ── The enumeration question ────────────────────────────────────────────────
 *
 * The printed sheet shows a short reference like `4F2A9C`. That reference is
 * NOT accepted here. If it were, the reference space would be walkable and
 * every patient's prescription readable. The only accepted credential is the
 * token, which is random, 192-bit, and resolved by a single document get
 * against a collection no client can read or list.
 *
 * A failed lookup returns one generic `not-found` regardless of cause —
 * malformed token, unknown token, deleted prescription, or a prescription still
 * in draft. Distinguishing them would turn this into an oracle.
 *
 * ── No write path ───────────────────────────────────────────────────────────
 *
 * There is no anonymous "mark dispensed" in V1 and this module contains no
 * write of any kind. Changing a prescription's authoritative status requires an
 * authenticated pharmacy acting through the Phase 5 `clinical_requests` rail,
 * where the actor is known. Someone holding a photocopy of a QR must never be
 * able to alter a clinical record.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const {
  VERIFICATIONS,
  isWellFormedToken,
  ensureVerificationToken,
} = require('./verificationToken');

const { buildVerificationProjection } = require('./verificationProjection');

const PRESCRIPTIONS = 'prescriptions';
const CLINICAL_REQUESTS = 'clinical_requests';

/** Statuses a holder of a printed sheet may legitimately be verifying. */
const VERIFIABLE_STATUSES = ['issued', 'cancelled', 'superseded'];

/** One generic failure, so nothing about why is observable. */
function notFound() {
  return new HttpsError(
    'not-found',
    'This code does not match a prescription issued through TrustyDr.',
  );
}

// ─── Public verification ──────────────────────────────────────────────────────

exports.verifyPrescription = onCall(
  { region: 'us-central1' },
  async (request) => {
    // Intentionally no request.auth check — see the header. Nothing below reads
    // request.auth, so an authenticated and an anonymous caller receive byte-
    // identical responses; there is no personalization to leak.
    const token = (request.data || {}).token;

    // Shape-check before touching Firestore: a malformed value can never match
    // a minted token, so rejecting it here avoids a read and keeps a scanner
    // spraying junk from costing anything.
    if (!isWellFormedToken(token)) throw notFound();

    const db = getFirestore();

    let mapSnap;
    try {
      mapSnap = await db.collection(VERIFICATIONS).doc(token).get();
    } catch (e) {
      console.error(`verifyPrescription: lookup failed: ${e.message}`);
      throw new HttpsError('internal', 'Verification is unavailable.');
    }
    if (!mapSnap.exists) throw notFound();

    const prescriptionId = mapSnap.get('prescriptionId');
    if (!prescriptionId) throw notFound();

    const rxSnap = await db.collection(PRESCRIPTIONS).doc(prescriptionId).get();
    if (!rxSnap.exists) throw notFound();

    const data = rxSnap.data() || {};

    // A draft is not a document anyone should be holding. Reported as the same
    // generic failure rather than "not issued yet", which would confirm the
    // token is real.
    if (!VERIFIABLE_STATUSES.includes(data.status)) throw notFound();

    // Defence in depth: the mapping must still point back at this prescription.
    // Guards against a mapping document that was ever mis-written.
    if (data.verificationToken && data.verificationToken !== token) {
      console.warn(
        `verifyPrescription: token mismatch on ${prescriptionId}`,
      );
      throw notFound();
    }

    // Electronic dispensing, only for TrustyDr-connected pharmacies. Bounded
    // and unordered on purpose: a single equality filter uses the automatic
    // single-field index, so this adds no composite index and no scan.
    let clinicalRequests = [];
    try {
      const sent = await db.collection(CLINICAL_REQUESTS)
        .where('prescriptionId', '==', prescriptionId)
        .limit(10)
        .get();
      clinicalRequests = sent.docs.map((d) => d.data());
    } catch (e) {
      // Dispensing status is supplementary. Losing it must never stop a
      // pharmacist confirming the sheet is genuine.
      console.warn(`verifyPrescription: dispensing lookup failed: ${e.message}`);
    }

    return {
      verified: true,
      prescription: buildVerificationProjection({
        prescriptionId,
        prescription: data,
        clinicalRequests,
        nowMs: Date.now(),
      }),
    };
  },
);

// ─── Minting, for the print path ──────────────────────────────────────────────

exports.ensurePrescriptionVerification = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'You must be logged in.');
    }
    const uid = request.auth.uid;
    const prescriptionId = (request.data || {}).prescriptionId;
    if (!prescriptionId || typeof prescriptionId !== 'string') {
      throw new HttpsError('invalid-argument', 'prescriptionId is required.');
    }

    const db = getFirestore();
    const snap = await db.collection(PRESCRIPTIONS).doc(prescriptionId).get();
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Prescription not found.');
    }
    const data = snap.data() || {};

    // Only an issued prescription gets a credential. Minting for a draft would
    // put a live verification URL on a document that has not been issued.
    if (data.status === 'draft') {
      throw new HttpsError(
        'failed-precondition',
        'Only an issued prescription can be verified.',
      );
    }

    // The author, or any member of the issuing centre — deliberately the exact
    // same population `isCenterMember(centerId)` admits in firestore.rules,
    // which is membership-document existence with no further status test. Those
    // are already the people the rules let read this prescription and record a
    // print, because reception legitimately reprints for a patient. Minting a
    // credential for a sheet you may already print grants nothing new; adding a
    // stricter test here would instead mean a receptionist could print a sheet
    // whose QR does not resolve.
    const isAuthor = data.doctorId === uid;
    let isMember = false;
    if (!isAuthor && data.centerId) {
      try {
        const member = await db.collection('medical_centers')
          .doc(data.centerId).collection('members').doc(uid).get();
        isMember = member.exists;
      } catch (e) {
        console.error(`ensurePrescriptionVerification: ${e.message}`);
      }
    }
    if (!isAuthor && !isMember) {
      throw new HttpsError('permission-denied', 'Not your prescription.');
    }

    try {
      const { token, minted } = await ensureVerificationToken(db, prescriptionId);
      return { token, minted };
    } catch (e) {
      if (e.code === 'not-found') {
        throw new HttpsError('not-found', 'Prescription not found.');
      }
      console.error(`ensurePrescriptionVerification: ${e.message}`);
      throw new HttpsError('internal', 'Could not prepare verification.');
    }
  },
);
