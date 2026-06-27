'use strict';

/**
 * onClinicalReferralStatusUpdated
 *
 * Mirrors safe status fields from clinical_requests into patient_referral_requests
 * whenever partnerStatus, status, or patientReleaseStatus changes.
 *
 * Design:
 *   - Only processes documents that have a patient_referral_requests counterpart.
 *   - Early-exits if none of the three status fields changed (no unnecessary writes).
 *   - Writes only the three safe status fields + updatedAt (never clinical/result fields).
 *   - Future status-change notifications slot in via the commented hook below.
 *
 * Adding a per-transition notification later:
 *   Un-comment the hook block and add the relevant transition check.
 *   No structural changes needed — the function and referral doc are already wired.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const STATUS_FIELDS = ['partnerStatus', 'status', 'patientReleaseStatus'];

exports.onClinicalReferralStatusUpdated = onDocumentUpdated(
  'clinical_requests/{requestId}',
  async (event) => {
    const db        = getFirestore();
    const requestId = event.params.requestId;
    const before    = event.data.before.data();
    const after     = event.data.after.data();

    // Early-exit: skip if none of the three status fields changed
    const changed = STATUS_FIELDS.some((f) => before[f] !== after[f]);
    if (!changed) return;

    // Only process if a patient_referral_requests doc exists for this request
    const referralRef  = db.collection('patient_referral_requests').doc(requestId);
    const referralSnap = await referralRef.get();
    if (!referralSnap.exists) return;

    // Mirror only safe status fields — never clinical or result fields
    await referralRef.update({
      partnerStatus:        after.partnerStatus        ?? before.partnerStatus        ?? 'sent',
      status:               after.status               ?? before.status               ?? 'pending',
      patientReleaseStatus: after.patientReleaseStatus ?? before.patientReleaseStatus ?? 'unreleased',
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `onClinicalReferralStatusUpdated: mirrored ${requestId}` +
      ` partnerStatus=${before.partnerStatus}→${after.partnerStatus}` +
      ` status=${before.status}→${after.status}` +
      ` patientReleaseStatus=${before.patientReleaseStatus}→${after.patientReleaseStatus}`,
    );

    // ── Future hook: per-transition patient notifications ─────────────────────
    //
    // To add a status-change notification, insert the relevant block here.
    // The referral doc data is available as referralSnap.data().
    //
    // Example — referral received by lab:
    //   if (before.partnerStatus === 'sent' && after.partnerStatus === 'received') {
    //     const r = referralSnap.data();
    //     const notifRef = db.collection('users').doc(r.patientId)
    //       .collection('notifications').doc(`referral_received_${requestId}`);
    //     const exists = await notifRef.get();
    //     if (!exists.exists) {
    //       await notifRef.set({
    //         type: 'lab_referral_status',
    //         subtype: 'received',
    //         clinicalRequestId: requestId,
    //         titleEn: 'Your referral was received',
    //         titleAr: 'تم استلام إحالتك',
    //         titleKu: 'ناردنەکەت وەرگیرا',
    //         bodyEn: `${r.partnerName_en || ''} received your referral.`,
    //         bodyAr: `استلم ${r.partnerName_ar || ''} إحالتك.`,
    //         bodyKu: `${r.partnerName_ku || ''} ناردنەکەت وەرگرت.`,
    //         isRead: false, dismissed: false,
    //         createdAt: FieldValue.serverTimestamp(),
    //       });
    //     }
    //   }
  },
);
