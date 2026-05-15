const admin = require("firebase-admin");
const path = require('path');

admin.initializeApp({
  credential: admin.credential.cert(
    require(
      path.join(
        __dirname,
        'doctorapp-7e8b3-firebase-adminsdk-fbsvc-32f7844f03.json'
      )
    )
  ),
});

const db = admin.firestore();

export const attachDoctorOwnership = onDocumentWritten(
  "doctors/{doctorId}",
  async (event) => {

    const after = event.data?.after?.data();
    const before = event.data?.before?.data();

    if (!after) return;

    const doctorId = event.params.doctorId;

    // ✅ Only run when doctor becomes ACTIVE
    const becameActive =
      after.status === "active" &&
      (!before || before.status !== "active");

    if (!becameActive) return;

    // ✅ Skip if already attached
    if (after.userId && after.claimedByUserId) {
      console.log("Ownership already attached.");
      return;
    }

    console.log("Attaching ownership for doctor:", doctorId);

    const doctorRef = admin
      .firestore()
      .collection("doctors")
      .doc(doctorId);

    await doctorRef.update({
      userId: doctorId,
      claimedByUserId: doctorId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("Ownership attached successfully.");
  }
);

attachDoctorOwnership();
