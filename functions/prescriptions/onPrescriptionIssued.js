'use strict';

/**
 * onPrescriptionIssued — Prescription Platform Phase 3 (ADR-013 §7).
 *
 * Fires on the draft -> issued transition and does the two things that must
 * happen server-side:
 *
 *   1. Writes `patient_prescriptions/{prescriptionId}` — the patient-facing
 *      projection. **This is what makes a print-only prescription reach the
 *      patient at all.** Before Phase 3, a prescription with no pharmacy
 *      produced no patient record whatsoever, because the only patient-visible
 *      artifact was the pharmacy referral.
 *
 *   2. Notifies the patient (notification document + FCM), reusing the exact
 *      fan-out shape onClinicalReferralCreated already established.
 *
 * ── What deliberately does NOT cross ────────────────────────────────────────
 *
 * `diagnosisNote` is doctor-visible only and is never projected. The patient
 * projection carries medication identity, the frozen authored directions, and
 * the structured codes needed to re-render those directions in the patient's
 * own language — nothing else.
 *
 * ── Language ────────────────────────────────────────────────────────────────
 *
 * Medication names are copied verbatim; they are standardized identities and
 * are never translated (ADR-014). The structured direction codes are copied so
 * the patient app can render them into its own locale, and
 * `directionsAuthored` is copied so the app can show exactly what the doctor
 * reviewed when the locales happen to match. Doctor free text is copied with
 * its locale tag and is never translated.
 *
 * Idempotent: the projection is keyed by prescriptionId and the notification
 * uses a deterministic id, so a retry never duplicates either.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const { ensureVerificationToken } = require('./verificationToken');

const PROJECTION = 'patient_prescriptions';

/**
 * FCM fan-out. Same shape as onClinicalReferralCreated's sendFcmPush, including
 * the stale-token cleanup, so both notification paths behave identically.
 */
async function sendFcmPush(db, recipientUid, content) {
  const tokensSnap = await db
    .collection('users').doc(recipientUid).collection('fcmTokens').get();
  if (tokensSnap.empty) return { sent: 0, cleaned: 0 };

  const byLang = {};
  for (const doc of tokensSnap.docs) {
    const { token, language } = doc.data();
    if (!token) continue;
    const lang = language || 'ar';
    (byLang[lang] = byLang[lang] || []).push({ docId: doc.id, token });
  }

  const messaging = getMessaging();
  const titles = { en: content.titleEn, ar: content.titleAr, ku: content.titleKu };
  const bodies = { en: content.bodyEn, ar: content.bodyAr, ku: content.bodyKu };

  let sent = 0;
  let cleaned = 0;

  for (const [lang, tokenDocs] of Object.entries(byLang)) {
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: tokenDocs.map((t) => t.token),
        notification: {
          title: titles[lang] || titles.ar,
          body: bodies[lang] || bodies.ar,
        },
        data: { prescriptionId: content.prescriptionId || '' },
        webpush: {
          notification: { icon: '/icons/Icon-192.png', badge: '/icons/Icon-192.png' },
        },
      });
      sent += response.successCount;
      for (let i = 0; i < response.responses.length; i++) {
        if (response.responses[i].success) continue;
        const code = response.responses[i].error && response.responses[i].error.code;
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token') {
          try {
            await db.collection('users').doc(recipientUid)
              .collection('fcmTokens').doc(tokenDocs[i].docId).delete();
            cleaned++;
          } catch (_) { /* cleanup is best-effort */ }
        }
      }
    } catch (e) {
      console.error(`onPrescriptionIssued: fcm ${recipientUid}/${lang}: ${e.message}`);
    }
  }
  return { sent, cleaned };
}

/**
 * Reduces a prescription item to what the patient may see.
 *
 * Explicitly field-by-field rather than a spread, so a clinical field added to
 * the item model in future does NOT leak into the patient projection by
 * default. Widening this is a deliberate act.
 */
function projectItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {
    id: item.id || '',
    // Standardized identity — copied verbatim, never translated.
    displayName: item.displayName || '',
    genericName: item.genericName || null,
    brandName: item.brandName || null,
    strength: item.strength || null,
    strengthUnit: item.strengthUnit || null,
    dosageForm: item.dosageForm || null,
    // Language-neutral codes, so the patient app renders directions in the
    // patient's own locale rather than the doctor's.
    doseAmount: item.doseAmount ?? null,
    doseUnitCode: item.doseUnitCode || null,
    routeCode: item.routeCode || null,
    frequencyCode: item.frequencyCode || null,
    durationValue: item.durationValue ?? null,
    durationUnitCode: item.durationUnitCode || null,
    quantity: item.quantity ?? null,
    quantityUnitCode: item.quantityUnitCode || null,
    prn: item.prn === true,
    // Doctor free text, verbatim + its locale. Never translated.
    instructions: item.instructions || null,
    instructionsLocale: item.instructionsLocale || null,
    // What the doctor actually reviewed before issuing.
    directionsAuthored: item.directionsAuthored || null,
    sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : 0,
  };
  return out.displayName ? out : null;
}

function buildNotification(doctorName, itemCount) {
  const dr = doctorName || '';
  return {
    titleEn: 'New prescription',
    titleAr: 'وصفة طبية جديدة',
    titleKu: 'نوسخەی نوێ',
    bodyEn: `Dr. ${dr} issued a prescription with ${itemCount} medication(s).`,
    bodyAr: `أصدر د. ${dr} وصفة طبية تحتوي على ${itemCount} دواء.`,
    bodyKu: `د. ${dr} نوسخەیەکی دەرمانی دەرکرد کە ${itemCount} دەرمانی تێدایە.`,
  };
}

exports.onPrescriptionIssued = onDocumentUpdated(
  'prescriptions/{prescriptionId}',
  async (event) => {
    const before = event.data && event.data.before;
    const after = event.data && event.data.after;
    if (!before || !after || !after.exists) return;

    const prev = before.data() || {};
    const next = after.data() || {};

    // Only the draft -> issued edge. Every later update (print counters,
    // cancellation, supersession) is ignored here.
    if (prev.status === 'issued' || next.status !== 'issued') return;

    const prescriptionId = event.params.prescriptionId;
    const patientId = next.patientId;
    if (!patientId) {
      console.warn(`onPrescriptionIssued: ${prescriptionId} has no patientId`);
      return;
    }

    const db = getFirestore();
    const items = Array.isArray(next.items)
      ? next.items.map(projectItem).filter(Boolean)
      : [];

    // ── 0. Verification credential — Phase 7 (ADR-013 §8) ───────────────────
    // Minted here so EVERY issued prescription has one, not only the ones that
    // happen to get printed. The print path mints on demand as well, because a
    // doctor pressing Print two seconds after Issue cannot be made to wait on a
    // trigger; ensureVerificationToken is transactional, so whichever arrives
    // second reuses the first token rather than creating a second credential.
    //
    // Best-effort: a prescription that reaches the patient without a QR is far
    // better than one that never reaches them at all, so a failure here must
    // not stop the projection below.
    try {
      await ensureVerificationToken(db, prescriptionId);
    } catch (e) {
      console.error(`onPrescriptionIssued: token mint failed: ${e.message}`);
    }

    // ── 1. Patient projection ───────────────────────────────────────────────
    const ref = db.collection(PROJECTION).doc(prescriptionId);
    try {
      await ref.set({
        prescriptionId,
        patientId,
        appointmentId: next.appointmentId || '',
        centerId: next.centerId || '',

        // Prescriber + centre, so the patient can see who issued it.
        doctorId: next.doctorId || '',
        doctorName: next.doctorName || '',
        doctorSpecialty: next.doctorSpecialty || null,
        centerName: next.centerName || null,

        items,
        // General advice prints and displays; diagnosisNote deliberately does
        // not cross — it is doctor-visible only.
        patientInstructions: next.patientInstructions || null,

        status: next.status,
        issuedAt: next.issuedAt || FieldValue.serverTimestamp(),
        supersedes: next.supersedes || null,
        supersededBy: next.supersededBy || null,

        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        schemaVersion: 1,
      }, { merge: true });

      console.log(
        `onPrescriptionIssued: projected ${prescriptionId} patient=${patientId} items=${items.length}`,
      );
    } catch (e) {
      console.error(`onPrescriptionIssued: projection failed: ${e.message}`);
      return; // no projection, no notification — the patient has nothing to open
    }

    // ── 2. Patient notification ─────────────────────────────────────────────
    const content = buildNotification(next.doctorName, items.length);
    const notifId = `prescription_${prescriptionId}`;
    const notifRef = db
      .collection('users').doc(patientId).collection('notifications').doc(notifId);

    try {
      const existing = await notifRef.get();
      if (!existing.exists) {
        await notifRef.set({
          type: 'prescription_issued',
          prescriptionId,
          doctorName: next.doctorName || '',
          titleEn: content.titleEn,
          titleAr: content.titleAr,
          titleKu: content.titleKu,
          bodyEn: content.bodyEn,
          bodyAr: content.bodyAr,
          bodyKu: content.bodyKu,
          isRead: false,
          dismissed: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    } catch (e) {
      console.error(`onPrescriptionIssued: notification write failed: ${e.message}`);
    }

    // FCM is best-effort — a push failure must never undo the projection.
    try {
      const fcm = await sendFcmPush(db, patientId, { prescriptionId, ...content });
      console.log(`onPrescriptionIssued: fcm sent=${fcm.sent} cleaned=${fcm.cleaned}`);
    } catch (e) {
      console.error(`onPrescriptionIssued: fcm non-fatal: ${e.message}`);
    }
  },
);

exports.projectItem = projectItem;
