'use strict';

// ─── Lifecycle eligibility pure functions ─────────────────────────────────────
// Owned by the lifecycle domain.
// Consumed by publicDoctorSanitizer and any module that needs lifecycle-aware checks.
// No Firestore reads — pure data functions only.

const BLOCKED_STATUSES = ['deletionPending', 'deleted', 'archived'];

// Returns true if the doctor's lifecycle state permits public profile visibility.
// A doctor in deletionPending must never appear in public_doctors.
// Legacy documents without accountLifecycle are treated as active (null-safe).
function isDoctorPubliclyEligible(data) {
  if (!data) return false;
  const lifecycle = data.accountLifecycle;
  if (!lifecycle) return true;
  if (BLOCKED_STATUSES.includes(lifecycle.status)) return false;
  if (lifecycle.doctorState?.publicProfileHidden === true) return false;
  return true;
}

// Returns true if new appointments can be booked against this doctor.
function isDoctorBookingPermitted(data) {
  const lifecycle = data?.accountLifecycle;
  if (!lifecycle) return true;
  if (BLOCKED_STATUSES.includes(lifecycle.status)) return false;
  if (lifecycle.doctorState?.bookingDisabled === true) return false;
  return true;
}

// Returns true if a patient account is in a state that allows booking.
function isPatientBookingPermitted(data) {
  const lifecycle = data?.accountLifecycle;
  if (!lifecycle) return true;
  if (['deletionPending', 'deleted'].includes(lifecycle.status)) return false;
  return true;
}

module.exports = {
  isDoctorPubliclyEligible,
  isDoctorBookingPermitted,
  isPatientBookingPermitted,
};
