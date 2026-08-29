'use strict';

/**
 * Prescription verification credential — Prescription Platform Phase 7
 * (ADR-013 §8).
 *
 * ── Why the visible prescription number is NOT the credential ────────────────
 *
 * The printed sheet carries a short human-readable reference so a pharmacist
 * can say "prescription 4F2A9C" out loud and compare it against the screen.
 * That reference is derived from the document id and is therefore SHORT and
 * GUESSABLE — which is exactly why it must never be the thing that authorizes a
 * lookup. If it were, anyone could walk the reference space and pull real
 * patients' prescriptions.
 *
 * So authentication of the QR is a separate, unguessable credential: 24 random
 * bytes (192 bits) from `crypto.randomBytes`, base64url-encoded to 32
 * characters. There is no derivation from the prescription, the patient, the
 * date or the id — knowing everything printed on the sheet tells you nothing
 * about the token.
 *
 * ── Server-only, in both directions ─────────────────────────────────────────
 *
 * The token is minted here and nowhere else. `prescription_verifications` is
 * `read, write: if false` for every client, so the token -> prescription
 * mapping is unreachable except through the verification callable, and the
 * lookup is a single document get — there is no query surface to enumerate.
 *
 * A client cannot plant its own token. Rules block `verificationToken` at
 * create and it is absent from both post-create `hasOnly` ceilings, but this
 * module does not rely on that alone: [ensureVerificationToken] only reuses an
 * existing token when the server-only mapping document actually points back at
 * this prescription. A value a client somehow placed on the prescription can
 * never satisfy that, so it is discarded and a real token is minted instead.
 */

const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');

const VERIFICATIONS = 'prescription_verifications';
const PRESCRIPTIONS = 'prescriptions';

/** 24 bytes = 192 bits. Base64url so it survives a URL and a QR unescaped. */
const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function isWellFormedToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * The short reference printed on the sheet and shown on the verification page.
 *
 * Derived, never stored — adding a counter field would be schema invention, and
 * a sequential number would be worse than useless here anyway: it would invite
 * exactly the enumeration the token exists to prevent. Its only job is to let a
 * human confirm that the page they are looking at is the sheet in their hand.
 */
function referenceNumber(prescriptionId) {
  const id = String(prescriptionId || '');
  if (!id) return '';
  return id.slice(-6).toUpperCase();
}

/**
 * Returns the prescription's verification token, minting one if it has none.
 *
 * Idempotent and safe to race: the whole read-decide-write runs in a Firestore
 * transaction on the prescription document, so two callers (the issue trigger
 * and a doctor pressing Print a second later) converge on ONE token rather than
 * silently leaving two live credentials for the same prescription.
 *
 * @returns {Promise<{token: string, minted: boolean}>}
 */
async function ensureVerificationToken(db, prescriptionId) {
  const rxRef = db.collection(PRESCRIPTIONS).doc(prescriptionId);

  return db.runTransaction(async (tx) => {
    const rxSnap = await tx.get(rxRef);
    if (!rxSnap.exists) {
      const err = new Error('prescription-not-found');
      err.code = 'not-found';
      throw err;
    }

    const existing = rxSnap.get('verificationToken');

    // Reuse only a token the SERVER issued for THIS prescription. A value that
    // reached the document any other way fails one of these checks and is
    // replaced, so a planted or copied token can never become the live
    // credential.
    if (isWellFormedToken(existing)) {
      const mapSnap = await tx.get(db.collection(VERIFICATIONS).doc(existing));
      if (mapSnap.exists && mapSnap.get('prescriptionId') === prescriptionId) {
        return { token: existing, minted: false };
      }
    }

    const token = generateToken();

    tx.set(db.collection(VERIFICATIONS).doc(token), {
      prescriptionId,
      centerId: rxSnap.get('centerId') || '',
      createdAt: FieldValue.serverTimestamp(),
    });

    // No `updatedAt` bump: minting is not a clinical event, and the field is
    // outside every client-reachable update path, so nothing about the
    // immutable receipt changes here.
    tx.update(rxRef, { verificationToken: token });

    return { token, minted: true };
  });
}

module.exports = {
  VERIFICATIONS,
  TOKEN_PATTERN,
  generateToken,
  isWellFormedToken,
  referenceNumber,
  ensureVerificationToken,
};
