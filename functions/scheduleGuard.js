const { onCall } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const db = getFirestore();
const schedulesCol = db.collection("schedules");
const appointmentsCol = db.collection("appointments");

// Baghdad is UTC+3 (no DST). All slot times are expressed in Baghdad local time.
const BAGHDAD_OFFSET_MINUTES = 3 * 60;

function toMinutes(hhmm) {
  if (!hhmm) return 0;
  const parts = hhmm.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || "0", 10);
}

// Convert a UTC Date to the equivalent Baghdad minutes-from-midnight.
function utcToLocalMinutes(date) {
  const utcMs = date.getTime();
  const localMs = utcMs + BAGHDAD_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMs);
  return localDate.getUTCHours() * 60 + localDate.getUTCMinutes();
}

// Convert a UTC Date to a Baghdad Date for weekday calculation.
function utcToLocalDate(date) {
  return new Date(date.getTime() + BAGHDAD_OFFSET_MINUTES * 60 * 1000);
}

// Map JS getUTCDay() (0=Sun) to Flutter DateTime.weekday (1=Mon, 7=Sun).
function jsWeekdayToFlutter(jsDay) {
  return jsDay === 0 ? 7 : jsDay;
}

// Check if a slot time (minutes from midnight, local) falls validly on a shift grid.
function isOnGrid(localMinutes, shift) {
  const start = toMinutes(shift.startTime);
  const end = toMinutes(shift.endTime);
  const duration = shift.slotDurationMinutes || 30;
  const breaks = shift.breaks || [];

  if (localMinutes < start || localMinutes >= end) return false;
  if ((localMinutes - start) % duration !== 0) return false;

  for (const brk of breaks) {
    const bStart = toMinutes(brk.startTime);
    const bEnd = toMinutes(brk.endTime);
    if (localMinutes >= bStart && localMinutes < bEnd) return false;
  }

  return true;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(aEnd) > toMinutes(bStart);
}

// Serialize a conflicting appointment for the client error payload.
function serializeConflict(doc) {
  const d = doc.data();
  return {
    appointmentId: doc.id,
    patientName: d.patientName || "",
    appointmentAt: d.appointmentAt.toDate().toISOString(),
    dateKey: d.dateKey || "",
  };
}

// Return active (non-cancelled, non-no_show) future appointments for a schedule.
async function futureApptsForSchedule(scheduleId, tx) {
  const now = new Date();
  const snap = await tx.get(
    appointmentsCol
      .where("scheduleId", "==", scheduleId)
      .where("appointmentAt", ">", now)
  );
  return snap.docs.filter((d) => {
    const s = (d.data().status || "").toLowerCase();
    const vs = (d.data().visitStatus || "").toLowerCase();
    return s !== "cancelled" && vs !== "no_show";
  });
}

// Return active future appointments for a doctor (all centers).
async function futureApptsForDoctor(doctorId, tx) {
  const now = new Date();
  const snap = await tx.get(
    appointmentsCol
      .where("doctorId", "==", doctorId)
      .where("appointmentAt", ">", now)
  );
  return snap.docs.filter((d) => {
    const s = (d.data().status || "").toLowerCase();
    const vs = (d.data().visitStatus || "").toLowerCase();
    return s !== "cancelled" && vs !== "no_show";
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. guardUpdateShift
//    Validates that structural changes to a shift don't break existing bookings,
//    then atomically writes the structural fields inside the same transaction.
//    If any appointment falls off-grid → block and return conflict list.
//    Non-structural metadata fields (price, capacity, etc.) are written by the
//    client separately after this callable returns {blocked: false}.
// ─────────────────────────────────────────────────────────────────────────────
exports.guardUpdateShift = onCall(
  { region: "us-central1" },
  async ({ auth, data }) => {
    if (!auth) throw new Error("unauthenticated");

    const {
      scheduleId,
      startTime,
      endTime,
      slotDurationMinutes,
      breaks,
      centerId: proposedCenterId,
    } = data;
    if (!scheduleId || !startTime || !endTime) {
      throw new Error("invalid-argument: scheduleId, startTime, endTime required");
    }

    const proposedFields = {
      startTime,
      endTime,
      slotDurationMinutes: slotDurationMinutes || 30,
      breaks: breaks || [],
    };

    return db.runTransaction(async (tx) => {
      const scheduleRef = schedulesCol.doc(scheduleId);
      const scheduleSnap = await tx.get(scheduleRef);

      if (!scheduleSnap.exists) {
        throw new Error("not-found: schedule not found");
      }
      const schedule = scheduleSnap.data();

      if (schedule.doctorId !== auth.uid) {
        throw new Error("permission-denied: not your schedule");
      }

      const futureAppts = await futureApptsForSchedule(scheduleId, tx);

      // Center change check — runs before grid check because a location conflict
      // is always blocking regardless of whether the appointment is on-grid.
      if (
        proposedCenterId &&
        proposedCenterId !== schedule.centerId &&
        futureAppts.length > 0
      ) {
        return {
          blocked: true,
          reason: "center_change_blocked",
          conflicts: futureAppts.map(serializeConflict),
        };
      }

      if (futureAppts.length > 0) {
        const newShift = { ...schedule, ...proposedFields };
        const conflicts = [];

        for (const doc of futureAppts) {
          const apptDate = doc.data().appointmentAt.toDate();
          const localMinutes = utcToLocalMinutes(apptDate);

          if (!isOnGrid(localMinutes, newShift)) {
            const conflict = serializeConflict(doc);
            conflicts.push(conflict);
          }
        }

        if (conflicts.length > 0) {
          return { blocked: true, reason: "off_grid", conflicts };
        }
      }

      // Validation passed — write structural fields atomically in this transaction.
      tx.update(scheduleRef, {
        ...proposedFields,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { blocked: false };
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. guardDeleteShift
//    Blocks deletion if any future active appointments exist for this schedule.
// ─────────────────────────────────────────────────────────────────────────────
exports.guardDeleteShift = onCall(
  { region: "us-central1" },
  async ({ auth, data }) => {
    if (!auth) throw new Error("unauthenticated");

    const { scheduleId } = data;
    if (!scheduleId) {
      throw new Error("invalid-argument: scheduleId required");
    }

    return db.runTransaction(async (tx) => {
      const scheduleRef = schedulesCol.doc(scheduleId);
      const scheduleSnap = await tx.get(scheduleRef);

      if (!scheduleSnap.exists) {
        throw new Error("not-found: schedule not found");
      }
      if (scheduleSnap.data().doctorId !== auth.uid) {
        throw new Error("permission-denied: not your schedule");
      }

      const futureAppts = await futureApptsForSchedule(scheduleId, tx);

      if (futureAppts.length > 0) {
        return {
          blocked: true,
          reason: "has_appointments",
          conflicts: futureAppts.map(serializeConflict),
        };
      }

      tx.delete(scheduleRef);
      return { blocked: false };
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. guardDisableDay
//    Blocks disabling a day if any future active appointments exist on that
//    day of the week for this doctor. If clear, marks all shifts for that day
//    as isDayDisabled=true, isActive=false.
// ─────────────────────────────────────────────────────────────────────────────
exports.guardDisableDay = onCall(
  { region: "us-central1" },
  async ({ auth, data }) => {
    if (!auth) throw new Error("unauthenticated");

    const { doctorId, dayOfWeek } = data;
    if (doctorId !== auth.uid) throw new Error("permission-denied");
    if (!dayOfWeek) throw new Error("invalid-argument: dayOfWeek required");

    return db.runTransaction(async (tx) => {
      const futureAppts = await futureApptsForDoctor(doctorId, tx);

      const conflicts = futureAppts
        .filter((doc) => {
          const d = doc.data();
          const localDate = utcToLocalDate(d.appointmentAt.toDate());
          return jsWeekdayToFlutter(localDate.getUTCDay()) === dayOfWeek;
        })
        .map(serializeConflict);

      if (conflicts.length > 0) {
        return { blocked: true, reason: "has_appointments", conflicts };
      }

      const shiftsSnap = await tx.get(
        schedulesCol
          .where("doctorId", "==", doctorId)
          .where("dayOfWeek", "==", dayOfWeek)
      );

      for (const doc of shiftsSnap.docs) {
        tx.update(doc.ref, {
          isDayDisabled: true,
          isActive: false,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return { blocked: false };
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. guardClearDay
//    Blocks clearing (deleting) a day's shifts if future active appointments
//    exist on that weekday for this doctor.
// ─────────────────────────────────────────────────────────────────────────────
exports.guardClearDay = onCall(
  { region: "us-central1" },
  async ({ auth, data }) => {
    if (!auth) throw new Error("unauthenticated");

    const { doctorId, dayOfWeek } = data;
    if (doctorId !== auth.uid) throw new Error("permission-denied");
    if (!dayOfWeek) throw new Error("invalid-argument: dayOfWeek required");

    return db.runTransaction(async (tx) => {
      const futureAppts = await futureApptsForDoctor(doctorId, tx);

      const conflicts = futureAppts
        .filter((doc) => {
          const d = doc.data();
          const localDate = utcToLocalDate(d.appointmentAt.toDate());
          return jsWeekdayToFlutter(localDate.getUTCDay()) === dayOfWeek;
        })
        .map(serializeConflict);

      if (conflicts.length > 0) {
        return { blocked: true, reason: "has_appointments", conflicts };
      }

      const shiftsSnap = await tx.get(
        schedulesCol
          .where("doctorId", "==", doctorId)
          .where("dayOfWeek", "==", dayOfWeek)
      );

      for (const doc of shiftsSnap.docs) {
        tx.delete(doc.ref);
      }

      return { blocked: false };
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. guardResetWeek
//    Blocks resetting (deleting all shifts for a doctor) if any future active
//    appointments exist for this doctor.
// ─────────────────────────────────────────────────────────────────────────────
exports.guardResetWeek = onCall(
  { region: "us-central1" },
  async ({ auth, data }) => {
    if (!auth) throw new Error("unauthenticated");

    const { doctorId } = data;
    if (doctorId !== auth.uid) throw new Error("permission-denied");

    return db.runTransaction(async (tx) => {
      const futureAppts = await futureApptsForDoctor(doctorId, tx);

      if (futureAppts.length > 0) {
        return {
          blocked: true,
          reason: "has_appointments",
          conflicts: futureAppts.map(serializeConflict),
        };
      }

      const shiftsSnap = await tx.get(
        schedulesCol.where("doctorId", "==", doctorId)
      );

      for (const doc of shiftsSnap.docs) {
        tx.delete(doc.ref);
      }

      return { blocked: false };
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 6. guardPublishDrafts
//    The most critical guard. Before atomically replacing all published shifts
//    with drafts, verifies that every future active appointment is still
//    on-grid with the new draft schedule.
//
//    Validation order:
//    1. Draft set must be non-empty.
//    2. Draft-vs-draft overlap check (same day of week).
//    3. For each future appointment: a draft shift for that weekday must exist
//       AND the appointment time must land on a valid slot in that draft.
//    4. Only if all checks pass → delete published, promote drafts.
// ─────────────────────────────────────────────────────────────────────────────
exports.guardPublishDrafts = onCall(
  { region: "us-central1" },
  async ({ auth, data }) => {
    if (!auth) throw new Error("unauthenticated");

    const { doctorId } = data;
    if (doctorId !== auth.uid) throw new Error("permission-denied");

    return db.runTransaction(async (tx) => {
      // Load all drafts for this doctor.
      const draftsSnap = await tx.get(
        schedulesCol
          .where("doctorId", "==", doctorId)
          .where("status", "==", "draft")
      );

      if (draftsSnap.empty) {
        throw new Error("no-drafts: No drafts to publish");
      }

      const drafts = draftsSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

      // Draft-vs-draft overlap check.
      for (let i = 0; i < drafts.length; i++) {
        for (let j = i + 1; j < drafts.length; j++) {
          const a = drafts[i];
          const b = drafts[j];
          if (
            a.dayOfWeek === b.dayOfWeek &&
            overlaps(a.startTime, a.endTime, b.startTime, b.endTime)
          ) {
            return {
              blocked: true,
              reason: "draft_overlap",
              conflicts: [
                {
                  dayOfWeek: a.dayOfWeek,
                  shift1: { id: a.id, start: a.startTime, end: a.endTime },
                  shift2: { id: b.id, start: b.startTime, end: b.endTime },
                },
              ],
            };
          }
        }
      }

      // Load all future active appointments for this doctor.
      const futureAppts = await futureApptsForDoctor(doctorId, tx);

      // Verify each appointment is still on-grid in the new draft schedule.
      const conflicts = [];
      for (const doc of futureAppts) {
        const d = doc.data();
        const apptDateUTC = d.appointmentAt.toDate();
        const localDate = utcToLocalDate(apptDateUTC);
        const flutterDay = jsWeekdayToFlutter(localDate.getUTCDay());
        const localMinutes = utcToLocalMinutes(apptDateUTC);

        const dayDrafts = drafts.filter((dr) => dr.dayOfWeek === flutterDay);

        if (dayDrafts.length === 0) {
          // No draft covers this weekday — appointment is orphaned.
          conflicts.push({ ...serializeConflict(doc), reason: "no_schedule_for_day" });
          continue;
        }

        const coveredByAny = dayDrafts.some((dr) => isOnGrid(localMinutes, dr));
        if (!coveredByAny) {
          conflicts.push({ ...serializeConflict(doc), reason: "off_grid" });
        }
      }

      if (conflicts.length > 0) {
        return { blocked: true, reason: "appointment_conflicts", conflicts };
      }

      // Load existing published shifts to hard-delete.
      const publishedSnap = await tx.get(
        schedulesCol
          .where("doctorId", "==", doctorId)
          .where("status", "==", "published")
      );

      for (const doc of publishedSnap.docs) {
        tx.delete(doc.ref);
      }

      for (const draft of drafts) {
        tx.update(draft.ref, {
          status: "published",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return { blocked: false, published: drafts.length };
    });
  }
);
