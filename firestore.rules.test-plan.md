# Firestore Rules — Emulator Test Plan

## Setup

```bash
cd doctor_functions
firebase emulators:start --only firestore
```

Use the Firebase Rules Unit Testing library (`@firebase/rules-unit-testing`) or the
Emulator UI's Rules Playground with the test documents below.

---

## Test Identities

| Alias | uid | Role |
|---|---|---|
| `patient1` | `uid_patient1` | Regular user, no doctors doc |
| `doctor1` | `uid_doctor1` | Has `doctors/uid_doctor1` doc |
| `doctor2` | `uid_doctor2` | Has `doctors/uid_doctor2` doc, member of center1 |
| `adminUser` | `uid_admin` | `users/uid_admin.role == "admin"` |
| `unauthenticated` | — | No Firebase Auth token |

### Seed documents required

```
users/uid_admin           { role: "admin" }
users/uid_patient1        { role: "patient", phone: "07701234567" }
users/uid_doctor1         { role: "doctor" }
doctors/uid_doctor1       { name_en: "Dr Ali", isActive: true, subscriptionStatus: "trial" }
doctors/uid_doctor2       { name_en: "Dr Sara", isActive: true }
medical_centers/center1   { ownerId: "uid_doctor1", isActive: true, subscriptionStatus: "active" }
medical_centers/center1/members/uid_doctor2   { role: "receptionist" }
schedules/sched1          { doctorId: "uid_doctor1", status: "published" }
schedules/sched2          { doctorId: "uid_doctor1", status: "draft" }
appointments/appt1        { patientId: "uid_patient1", doctorId: "uid_doctor1", centerId: "center1", source: "patient_app", status: "pending", visitStatus: "scheduled", paymentStatus: "unpaid" }
payments/pay1             { userId: "uid_doctor1", status: "pending" }
center_join_requests/req1 { doctorId: "uid_doctor1", centerId: "center1", status: "pending" }
```

---

## Test Cases

### 1. users collection

| # | Operation | Identity | Expected | Blocker ref |
|---|---|---|---|---|
| 1.1 | Read `users/uid_patient1` | `patient1` (own) | ✅ ALLOW | — |
| 1.2 | Read `users/uid_patient1` | `doctor1` (phone search) | ✅ ALLOW | — |
| 1.3 | Read `users/uid_patient1` | `adminUser` | ✅ ALLOW | — |
| 1.4 | Read `users/uid_patient1` | `unauthenticated` | ❌ DENY | — |
| 1.5 | Read `users/uid_doctor1` | `patient1` | ❌ DENY | — |
| 1.6 | Create `users/uid_patient1` with `role:"admin"` | `patient1` | ❌ DENY | Privilege escalation |
| 1.7 | Update `users/uid_patient1`, set `role:"admin"` | `patient1` | ❌ DENY | Privilege escalation |

### 2. doctors collection

| # | Operation | Identity | Expected |
|---|---|---|---|
| 2.1 | Read `doctors/uid_doctor1` | `patient1` | ✅ ALLOW |
| 2.2 | Update `doctors/uid_doctor1`, set `name_en:"New"` | `doctor1` (own) | ✅ ALLOW |
| 2.3 | Update `doctors/uid_doctor1`, set `isPaidUser:true` | `doctor1` (own) | ❌ DENY |
| 2.4 | Update `doctors/uid_doctor1`, set `subscriptionStatus:"active"` | `doctor1` (own) | ❌ DENY |
| 2.5 | Update `doctors/uid_doctor1`, set `isPaidUser:true` | `adminUser` | ✅ ALLOW |
| 2.6 | Update `doctors/uid_doctor2` | `doctor1` | ❌ DENY |

### 3. schedules collection

| # | Operation | Identity | Expected |
|---|---|---|---|
| 3.1 | Read published `sched1` | `patient1` | ✅ ALLOW |
| 3.2 | Read draft `sched2` | `doctor1` (owner) | ✅ ALLOW |
| 3.3 | Read draft `sched2` | `patient1` | ❌ DENY |
| 3.4 | Read draft `sched2` | `doctor2` (not owner) | ❌ DENY |
| 3.5 | Create schedule with `doctorId:"uid_doctor1"` | `doctor1` | ✅ ALLOW |
| 3.6 | Create schedule with `doctorId:"uid_doctor1"` | `patient1` | ❌ DENY |
| 3.7 | Update `sched1` | `doctor1` (owner) | ✅ ALLOW |
| 3.8 | Update `sched1` | `doctor2` | ❌ DENY |

### 4. appointments collection

| # | Operation | Identity | Expected | Notes |
|---|---|---|---|---|
| 4.1 | Read `appt1` | `patient1` (patientId match) | ✅ ALLOW | |
| 4.2 | Read `appt1` | `doctor1` (doctorId match) | ✅ ALLOW | |
| 4.3 | Read `appt1` | `doctor2` (center member) | ✅ ALLOW | |
| 4.4 | Read `appt1` | `unauthenticated` | ❌ DENY | |
| 4.5 | Read `appt1` | `adminUser` | ✅ ALLOW | |
| 4.6 | Create with `source:"patient_app"`, correct fields | `patient1` | ✅ ALLOW | Path A |
| 4.7 | Create with `source:"patient_app"`, `bookedByRole:"doctor"` | `patient1` | ❌ DENY | |
| 4.8 | Create with `source:"walk_in"`, booker is center member | `doctor2` | ✅ ALLOW | Path B |
| 4.9 | Create with `source:"walk_in"`, booker NOT center member | `doctor1` | ❌ DENY | |
| 4.10 | Update `appt1`, set `status:"confirmed"` | `doctor1` (doctorId) | ✅ ALLOW | |
| 4.11 | Update `appt1`, set `visitStatus:"checked_in"` | `doctor2` (center member) | ✅ ALLOW | |
| 4.12 | Update `appt1`, set `doctorId:"uid_other"` | `doctor1` | ❌ DENY | Core field |
| 4.13 | Update `appt1`, set `status:"cancelled"` | `patient1` | ✅ ALLOW | Patient cancel |
| 4.14 | Update `appt1`, set `visitStatus:"done"` | `patient1` | ❌ DENY | Patient can't update visit |
| 4.15 | Update `appt1`, set `paymentStatus:"paid"` | `patient1` | ❌ DENY | Patient can't mark paid |

### 5. medical_centers collection

| # | Operation | Identity | Expected |
|---|---|---|---|
| 5.1 | Read `center1` | `patient1` | ✅ ALLOW |
| 5.2 | Create new center with `ownerId:"uid_doctor1"` | `doctor1` | ✅ ALLOW |
| 5.3 | Create new center | `patient1` | ❌ DENY |
| 5.4 | Update `center1`, set `name_en:"New Name"` | `doctor1` (owner) | ✅ ALLOW |
| 5.5 | Update `center1`, set `subscriptionStatus:"active"` | `doctor1` (owner) | ❌ DENY |
| 5.6 | Update `center1`, set `subscriptionStatus:"active"` | `adminUser` | ✅ ALLOW |
| 5.7 | Read `center1/members/uid_doctor2` | `doctor2` (member) | ✅ ALLOW |
| 5.8 | Write `center1/members/uid_new` | `doctor2` (member, not owner) | ❌ DENY |
| 5.9 | Write `center1/members/uid_new` | `doctor1` (owner) | ✅ ALLOW |

### 6. payments collection

| # | Operation | Identity | Expected |
|---|---|---|---|
| 6.1 | Read `pay1` | `doctor1` (userId match) | ✅ ALLOW |
| 6.2 | Read `pay1` | `patient1` | ❌ DENY |
| 6.3 | Read `pay1` | `adminUser` | ✅ ALLOW |
| 6.4 | Update `pay1`, set `status:"completed"` | `doctor1` | ❌ DENY |
| 6.5 | Update `pay1`, set `status:"completed"` | `adminUser` | ✅ ALLOW |

### 7. center_join_requests collection

| # | Operation | Identity | Expected |
|---|---|---|---|
| 7.1 | Read `req1` | `doctor1` (doctorId match) | ✅ ALLOW |
| 7.2 | Read `req1` | `patient1` | ❌ DENY |
| 7.3 | Create request with `doctorId:"uid_doctor1"`, `status:"pending"` | `doctor1` | ✅ ALLOW |
| 7.4 | Create request with `status:"approved"` | `doctor1` | ❌ DENY |
| 7.5 | Update `req1`, set `status:"approved"` | `doctor1` (owner) | ✅ ALLOW (center owner) |
| 7.6 | Update `req1`, set `status:"approved"` | `patient1` | ❌ DENY |

### 8. Implicit deny — unlisted collections

| # | Operation | Identity | Expected |
|---|---|---|---|
| 8.1 | Read `patients/uid_patient1` | `patient1` | ❌ DENY |
| 8.2 | Write `patients/uid_patient1` | `patient1` | ❌ DENY |
| 8.3 | Read `slotUsage/any` | `adminUser` | ❌ DENY |

---

## Deploy Command

```bash
cd doctor_functions
firebase use doctorapp-7e8b3
firebase deploy --only firestore:rules
```

---

## Open Blockers (not fixed by rules alone)

| # | Blocker | What's still needed |
|---|---|---|
| 4 | `patient_directory.dart` reads all users | Rules allow admin read — but the admin portal code should be audited to confirm it sends the admin role in the request token |
| 9 | `zaincashCallback` HTTP endpoint has no Firebase auth | Add HMAC/signature verification or IP allowlist in the Cloud Function before setting `MOCK_MODE = false` |
