# TrustyDr Backend Functions

This project contains:
- Firestore rules
- Firebase Functions
- indexes
- backend validation
- security enforcement

Critical Responsibilities:
- enforce least privilege
- preserve immutable appointment architecture
- preserve denormalized snapshot model
- keep Firestore reads low-cost

Important:
- patientId != bookedByUserId
- bookedByUserId may represent staff
- patientId always represents actual patient

Never:
- weaken Firestore rules globally
- introduce broad authenticated access
- bypass ownership checks
- bypass center scope validation

Always:
- validate post-create reads
- validate stream query permissions
- validate BatchGet permissions
- add emulator regression tests before deployment

Important Files:
- firestore.rules
- firestore indexes
- appointment-related functions