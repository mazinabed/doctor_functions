'use strict';

/**
 * onCenterMedicationWritten — Phase 1 (ADR-014).
 *
 * medical_centers/{centerId}/medications/{medicationId}
 *
 * The client creates the document (authorization is enforced by
 * `canAuthorMedications(centerId)` in firestore.rules — that is the security
 * boundary). This trigger then does the two things that must be server-owned:
 *
 *   1. Computes `normalizedKey` + `searchTokens` and writes them back.
 *      ADR-014 requires the key be computed server-side so the algorithm can
 *      change without a client release. The client never derives it, and the
 *      rules never let the client write it.
 *
 *   2. Writes a `medication_submissions/{id}` candidate record for a locally
 *      created medication, so future admin moderation (Phase 6) has evidence.
 *      NOTHING here promotes anything to the global catalog — submissions are
 *      inert candidates. `distinctCenterCount` is recorded as review evidence
 *      only and drives no behaviour (ADR-014 §5).
 *
 * Same "client writes, trigger enriches" shape as onClinicalReferralCreated.
 * Idempotent: the submission uses a deterministic ID, and the write-back is
 * skipped when the derived values already match.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const {
  buildNormalizedKey,
  buildSearchTokens,
} = require('./normalizeMedication');

const SUBMISSIONS = 'medication_submissions';

function identityOf(d) {
  return {
    displayName: d.displayName || '',
    genericName: d.genericName || '',
    brandName: d.brandName || '',
    strength: d.strength || '',
    strengthUnit: d.strengthUnit || '',
    dosageForm: d.dosageForm || '',
  };
}

function sameTokens(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

exports.onCenterMedicationWritten = onDocumentWritten(
  'medical_centers/{centerId}/medications/{medicationId}',
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return; // deleted — nothing to derive

    const db = getFirestore();
    const { centerId, medicationId } = event.params;
    const data = after.data() || {};

    const identity = identityOf(data);
    const normalizedKey = buildNormalizedKey(identity);
    const searchTokens = buildSearchTokens(identity);

    // ── 1. Write derived fields back, only when they actually changed ───────
    const needsWriteBack =
      data.normalizedKey !== normalizedKey ||
      !sameTokens(data.searchTokens, searchTokens);

    if (needsWriteBack) {
      try {
        await after.ref.update({
          normalizedKey,
          searchTokens,
          derivedAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error(
          `onCenterMedicationWritten: write-back failed ${centerId}/${medicationId}: ${e.message}`,
        );
        return;
      }
    }

    // ── 2. Submission candidate — locally authored medications only ────────
    // A medication that merely references an existing catalog entry
    // (catalogId set) is not a new vocabulary contribution.
    const isLocalOriginal = data.isLocal === true && !data.catalogId;
    if (!isLocalOriginal || !normalizedKey) return;

    const submissionId = `${centerId}__${medicationId}`;
    const ref = db.collection(SUBMISSIONS).doc(submissionId);

    let existing;
    try {
      existing = await ref.get();
    } catch (e) {
      console.error(`onCenterMedicationWritten: submission read failed: ${e.message}`);
      return;
    }

    // Review evidence only — how many distinct centers independently produced
    // this key. Recorded because it is cheap to record now and expensive to
    // reconstruct later. It promotes nothing (ADR-014 §5).
    let distinctCenterCount = 1;
    try {
      const peers = await db
        .collectionGroup('medications')
        .where('normalizedKey', '==', normalizedKey)
        .where('isLocal', '==', true)
        .limit(50)
        .get();
      const centers = new Set();
      peers.forEach((d) => {
        const parent = d.ref.parent.parent;
        if (parent) centers.add(parent.id);
      });
      centers.add(centerId);
      distinctCenterCount = centers.size;
    } catch (e) {
      // Missing collection-group index must not block medication creation.
      console.warn(
        `onCenterMedicationWritten: peer count unavailable (${e.message}) — defaulting to 1`,
      );
    }

    const payload = {
      centerId,
      centerMedicationId: medicationId,
      normalizedKey,
      proposed: {
        displayName: identity.displayName,
        genericName: identity.genericName || null,
        brandName: identity.brandName || null,
        strength: identity.strength || null,
        strengthUnit: identity.strengthUnit || null,
        dosageForm: identity.dosageForm || null,
        manufacturer: data.manufacturer || null,
      },
      submittedByUid: data.createdBy || '',
      distinctCenterCount,
      updatedAt: FieldValue.serverTimestamp(),
    };

    try {
      if (!existing.exists) {
        await ref.set({
          ...payload,
          status: 'pending', // pending | approved | merged | rejected — Phase 6
          submittedAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `onCenterMedicationWritten: submission ${submissionId} key=${normalizedKey}`,
        );
      } else if (existing.data().status === 'pending') {
        // Keep a still-pending candidate in step with doctor self-corrections.
        // A reviewed submission is never silently rewritten.
        await ref.update(payload);
      }
    } catch (e) {
      console.error(`onCenterMedicationWritten: submission write failed: ${e.message}`);
    }
  },
);
