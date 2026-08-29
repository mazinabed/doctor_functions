'use strict';

/**
 * materializeRxNormMedication — Prescription Platform Phase 2 (ADR-014 §7).
 *
 * The durable half of the RxNorm integration. When a doctor actually *picks* an
 * RxNorm result, that concept is written once into `medication_catalog` and is
 * served from Firestore from then on. RxNav is therefore only ever hit for
 * terms nobody has chosen yet, and as the catalog fills toward real Iraqi
 * prescribing patterns, external calls trend toward zero.
 *
 * This is the only path by which a client can cause a `medication_catalog`
 * write, and it is still a server write: `firestore.rules` keeps the collection
 * `write: if false` for every client. The caller supplies an rxcui — a pointer,
 * not content — and the name is read from RxNorm's own properties endpoint
 * here. A client can never inject a medication name into the global catalog.
 *
 * Idempotent by construction: the document id is `rxnorm_{rxcui}`, so repeated
 * picks of the same medication converge on one entry rather than racing.
 *
 * NOTE ON SCOPE: this materialises into the *global catalog* only. It does not
 * add anything to a centre library — that remains a client write governed by
 * `canAuthorMedications(centerId)`, so the authorization seam is unchanged.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { resolveRxcui, isPrescribableTty } = require('./rxnormClient');
const {
  buildNormalizedKey,
  buildSearchTokens,
} = require('./normalizeMedication');

const CATALOG = 'medication_catalog';

/** Deterministic id — the whole idempotency story. */
function catalogIdForRxcui(rxcui) {
  return `rxnorm_${rxcui}`;
}

/**
 * Splits an RxNorm normalised name into TrustyDr's identity fields.
 *
 * RxNorm names embed strength and form, e.g.
 *   "moxifloxacin 5 MG/ML Ophthalmic Solution"
 *
 * The derived pieces (genericName, strength, dosageForm) are TrustyDr
 * derivations *of NLM content*, not third-party vocabulary content, so they
 * stay inside the source boundary. `displayName` is always the RxNorm name
 * verbatim — that is the authoritative value and the one that prints.
 */
function deriveIdentityFromRxNormName(displayName) {
  const name = String(displayName || '').trim();

  // Branded concepts carry the brand in trailing brackets:
  //   "moxifloxacin 400 MG Oral Tablet [Avelox]"
  let brandName = null;
  const brandMatch = name.match(/\[([^\]]+)\]\s*$/);
  if (brandMatch) brandName = brandMatch[1].trim() || null;

  const withoutBrand = name.replace(/\s*\[[^\]]+\]\s*$/, '').trim();

  // Leading token(s) up to the first number are the ingredient.
  const strengthMatch = withoutBrand.match(
    /^(.*?)\s+(\d+(?:\.\d+)?)\s*([A-Za-z%/]+)\s+(.*)$/,
  );

  if (!strengthMatch) {
    return {
      displayName: name,
      genericName: withoutBrand || null,
      brandName,
      strength: null,
      strengthUnit: null,
      dosageForm: null,
    };
  }

  const [, generic, strength, unit, form] = strengthMatch;
  return {
    displayName: name,
    genericName: generic.trim() || null,
    brandName,
    strength: strength.trim() || null,
    strengthUnit: unit.trim() || null,
    dosageForm: form.trim() || null,
  };
}

exports.materializeRxNormMedication = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'You must be logged in.');
    }

    const data = request.data || {};
    const rxcui = String(data.rxcui || '').trim();
    if (!rxcui || !/^\d+$/.test(rxcui)) {
      throw new HttpsError('invalid-argument', 'A numeric rxcui is required.');
    }

    const db = getFirestore();
    const catalogId = catalogIdForRxcui(rxcui);
    const ref = db.collection(CATALOG).doc(catalogId);

    // Already materialised — the common case once a medication is in use.
    const existing = await ref.get();
    if (existing.exists) {
      return { catalogId, created: false, displayName: existing.data().displayName };
    }

    // Re-read the name from RxNorm rather than trusting anything the client
    // sent. This is what makes the write safe.
    const concept = await resolveRxcui(rxcui);
    if (!concept) {
      throw new HttpsError(
        'unavailable',
        'Could not reach RxNorm to confirm this medication. Please try again, '
        + 'or add the medication manually.',
      );
    }
    if (!isPrescribableTty(concept.tty)) {
      throw new HttpsError(
        'invalid-argument',
        'That RxNorm concept is not a prescribable medication.',
      );
    }

    const identity = deriveIdentityFromRxNormName(concept.displayName);
    const normalizedKey = buildNormalizedKey(identity);
    const searchTokens = buildSearchTokens(identity);

    const payload = {
      ...identity,
      route: null,
      manufacturer: null,
      // Provenance is never dropped — it is what distinguishes reviewed NLM
      // vocabulary from a locally contributed entry, and it drives the NLM
      // attribution shown in the UI.
      source: 'rxnorm',
      rxcui,
      rxnormTty: concept.tty,
      rxnormFetchedAt: FieldValue.serverTimestamp(),
      nationalCode: null,
      nationalCodeSystem: null,
      normalizedKey,
      searchTokens,
      status: 'active',
      usageCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    try {
      // create() rather than set(): if two doctors pick the same medication at
      // the same moment, the loser gets ALREADY_EXISTS and we return the
      // winner's document instead of clobbering it.
      await ref.create(payload);
      console.log(
        `materializeRxNormMedication: created ${catalogId} key=${normalizedKey}`,
      );
      return { catalogId, created: true, displayName: identity.displayName };
    } catch (e) {
      if (e && e.code === 6) { // ALREADY_EXISTS
        return { catalogId, created: false, displayName: identity.displayName };
      }
      console.error(`materializeRxNormMedication: write failed: ${e.message}`);
      throw new HttpsError('internal', 'Could not save the medication.');
    }
  },
);

exports.catalogIdForRxcui = catalogIdForRxcui;
exports.deriveIdentityFromRxNormName = deriveIdentityFromRxNormName;
