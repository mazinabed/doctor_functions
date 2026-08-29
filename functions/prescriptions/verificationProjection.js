'use strict';

/**
 * The public verification projection — Prescription Platform Phase 7
 * (ADR-013 §8).
 *
 * ── What this page is, and what it is not ───────────────────────────────────
 *
 * TrustyDr confirms that the displayed information matches a prescription
 * record issued through TrustyDr. It does NOT certify clinical appropriateness,
 * and it does NOT determine whether a pharmacy may legally dispense. Every
 * decision in this file follows from that boundary:
 *
 *   - No diagnosis. `diagnosisNote` is doctor-visible only and is not in any
 *     projection, here or in `patient_prescriptions`.
 *   - No "Expired". Dispensing eligibility is jurisdictional, and TrustyDr has
 *     not implemented verified jurisdiction rules — so an old prescription is
 *     reported as "issued N days ago" with an advisory that the pharmacist must
 *     determine eligibility. Inventing a universal expiry would be TrustyDr
 *     making a regulatory determination it has no basis for.
 *   - No write path. Nothing here, and nothing in the callable that uses it,
 *     can change a prescription's status. An anonymous scanner must never be
 *     able to mark a prescription dispensed.
 *
 * ── Why field-by-field ──────────────────────────────────────────────────────
 *
 * Same discipline as `onPrescriptionIssued.projectItem`, and for a stronger
 * reason: this projection is readable by anyone holding the QR. A spread would
 * mean any clinical field added to the prescription model in future silently
 * becomes public. Widening this is a deliberate act.
 */

/**
 * The point at which the page starts advising the pharmacist to check
 * eligibility.
 *
 * This is an ADVISORY TRIGGER, not a rule. It does not mark anything expired,
 * invalid or undispensable — it prompts a human to apply the requirements that
 * actually govern them. Changing this number changes when advice appears; it
 * never changes a prescription's status.
 */
const ADVISORY_AGE_DAYS = 30;

/**
 * Masks a patient name to what a pharmacist needs to match the person standing
 * in front of them, and no more.
 *
 * First given name in full, every following part reduced to an initial:
 * "Ahmed Hassan Ali" -> "Ahmed H. A.". Whitespace-separated, so Arabic and
 * Kurdish names mask the same way Latin ones do.
 *
 * A single-part name is shown as-is: there is nothing to mask, and blanking it
 * would leave the pharmacist unable to do the one check this page exists for.
 */
function maskPatientName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return [parts[0], ...parts.slice(1).map((p) => `${Array.from(p)[0]}.`)]
    .join(' ');
}

/**
 * Last four digits only. Enough to confirm the phone the patient reads out
 * matches the record; never enough to contact them from this page.
 */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `••••${digits.slice(-4)}`;
}

/** Whole days between issue and now, floored at 0 for clock skew. */
function ageInDays(issuedAtMs, nowMs) {
  if (!issuedAtMs) return null;
  const days = Math.floor((nowMs - issuedAtMs) / 86400000);
  return days < 0 ? 0 : days;
}

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  return null;
}

/**
 * One medication line, exactly as issued.
 *
 * Identity is copied verbatim — a standardized name is never translated
 * (ADR-014). The language-neutral direction codes travel too, so the
 * verification page renders directions in the READER's language rather than the
 * doctor's, and `directionsAuthored` travels so the page can show precisely
 * what the prescriber approved.
 */
function projectVerificationItem(item) {
  if (!item || typeof item !== 'object') return null;
  const displayName = item.displayName || '';
  if (!displayName) return null;
  return {
    displayName,
    genericName: item.genericName || null,
    brandName: item.brandName || null,
    strength: item.strength || null,
    strengthUnit: item.strengthUnit || null,
    dosageForm: item.dosageForm || null,

    doseAmount: item.doseAmount ?? null,
    doseUnitCode: item.doseUnitCode || null,
    routeCode: item.routeCode || null,
    frequencyCode: item.frequencyCode || null,
    durationValue: item.durationValue ?? null,
    durationUnitCode: item.durationUnitCode || null,
    quantity: item.quantity ?? null,
    quantityUnitCode: item.quantityUnitCode || null,
    prn: item.prn === true,

    instructions: item.instructions || null,
    instructionsLocale: item.instructionsLocale || null,
    directionsAuthored: item.directionsAuthored || null,
    sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : 0,
  };
}

/**
 * The furthest-along electronic dispensing state across every pharmacy this
 * prescription was sent to.
 *
 * Only meaningful for TrustyDr-connected pharmacies. An outside pharmacy has no
 * electronic record here at all, which is precisely why the printed sheet
 * carries a manual PHARMACY USE block — absence of a dispensing record means
 * "TrustyDr does not know", never "not dispensed".
 */
const DISPENSE_ORDER = [
  'sent', 'received', 'checkedIn', 'preparing', 'ready', 'dispensed',
  'completed',
];

function summarizeDispensing(requests) {
  if (!Array.isArray(requests) || requests.length === 0) return null;

  let best = null;
  let bestRank = -2; // below the -1 an unrecognised status scores
  for (const r of requests) {
    if (!r) continue;
    // An unrecognised status ranks -1: still ahead of "nothing seen", so a
    // transmission whose status this code does not know about is reported as a
    // transmission rather than silently becoming "never sent to a pharmacy".
    // Getting that backwards would tell a pharmacist TrustyDr has no record of
    // a prescription it did in fact transmit.
    const rank = DISPENSE_ORDER.indexOf(r.partnerStatus || r.status || '');
    if (rank > bestRank) {
      bestRank = rank;
      best = r;
    }
  }
  if (!best) return null;

  const status = best.partnerStatus || best.status || '';
  return {
    status,
    // A pharmacist verifying a sheet needs to know WHICH pharmacy already acted
    // on it — that is the whole value of showing this at all.
    pharmacyName: best.partnerName_en || best.partnerNameEn || null,
    updatedAtMs: toMillis(best.updatedAt) || toMillis(best.createdAt),
    isDispensed: status === 'dispensed' || status === 'completed',
    pharmacyCount: requests.length,
  };
}

/**
 * Builds the complete public payload.
 *
 * @param {object} args
 * @param {string} args.prescriptionId
 * @param {object} args.prescription  raw prescription document data
 * @param {Array}  [args.clinicalRequests] pharmacy transmissions, if any
 * @param {number} args.nowMs
 */
function buildVerificationProjection({
  prescriptionId,
  prescription,
  clinicalRequests,
  nowMs,
}) {
  const d = prescription || {};
  const issuedAtMs = toMillis(d.issuedAt);
  const age = ageInDays(issuedAtMs, nowMs);

  const items = Array.isArray(d.items)
    ? d.items.map(projectVerificationItem).filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    : [];

  return {
    // Identity of the record, for comparison against the paper.
    referenceNumber: String(prescriptionId || '').slice(-6).toUpperCase(),

    // ── Status ───────────────────────────────────────────────────────────────
    // 'issued' | 'cancelled' | 'superseded'. A draft can never reach this
    // projection: the callable refuses to verify one, because an unissued
    // prescription is not a document anybody should be holding.
    status: d.status || '',
    issuedAtMs,
    ageDays: age,
    cancelledAtMs: toMillis(d.cancelledAt),

    // Whether a newer prescription replaced this one. Deliberately a boolean
    // and not the replacement's id: the holder of THIS token has no claim on
    // another prescription's contents, and the pharmacist's action either way
    // is to ask the patient for the current sheet.
    hasBeenSuperseded: d.status === 'superseded',

    // Advice, never a determination. See ADVISORY_AGE_DAYS.
    ageAdvisory: age !== null && age >= ADVISORY_AGE_DAYS,
    advisoryAfterDays: ADVISORY_AGE_DAYS,

    // ── Prescriber and centre ────────────────────────────────────────────────
    doctorName: d.doctorName || '',
    doctorSpecialty: d.doctorSpecialty || null,
    // Printed on the sheet already; it is the prescriber's professional
    // credential and is what a pharmacist checks the prescriber by.
    doctorLicenseNumber: d.doctorLicenseNumber || null,
    centerName: d.centerName || null,
    centerAddress: d.centerAddress || null,
    // So a pharmacist with a question can call the issuing clinic directly
    // rather than guessing.
    centerPhone: d.centerPhone || null,

    // ── Patient, masked ──────────────────────────────────────────────────────
    patientNameMasked: maskPatientName(d.patientName),
    patientPhoneMasked: maskPhone(d.patientPhone),

    // ── Exactly what was issued ──────────────────────────────────────────────
    items,
    patientInstructions: d.patientInstructions || null,

    // ── Electronic dispensing, when TrustyDr knows ───────────────────────────
    dispensing: summarizeDispensing(clinicalRequests),

    // NOTE: diagnosisNote, patientId, appointmentId, centerId, doctorId,
    // createdByUid, printCount and verificationToken are all deliberately
    // absent. None of them help a pharmacist match a sheet, and every one of
    // them is either clinical or an internal identifier.
  };
}

module.exports = {
  ADVISORY_AGE_DAYS,
  DISPENSE_ORDER,
  maskPatientName,
  maskPhone,
  ageInDays,
  toMillis,
  projectVerificationItem,
  summarizeDispensing,
  buildVerificationProjection,
};
