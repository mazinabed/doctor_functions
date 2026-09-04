// const { onDocumentWritten } = require("firebase-functions/v2/firestore");
// const { onDocumentCreated } = require("firebase-functions/v2/firestore");
// const { initializeApp } = require("firebase-admin/app");
// const { getFirestore } = require("firebase-admin/firestore");

// initializeApp();
// const db = getFirestore();

// exports.updateDoctorRating = onDocumentWritten(
//   "doctors/{doctorId}/reviews/{reviewId}",
//   async (event) => {
//     const doctorId = event.params.doctorId;
//     const doctorRef = db.collection("doctors").doc(doctorId);
//     const reviewsSnap = await doctorRef.collection("reviews").get();

//     const totalReviews = reviewsSnap.size;
//     if (totalReviews === 0) {
//       await doctorRef.update({
//         ratingAverage: 0,
//         ratingCount: 0,
//       });
//       return;
//     }

//     let totalRating = 0;
//     reviewsSnap.forEach((doc) => {
//       totalRating += doc.data().rating || 0;
//     });

//     const avgRating = totalRating / totalReviews;

//     await doctorRef.update({
//       ratingAverage: parseFloat(avgRating.toFixed(1)),
//       ratingCount: totalReviews,
//     });

//     console.log(
//       `✅ Doctor ${doctorId} rating updated → 
//       ${avgRating.toFixed(1)} (${totalReviews} reviews)`
//     );
//   }
// );


// exports.createDoctorWeeklySchedule = onDocumentCreated(
//   "doctors/{doctorId}",
//   async (event) => {
//     const doctorId = event.params.doctorId;
//     const doctorData = event.data.data();

//     if (!doctorData) {
//       console.log(`⚠️ No doctor data found for ${doctorId}`);
//       return;
//     }

//     const { city, province } = doctorData;

//     const schedulesRef = db.collection("schedules");
//     const existing = await schedulesRef
//       .where("doctorId", "==", doctorId)
//       .limit(1)
//       .get();

//     if (!existing.empty) {
//       console.log(`ℹ️ Schedules already exist for doctor ${doctorId}. Skipping creation.`);
//       return;
//     }

//     console.log(`🩺 Creating weekly schedules for doctor ${doctorId}...`);

//     const batch = db.batch();
//     const now = new Date().toISOString();

//     // Default schedule times — can be edited later by doctor via dashboard
//     const startTime = "09:00";
//     const endTime = "17:00";
//     const slotDurationMinutes = 30;
//     const capacityPerSlot = 5;

//     // Create 7 documents (Mon–Sun)
//     for (let day = 1; day <= 7; day++) {
//       const docRef = schedulesRef.doc();
//       batch.set(docRef, {
//         doctorId,
//         province: province || "Unknown",
//         city: city || "Unknown",
//         dayOfWeek: day,
//         startTime,
//         endTime,
//         slotDurationMinutes,
//         capacityPerSlot,
//         status: "clinic",
//         createdAt: now,
//         updatedAt: now,
//       });
//     }

//     await batch.commit();
//     console.log(`✅ 7 schedules created successfully for doctor ${doctorId}`);
//   }
// );


// --------------------------------------------------
// Imports & Initialization
// // --------------------------------------------------
// const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
// const { onRequest } = require("firebase-functions/v2/https");
// const { defineString } = require("firebase-functions/params");
// const { initializeApp } = require("firebase-admin/app");
// const { getFirestore } = require("firebase-admin/firestore");
// const axios = require("axios");

// const cheerio = require("cheerio");

// // Initialize Firebase Admin SDK
// initializeApp();
// const db = getFirestore();

// // Secure config: set this via environment / console
// const PLACES_API_KEY = defineString("PLACES_API_KEY");

// // --------------------------------------------------
// // 1. UPDATE DOCTOR RATING WHEN REVIEW ADDED/UPDATED
// // --------------------------------------------------
// exports.updateDoctorRating = onDocumentWritten(
//   "doctors/{doctorId}/reviews/{reviewId}",
//   async (event) => {
//     try {
//       const doctorId = event.params.doctorId;
//       const doctorRef = db.collection("doctors").doc(doctorId);
//       const reviewsSnap = await doctorRef.collection("reviews").get();

//       const totalReviews = reviewsSnap.size;
//       if (totalReviews === 0) {
//         await doctorRef.update({
//           ratingAverage: 0,
//           ratingCount: 0,
//         });
//         console.log(`ℹ️ Doctor ${doctorId} has no reviews, reset rating.`);
//         return;
//       }

//       let totalRating = 0;
//       reviewsSnap.forEach((doc) => {
//         totalRating += doc.data().rating || 0;
//       });

//       const avgRating = totalRating / totalReviews;

//       await doctorRef.update({
//         ratingAverage: parseFloat(avgRating.toFixed(1)),
//         ratingCount: totalReviews,
//       });

//       console.log(
//         `✅ Rating updated for doctor ${doctorId}: ${avgRating.toFixed(
//           1
//         )} (${totalReviews} reviews)`
//       );
//     } catch (error) {
//       console.error("❌ Error updating doctor rating:", error);
//     }
//   }
// );

// // --------------------------------------------------
// // 2. CREATE WEEKLY SCHEDULE (VERIFIED, APP DOCTORS ONLY)
// // --------------------------------------------------
// exports.createDoctorWeeklySchedule = onDocumentCreated(
//   "doctors/{doctorId}",
//   async (event) => {
//     try {
//       const doctorId = event.params.doctorId;
//       const doctorData = event.data.data();

//       if (!doctorData) {
//         console.log(`⚠️ No doctor data found for ${doctorId}`);
//         return;
//       }

//       // Only create schedules for:
//       // - Verified doctors
//       // - Source from the app / dashboard (not Google, not Facebook)
//       const isVerified = doctorData.isVerified === true || doctorData.verified === true;
//       const sourceType = (doctorData.sourceType || "app").toString();

//       if (!isVerified) {
//         console.log(`⛔ Skipping schedule: Doctor ${doctorId} is unverified`);
//         return;
//       }

//       if (sourceType !== "app") {
//         console.log(
//           `⛔ Skipping schedule: Doctor ${doctorId} imported from external source (${sourceType})`
//         );
//         return;
//       }

//       const schedulesRef = db.collection("schedules");
//       const existing = await schedulesRef
//         .where("doctorId", "==", doctorId)
//         .limit(1)
//         .get();

//       if (!existing.empty) {
//         console.log(
//           `ℹ️ Schedules already exist for doctor ${doctorId}. Skipping creation.`
//         );
//         return;
//       }

//       console.log(`🩺 Creating weekly schedules for doctor ${doctorId}...`);

//       const batch = db.batch();
//       const now = new Date().toISOString();

//       const city = doctorData.city || doctorData.city_en || "Unknown";
//       const province = doctorData.province || doctorData.province_key || "Unknown";

//       // Default schedule (can be later edited in dashboard)
//       const startTime = "09:00";
//       const endTime = "17:00";
//       const slotDurationMinutes = 30;
//       const capacityPerSlot = 5;

//       for (let day = 1; day <= 7; day++) {
//         const docRef = schedulesRef.doc();
//         batch.set(docRef, {
//           doctorId,
//           province,
//           city,
//           dayOfWeek: day, // 1–7 (Mon–Sun or your choice)
//           startTime,
//           endTime,
//           slotDurationMinutes,
//           capacityPerSlot,
//           status: "clinic",
//           createdAt: now,
//           updatedAt: now,
//         });
//       }

//       await batch.commit();
//       console.log(`✅ Weekly schedules created for doctor ${doctorId}`);
//     } catch (error) {
//       console.error("❌ Error creating weekly schedule:", error);
//     }
//   }
// );

// --------------------------------------------------
// 3. ADD / UPDATE UNVERIFIED DOCTOR (Manual / External)
//    - Can be used by admin tools
//    - For Google Places: if googlePlaceId is provided → docId = googlePlaceId
// --------------------------------------------------
// exports.addUnverifiedDoctor = onRequest(async (req, res) => {
//   try {
//     const body = req.body || {};

//     const name = body.name || "Unknown Clinic";
//     const specialty = body.specialty || "General Practice";
//     const city = body.city || "Unknown";
//     const province = body.province || "Unknown";
//     const sourceType = body.sourceType || "manual"; // 'app', 'google_places', 'facebook', etc.

//     const address = body.address || "";
//     const phone = body.phone || "";
//     const imageUrl = body.imageUrl || "";
//     const latitude = body.latitude ?? null;
//     const longitude = body.longitude ?? null;

//     const googlePlaceId = body.googlePlaceId || null;
//     const facebookPageId = body.facebookPageId || null;

//     let docRef;

//     // Strategy 1: For Google Places, use place_id as document ID
//     if (googlePlaceId) {
//       docRef = db.collection("doctors").doc(googlePlaceId);
//     } else {
//       // For manual / other imports, allow auto ID
//       docRef = db.collection("doctors").doc();
//     }

//     const now = new Date().toISOString();

//     const payload = {
//       name,
//       specialty,
//       specialty_lower: specialty.toString().toLowerCase(),
//       city,
//       province,
//       address,
//       phone,
//       imageUrl,
//       latitude,
//       longitude,

//       // Unverified by default
//       isVerified: false,
//       verificationStatus: "unverified",
//       sourceType,
//       canBook: false,
//       canCall: !!phone,

//       sourceIds: {
//         googlePlaceId: googlePlaceId || null,
//         facebookPageId: facebookPageId || null,
//       },

//       // Timestamps
//       updatedAt: now,
//     };

//     // If new doc, also set createdAt
//     const existingSnap = await docRef.get();
//     if (!existingSnap.exists) {
//       payload.createdAt = now;
//     }

//     await docRef.set(payload, { merge: true });

//     return res.json({
//       success: true,
//       message: existingSnap.exists
//         ? "Updated existing unverified doctor"
//         : "Unverified doctor added",
//       docId: docRef.id,
//     });
//   } catch (err) {
//     console.error("❌ Error in addUnverifiedDoctor:", err);
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });

// --------------------------------------------------
// Helper: Import ONE Google Place → Doctor document
// - Uses place_id as Firestore document ID
// - Safe to call multiple times → will update, not duplicate
// --------------------------------------------------
// async function importGooglePlaceClinic(city, place) {
//   if (!place || !place.place_id) return null;

//   const placeId = place.place_id;
//   const now = new Date().toISOString();

//   const name = place.name || "Unknown Clinic";
//   const address = place.formatted_address || "";
//   const lat = place.geometry?.location?.lat ?? null;
//   const lng = place.geometry?.location?.lng ?? null;

//   // Build a Google photo URL if available
//   let imageUrl = "";
//   if (place.photos && place.photos.length > 0) {
//     const photoRef = place.photos[0].photo_reference;
//     if (photoRef) {
//       imageUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${photoRef}&key=${PLACES_API_KEY.value()}`;
//     }
//   }

//   const docRef = db.collection("doctors").doc(placeId);
//   const snapshot = await docRef.get();

//   const payload = {
//     name,
//     specialty: "General Practice",
//     specialty_lower: "general practice",
//     city,
//     province: city, // you can later map to real province if needed
//     address,
//     imageUrl,
//     latitude: lat,
//     longitude: lng,

//     isVerified: false,
//     verificationStatus: "unverified",
//     sourceType: "google_places",
//     canBook: false,
//     canCall: false, // Google Text Search API doesn't return phone here

//     sourceIds: {
//       googlePlaceId: placeId,
//       facebookPageId: null,
//     },

//     updatedAt: now,
//   };

//   if (!snapshot.exists) {
//     payload.createdAt = now;
//   }

//   await docRef.set(payload, { merge: true });

//   return placeId;
// }

// // --------------------------------------------------
// // 4. GOOGLE PLACES SEARCH → IMPORT UNVERIFIED DOCTORS (No duplicates)
// //    - HTTP: GET /fetchGooglePlacesClinics?city=Baghdad
// // --------------------------------------------------
// exports.fetchGooglePlacesClinics = onRequest(async (req, res) => {
//   try {
//     const city = (req.query.city || "").toString().trim();
//     if (!city) {
//       return res.status(400).json({
//         success: false,
//         error: "Missing ?city= parameter",
//       });
//     }

//     console.log(`🌍 Fetching Google Places clinics for city: ${city}`);

//     const url =
//       `https://maps.googleapis.com/maps/api/place/textsearch/json` +
//       `?query=clinic+doctor+medical+center+in+${encodeURIComponent(city)}` +
//       `&key=${PLACES_API_KEY.value()}`;

//     const response = await axios.get(url);
//     const results = response.data.results || [];

//     const imported = [];

//     for (const place of results) {
//       const docId = await importGooglePlaceClinic(city, place);
//       if (docId) imported.push(docId);
//     }

//     console.log(
//       `✅ Google Places import complete for ${city}. Imported/updated: ${imported.length}`
//     );

//     return res.json({
//       success: true,
//       city,
//       importedCount: imported.length,
//       imported,
//     });
//   } catch (err) {
//     console.error("❌ Error in fetchGooglePlacesClinics:", err);
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });

// // --------------------------------------------------
// // 5. SYNC CITY CLINICS (Alias / More Explicit Endpoint)
// //    - Same behavior as fetchGooglePlacesClinics
// //    - HTTP: GET /syncCityClinics?city=Baghdad
// // --------------------------------------------------
// exports.syncCityClinics = onRequest(async (req, res) => {
//   try {
//     const city = (req.query.city || "").toString().trim();
//     if (!city) {
//       return res
//         .status(400)
//         .json({ success: false, error: "Missing ?city=BAGHDAD" });
//     }

//     console.log(`🚀 Syncing Google Places data for city: ${city}`);

//     const url =
//       `https://maps.googleapis.com/maps/api/place/textsearch/json` +
//       `?query=clinic+doctor+medical+center+in+${encodeURIComponent(city)}` +
//       `&key=${PLACES_API_KEY.value()}`;

//     const response = await axios.get(url);
//     const results = response.data.results || [];

//     let imported = 0;
//     const ids = [];

//     for (const place of results) {
//       const docId = await importGooglePlaceClinic(city, place);
//       if (docId) {
//         imported++;
//         ids.push(docId);
//       }
//     }

//     console.log(
//       `✅ syncCityClinics finished for ${city}. Imported/updated: ${imported}`
//     );

//     return res.json({
//       success: true,
//       city,
//       importedCount: imported,
//       ids,
//     });
//   } catch (err) {
//     console.error("❌ Error in syncCityClinics:", err);
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });





// exports.scrapeFacebookClinic = onRequest(async (req, res) => {
//   try {
//     const pageUrl = req.body.pageUrl;

//     if (!pageUrl) {
//       return res.status(400).json({
//         success: false,
//         error: "Missing pageUrl",
//       });
//     }

//     console.log("🌐 Scraping Facebook page:", pageUrl);

//     // Fetch raw HTML
//     const response = await axios.get(pageUrl, {
//       headers: {
//         "User-Agent": "Mozilla/5.0",
//       },
//     });

//     const html = response.data;
//     const $ = cheerio.load(html);

//     // Extract PUBLIC data (safe)
//     const name =
//       $('meta[property="og:title"]').attr("content") ||
//       $("title").text() ||
//       "Unknown Clinic";

//     const imageUrl = $('meta[property="og:image"]').attr("content") || "";

//     const description =
//       $('meta[property="og:description"]').attr("content") ||
//       "";

//     // Extract phone number from raw text
//     let phone = "";
//     const phoneRegex = /(\+?\d[\d\s\-()]{7,})/g;
//     const matches = html.match(phoneRegex);
//     if (matches) {
//       phone = matches[0];
//     }

//     // Extract address (Facebook exposes it in meta tags or JSON-LD)
//     let address = "";
//     const addressRegex = /"street_address":"([^"]+)"/;
//     const addrMatch = html.match(addressRegex);
//     if (addrMatch && addrMatch[1]) {
//       address = addrMatch[1];
//     }

//     // Build Firestore object
//     const clinicData = {
//       name,
//       address,
//       phone,
//       description,
//       imageUrl,
//       city: "Unknown",
//       province: "Unknown",
//       specialty: "General Practice",
//       isVerified: false,
//       verificationStatus: "unverified",
//       sourceType: "facebook_scrape",
//       canBook: false,
//       canCall: phone !== "",
//       sourceIds: {
//         facebookPageId: pageUrl,
//       },
//       createdAt: new Date().toISOString(),
//       updatedAt: new Date().toISOString(),
//     };

//     // Save to Firestore
//     const docRef = await db.collection("doctors").add(clinicData);

//     return res.json({
//       success: true,
//       clinicId: docRef.id,
//       data: clinicData,
//     });
//   } catch (err) {
//     console.error("❌ Error scraping Facebook:", err.message);

//     return res.status(500).json({
//       success: false,
//       error: err.message,
//     });
//   }
// });






// // const { onDocumentWritten, onDocumentCreated } =
// //   require("firebase-functions/v2/firestore");
// // const functions = require("firebase-functions"); // for callable
// // const axios = require("axios");

// // const { initializeApp } = require("firebase-admin/app");
// // const { getFirestore, FieldValue } =
// //   require("firebase-admin/firestore");

// // initializeApp();
// // const db = getFirestore();

// // /* =========================================================
// //    🔒 ZAINCASH – CALLABLE PAYMENT CREATION
// //    ========================================================= */

// // // 🔒 Server-side plans (DO NOT trust client)
// // const PLANS = {
// //   "1m": { months: 1, amount: 30000 },
// //   "6m": { months: 6, amount: 132000 },
// //   "12m": { months: 12, amount: 240000 },
// // };

// // exports.createZainCashPayment = functions.https.onCall(
// //   async (data, context) => {
// //     if (!context.auth) {
// //       throw new functions.https.HttpsError(
// //         "unauthenticated",
// //         "Login required"
// //       );
// //     }

// //     const uid = context.auth.uid;
// //     const planCode = data.planCode;

// //     if (!PLANS[planCode]) {
// //       throw new functions.https.HttpsError(
// //         "invalid-argument",
// //         "Invalid plan"
// //       );
// //     }

// //     const plan = PLANS[planCode];
// //     const config = functions.config().zaincash;

// //     const orderId = `order_${uid}_${Date.now()}`;

// //     // 1️⃣ Save pending payment
// //     await db.collection("payments").doc(orderId).set({
// //       uid,
// //       planCode,
// //       amount: plan.amount,
// //       months: plan.months,
// //       status: "pending",
// //       createdAt: FieldValue.serverTimestamp(),
// //     });

// //     // 2️⃣ Create ZainCash payment
// //     const payload = {
// //       merchantId: config.merchant_id,
// //       amount: plan.amount,
// //       serviceType: "Doctor Subscription",
// //       orderId,
// //       redirectUrl: config.redirect_url,
// //       msisdn: config.msisdn,
// //       lang: "en",
// //     };

// //     const response = await axios.post(
// //       "https://api.zaincash.iq/transaction/init",
// //       payload,
// //       {
// //         headers: {
// //           Authorization: `Bearer ${config.secret}`,
// //         },
// //       }
// //     );

// //     if (!response.data?.paymentUrl) {
// //       throw new functions.https.HttpsError(
// //         "internal",
// //         "Failed to create payment"
// //       );
// //     }

// //     return {
// //       paymentUrl: response.data.paymentUrl,
// //       orderId,
// //     };
// //   }
// // );

// /* =========================================================
//    ⭐ DOCTOR RATING – FIRESTORE TRIGGER
//    ========================================================= */

// exports.updateDoctorRating = onDocumentWritten(
//   "doctors/{doctorId}/reviews/{reviewId}",
//   async (event) => {
//     const doctorId = event.params.doctorId;
//     const doctorRef = db.collection("doctors").doc(doctorId);
//     const reviewsSnap = await doctorRef.collection("reviews").get();

//     const totalReviews = reviewsSnap.size;
//     if (totalReviews === 0) {
//       await doctorRef.update({
//         ratingAverage: 0,
//         ratingCount: 0,
//       });
//       return;
//     }

//     let totalRating = 0;
//     reviewsSnap.forEach((doc) => {
//       totalRating += doc.data().rating || 0;
//     });

//     const avgRating = totalRating / totalReviews;

//     await doctorRef.update({
//       ratingAverage: parseFloat(avgRating.toFixed(1)),
//       ratingCount: totalReviews,
//     });

//     console.log(
//       `✅ Doctor ${doctorId} rating updated → ${avgRating.toFixed(1)} (${totalReviews} reviews)`
//     );
//   }
// );

// /* =========================================================
//    🩺 CREATE WEEKLY SCHEDULE – FIRESTORE TRIGGER
//    ========================================================= */

// exports.createDoctorWeeklySchedule = onDocumentCreated(
//   "doctors/{doctorId}",
//   async (event) => {
//     const doctorId = event.params.doctorId;
//     const doctorData = event.data.data();

//     if (!doctorData) {
//       console.log(`⚠️ No doctor data found for ${doctorId}`);
//       return;
//     }

//     const { city, province } = doctorData;

//     const schedulesRef = db.collection("schedules");
//     const existing = await schedulesRef
//       .where("doctorId", "==", doctorId)
//       .limit(1)
//       .get();

//     if (!existing.empty) {
//       console.log(`ℹ️ Schedules already exist for doctor ${doctorId}`);
//       return;
//     }

//     console.log(`🩺 Creating weekly schedules for doctor ${doctorId}...`);

//     const batch = db.batch();
//     const now = new Date().toISOString();

//     const startTime = "09:00";
//     const endTime = "17:00";
//     const slotDurationMinutes = 30;
//     const capacityPerSlot = 5;

//     for (let day = 1; day <= 7; day++) {
//       const docRef = schedulesRef.doc();
//       batch.set(docRef, {
//         doctorId,
//         province: province || "Unknown",
//         city: city || "Unknown",
//         dayOfWeek: day,
//         startTime,
//         endTime,
//         slotDurationMinutes,
//         capacityPerSlot,
//         status: "clinic",
//         createdAt: now,
//         updatedAt: now,
//       });
//     }

//     await batch.commit();
//     console.log(`✅ 7 schedules created successfully for doctor ${doctorId}`);
//   }
// );


// const { onCall } = require("firebase-functions/v2/https");

// const { initializeApp } = require("firebase-admin/app");
// const { getFirestore, FieldValue } =
//   require("firebase-admin/firestore");

// initializeApp();
// const db = getFirestore();

// /*************************************************
//  * 🔒 PLANS (SOURCE OF TRUTH)
//  *************************************************/
// const PLANS = {
//   "1m":  { months: 1,  amount: 30000 },
//   "6m":  { months: 6,  amount: 132000 },
//   "12m": { months: 12, amount: 240000 },
// };

// /*************************************************
//  * 💳 CREATE PAYMENT (CALLABLE – MOCK)
//  *************************************************/
// exports.createZainCashPayment = onCall(
//   { region: "us-central1" },
//   async ({ auth, data }) => {
//     if (!auth) {
//       throw new Error("Unauthenticated");
//     }

//     const uid = auth.uid;
//     const planCode = data?.planCode;

//     const plan = PLANS[planCode];
//     if (!plan) {
//       throw new Error("Invalid plan");
//     }

//     const orderId = `mock_${uid}_${Date.now()}`;

//     await db.collection("payments").doc(orderId).set({
//       uid,
//       planCode,
//       amount: plan.amount,
//       months: plan.months,
//       status: "pending",
//       isMock: true,
//       createdAt: FieldValue.serverTimestamp(),
//     });

//     // 🔁 Fake payment URL (replace later)
//     return {
//       paymentUrl: "https://example.com/mock-payment-success",
//       orderId,
//     };
//   }
// );


// exports.finalizeZainCashPaymentHttp = onRequest(
//   { region: "us-central1" },
//   async (req, res) => {
//     try {
//       const { orderId } = req.body;

//       console.log("📦 finalizeZainCashPaymentHttp orderId =", orderId);

//       if (!orderId || typeof orderId !== "string") {
//         return res.status(400).json({
//           success: false,
//           error: "Missing or invalid orderId",
//         });
//       }

//       const paymentRef = db.collection("payments").doc(orderId);
//       const paymentSnap = await paymentRef.get();

//       if (!paymentSnap.exists) {
//         return res.status(404).json({
//           success: false,
//           error: "Payment not found",
//         });
//       }

//       const payment = paymentSnap.data();

//       if (payment.status === "completed") {
//         return res.json({ success: true, alreadyCompleted: true });
//       }

//       // 1️⃣ Mark payment completed
//       await paymentRef.update({
//         status: "completed",
//         completedAt: FieldValue.serverTimestamp(),
//       });

//       // 2️⃣ Activate doctor subscription
//       const now = new Date();
//       const nextBilling = new Date();
//       nextBilling.setMonth(nextBilling.getMonth() + payment.months);

//       await db.collection("doctors").doc(payment.uid).update({
//         subscriptionStatus: "active",
//         subscriptionPlan: payment.planCode,
//         subscriptionStartedAt: now,
//         nextBillingDate: nextBilling,
//       });

//       console.log("✅ Subscription activated for", payment.uid);

//       return res.json({ success: true });
//     } catch (err) {
//       console.error("❌ finalize error:", err);
//       return res.status(500).json({
//         success: false,
//         error: err.message,
//       });
//     }
//   }
// );


// const { onCall } = require("firebase-functions/v2/https");
// const { initializeApp } = require("firebase-admin/app");
// const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// initializeApp();
// const db = getFirestore();

// const PLANS = {
//   "1m":  { months: 1, amount: 30000 },
//   "6m":  { months: 6, amount: 132000 },
//   "12m": { months: 12, amount: 240000 },
// };

// exports.createZainCashPayment = onCall(
//   { region: "us-central1" },
//   async ({ auth, data }) => {
//     if (!auth) {
//       throw new Error("Unauthenticated");
//     }

//     const uid = auth.uid;
//     const planCode = data?.planCode;
//     const plan = PLANS[planCode];

//     if (!plan) {
//       throw new Error("Invalid plan");
//     }

//     const orderId = `mock_${uid}_${Date.now()}`;

//     await db.collection("payments").doc(orderId).set({
//       uid,
//       planCode,
//       amount: plan.amount,
//       months: plan.months,
//       status: "pending",
//       isMock: true,
//       createdAt: FieldValue.serverTimestamp(),
//     });

//     // ✅ THIS IS THE CRITICAL FIX
    
//  const paymentUrl =
//   `https://doctorapp-7e8b3.web.app/zaincash-mock-success.html#orderId=${orderId}`;

// return {
//   paymentUrl,
//   orderId,
// };

//   }
// );


// const { createZainCashPayment } = require("./payments/zaincash/createPayment");
// const { zaincashCallback } = require("./payments/zaincash/callback");

// exports.createZainCashPayment = createZainCashPayment;
// exports.zaincashCallback = zaincashCallback;



/* =====================================================
   Firebase Functions – Core Doctor Automation
   (RESTORED SAFELY – NO ZAINCASH)
   ===================================================== */

// const { onDocumentWritten, onDocumentCreated } =
//   require("firebase-functions/v2/firestore");
// const { onRequest } = require("firebase-functions/v2/https");
// const { defineString } = require("firebase-functions/params");

// const { initializeApp } = require("firebase-admin/app");
// const { getFirestore } = require("firebase-admin/firestore");

// const axios = require("axios");
// const cheerio = require("cheerio");

// initializeApp();
// const db = getFirestore();

// /* =====================================================
//    ENV
//    ===================================================== */
// const PLACES_API_KEY = defineString("PLACES_API_KEY");

// /* =====================================================
//    1️⃣ UPDATE DOCTOR RATING WHEN REVIEW CHANGES
//    ===================================================== */
// exports.updateDoctorRating = onDocumentWritten(
//   "doctors/{doctorId}/reviews/{reviewId}",
//   async (event) => {
//     try {
//       const doctorId = event.params.doctorId;
//       const doctorRef = db.collection("doctors").doc(doctorId);
//       const reviewsSnap = await doctorRef.collection("reviews").get();

//       const count = reviewsSnap.size;

//       if (count === 0) {
//         await doctorRef.update({
//           ratingAverage: 0,
//           ratingCount: 0,
//         });
//         return;
//       }

//       let total = 0;
//       reviewsSnap.forEach((doc) => {
//         total += doc.data().rating || 0;
//       });

//       const avg = total / count;

//       await doctorRef.update({
//         ratingAverage: Number(avg.toFixed(1)),
//         ratingCount: count,
//       });

//       console.log(`✅ Rating updated for doctor ${doctorId}`);
//     } catch (err) {
//       console.error("❌ updateDoctorRating failed:", err);
//     }
//   }
// );

// /* =====================================================
//    2️⃣ CREATE WEEKLY SCHEDULE (APP + VERIFIED ONLY)
//    ===================================================== */
// exports.createDoctorWeeklySchedule = onDocumentCreated(
//   "doctors/{doctorId}",
//   async (event) => {
//     try {
//       const doctorId = event.params.doctorId;
//       const data = event.data.data();
//       if (!data) return;

//       const isVerified =
//         data.isVerified === true || data.verified === true;
//       const sourceType = data.sourceType || "app";

//       if (!isVerified || sourceType !== "app") {
//         console.log(`⛔ Skipping schedule for ${doctorId}`);
//         return;
//       }

//       const schedulesRef = db.collection("schedules");
//       const exists = await schedulesRef
//         .where("doctorId", "==", doctorId)
//         .limit(1)
//         .get();

//       if (!exists.empty) return;

//       const batch = db.batch();
//       const now = new Date().toISOString();

//       for (let day = 1; day <= 7; day++) {
//         batch.set(schedulesRef.doc(), {
//           doctorId,
//           province: data.province || "Unknown",
//           city: data.city || "Unknown",
//           dayOfWeek: day,
//           startTime: "09:00",
//           endTime: "17:00",
//           slotDurationMinutes: 30,
//           capacityPerSlot: 5,
//           status: "clinic",
//           createdAt: now,
//           updatedAt: now,
//         });
//       }

//       await batch.commit();
//       console.log(`✅ Weekly schedules created for ${doctorId}`);
//     } catch (err) {
//       console.error("❌ createDoctorWeeklySchedule failed:", err);
//     }
//   }
// );

// /* =====================================================
//    3️⃣ ADD / UPDATE UNVERIFIED DOCTOR (ADMIN / IMPORT)
//    ===================================================== */
// exports.addUnverifiedDoctor = onRequest(async (req, res) => {
//   try {
//     const body = req.body || {};
//     const now = new Date().toISOString();

//     const docRef = body.googlePlaceId
//       ? db.collection("doctors").doc(body.googlePlaceId)
//       : db.collection("doctors").doc();

//     const snap = await docRef.get();

//     const payload = {
//       name: body.name || "Unknown Clinic",
//       specialty: body.specialty || "General Practice",
//       specialty_lower: (body.specialty || "").toLowerCase(),
//       city: body.city || "Unknown",
//       province: body.province || "Unknown",
//       address: body.address || "",
//       phone: body.phone || "",
//       imageUrl: body.imageUrl || "",
//       latitude: body.latitude ?? null,
//       longitude: body.longitude ?? null,
//       isVerified: false,
//       verificationStatus: "unverified",
//       sourceType: body.sourceType || "manual",
//       canBook: false,
//       canCall: !!body.phone,
//       sourceIds: {
//         googlePlaceId: body.googlePlaceId || null,
//         facebookPageId: body.facebookPageId || null,
//       },
//       updatedAt: now,
//     };

//     if (!snap.exists) payload.createdAt = now;

//     await docRef.set(payload, { merge: true });

//     res.json({ success: true, docId: docRef.id });
//   } catch (err) {
//     console.error("❌ addUnverifiedDoctor failed:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// /* =====================================================
//    4️⃣ GOOGLE PLACES IMPORT
//    ===================================================== */
// async function importGooglePlace(city, place) {
//   if (!place?.place_id) return null;

//   const id = place.place_id;
//   const now = new Date().toISOString();

//   let imageUrl = "";
//   if (place.photos?.length) {
//     imageUrl =
//       `https://maps.googleapis.com/maps/api/place/photo` +
//       `?maxwidth=400&photo_reference=${place.photos[0].photo_reference}` +
//       `&key=${PLACES_API_KEY.value()}`;
//   }

//   const ref = db.collection("doctors").doc(id);
//   const snap = await ref.get();

//   const payload = {
//     name: place.name || "Unknown Clinic",
//     specialty: "General Practice",
//     specialty_lower: "general practice",
//     city,
//     province: city,
//     address: place.formatted_address || "",
//     imageUrl,
//     latitude: place.geometry?.location?.lat ?? null,
//     longitude: place.geometry?.location?.lng ?? null,
//     isVerified: false,
//     verificationStatus: "unverified",
//     sourceType: "google_places",
//     canBook: false,
//     canCall: false,
//     sourceIds: { googlePlaceId: id },
//     updatedAt: now,
//   };

//   if (!snap.exists) payload.createdAt = now;

//   await ref.set(payload, { merge: true });
//   return id;
// }

// exports.fetchGooglePlacesClinics = onRequest(async (req, res) => {
//   try {
//     const city = req.query.city;
//     if (!city) return res.status(400).json({ error: "Missing city" });

//     const url =
//       `https://maps.googleapis.com/maps/api/place/textsearch/json` +
//       `?query=clinic+doctor+in+${encodeURIComponent(city)}` +
//       `&key=${PLACES_API_KEY.value()}`;

//     const r = await axios.get(url);
//     const ids = [];

//     for (const place of r.data.results || []) {
//       const id = await importGooglePlace(city, place);
//       if (id) ids.push(id);
//     }

//     res.json({ success: true, imported: ids.length, ids });
//   } catch (err) {
//     console.error("❌ fetchGooglePlacesClinics failed:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// exports.syncCityClinics = exports.fetchGooglePlacesClinics;

// /* =====================================================
//    5️⃣ FACEBOOK CLINIC SCRAPER
//    ===================================================== */
// exports.scrapeFacebookClinic = onRequest(async (req, res) => {
//   try {
//     const pageUrl = req.body.pageUrl;
//     if (!pageUrl) return res.status(400).json({ error: "Missing pageUrl" });

//     const html = (await axios.get(pageUrl, {
//       headers: { "User-Agent": "Mozilla/5.0" },
//     })).data;

//     const $ = cheerio.load(html);

//     const payload = {
//       name: $('meta[property="og:title"]').attr("content") || "Clinic",
//       imageUrl: $('meta[property="og:image"]').attr("content") || "",
//       description: $('meta[property="og:description"]').attr("content") || "",
//       isVerified: false,
//       verificationStatus: "unverified",
//       sourceType: "facebook_scrape",
//       createdAt: new Date().toISOString(),
//       updatedAt: new Date().toISOString(),
//     };

//     const ref = await db.collection("doctors").add(payload);
//     res.json({ success: true, id: ref.id });
//   } catch (err) {
//     console.error("❌ scrapeFacebookClinic failed:", err);
//     res.status(500).json({ error: err.message });
//   }
// });





// const functions = require('firebase-functions');
// const admin = require('firebase-admin');
// const cors = require('cors')({ origin: true });
// const fetch = require('node-fetch');

// admin.initializeApp();

// exports.adminImportGoogleClinics = functions
//   .region('us-central1')
//   .https.onRequest((req, res) => {
//     cors(req, res, async () => {
//       try {
//         const city = req.query.city;

//         if (!city) {
//           return res.status(400).json({ error: 'city is required' });
//         }

//         const apiKey = functions.config().google.places_key;

//         if (!apiKey) {
//           return res.status(500).json({ error: 'Google Places API key not set' });
//         }

//         // 🔍 Google Places Text Search (CHEAP)
//         const url =
//           `https://maps.googleapis.com/maps/api/place/textsearch/json` +
//           `?query=${encodeURIComponent(city + ' hospital')}` +
//           `&key=${apiKey}`;

//         const response = await fetch(url);
//         const data = await response.json();

//         if (!data.results) {
//           return res.status(500).json({ error: 'Invalid Google response' });
//         }

//         const db = admin.firestore();
//         let importedCount = 0;

//         for (const place of data.results) {
//           if (!place.place_id || !place.geometry?.location) continue;

//           const docRef = db
//             .collection('clinic_discovery')
//             .doc(place.place_id);

//           const exists = await docRef.get();
//           if (exists.exists) continue; // prevent duplicates

//           await docRef.set({
//             name: place.name || '',
//             name_lower: (place.name || '').toLowerCase(),

//             address: place.formatted_address || '',
//             city: city,

//             latitude: place.geometry.location.lat,
//             longitude: place.geometry.location.lng,

//             specialty: 'General Practice',
//             specialty_lower: 'general practice',

//             sourceType: 'google_places',
//             sourceId: place.place_id,

//             isPlaceholder: true,

//             createdAt: admin.firestore.FieldValue.serverTimestamp(),
//           });

//           importedCount++;
//         }

//         return res.json({
//           success: true,
//           count: importedCount,
//         });
//       } catch (err) {
//         console.error(err);
//         return res.status(500).json({ error: err.message });
//       }
//     });
//   });


// const { onRequest } = require("firebase-functions/v2/https");
// const { defineSecret } = require("firebase-functions/params");
// const admin = require("firebase-admin");
// const cors = require("cors")({ origin: true });

// const GOOGLE_PLACES_KEY = defineSecret("GOOGLE_PLACES_KEY");

// admin.initializeApp();

// exports.adminImportGoogleClinics = onRequest(
//   {
//     region: "us-central1",
//     secrets: [GOOGLE_PLACES_KEY],
//   },
//   (req, res) => {
//     cors(req, res, async () => {
//       try {
//         // ✅ 1. Read city from query
//         const city = req.query.city;

//         if (!city || typeof city !== "string") {
//           return res.status(400).json({
//             error: "Query parameter ?city= is required",
//           });
//         }

//         // ✅ 2. Read secret safely
//         const apiKey = GOOGLE_PLACES_KEY.value();

//         if (!apiKey) {
//           return res.status(500).json({
//             error: "GOOGLE_PLACES_KEY missing",
//           });
//         }

//         // ✅ 3. Build Google Places request
//         const url =
//           `https://maps.googleapis.com/maps/api/place/textsearch/json` +
//           `?query=${encodeURIComponent(`${city} hospital`)}` +
//           `&key=${apiKey}`;

//         const response = await fetch(url);
//         const data = await response.json();

//         if (!Array.isArray(data.results)) {
//           console.error("❌ Google response:", data);
//           return res.status(500).json({
//             error: "Invalid Google Places response",
//             status: data.status,
//           });
//         }

//         const db = admin.firestore();
//         let importedCount = 0;

//         // ✅ 4. Save clinics
//         for (const place of data.results) {
//           if (!place.place_id || !place.geometry?.location) continue;

//           const docRef = db
//             .collection("clinic_discovery")
//             .doc(place.place_id);

//           const exists = await docRef.get();
//           if (exists.exists) continue;

//           await docRef.set({
//             name: place.name || "",
//             name_lower: (place.name || "").toLowerCase(),
//             address: place.formatted_address || "",
//             city: city,
//             latitude: place.geometry.location.lat,
//             longitude: place.geometry.location.lng,
//             specialty: "General Practice",
//             specialty_lower: "general practice",
//             sourceType: "google_places",
//             sourceId: place.place_id,
//             isPlaceholder: true,
//             createdAt: admin.firestore.FieldValue.serverTimestamp(),
//           });

//           importedCount++;
//         }

//         return res.json({
//           success: true,
//           city,
//           imported: importedCount,
//         });
//       } catch (err) {
//         console.error("🔥 adminImportGoogleClinics failed:", err);
//         return res.status(500).json({
//           error: err.message,
//         });
//       }
//     });
//   }
// );


// const { onRequest } = require("firebase-functions/v2/https");
// const { defineSecret } = require("firebase-functions/params");
// const admin = require("firebase-admin");
// const cors = require("cors")({ origin: true });

// const GOOGLE_PLACES_KEY = defineSecret("GOOGLE_PLACES_KEY");

// // ✅ Load your JSON file (put it in functions/iraq_cities.json)
// const IRAQ = require("./iraq_cities.json");

// admin.initializeApp();

// function sleep(ms) {
//   return new Promise((r) => setTimeout(r, ms));
// }

// exports.adminBulkImportGoogleClinics = onRequest(
//   {
//     region: "us-central1",
//     secrets: [GOOGLE_PLACES_KEY],
//     timeoutSeconds: 540, // up to 9 minutes
//   },
//   (req, res) => {
//     cors(req, res, async () => {
//       try {
//         const apiKey = GOOGLE_PLACES_KEY.value();
//         if (!apiKey) {
//           return res.status(500).json({ error: "GOOGLE_PLACES_KEY missing" });
//         }

//         const db = admin.firestore();

//         // Optional: allow limiting for testing
//         // ?limit=5  (imports only first 5 cities total)
//         const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;

//         // Optional: import only one province key
//         // ?province=baghdad
//         const onlyProvinceKey = req.query.province
//           ? String(req.query.province)
//           : null;

//         const provinces = IRAQ?.cities || {};
//         const summary = [];
//         let processedCities = 0;
//         let totalImported = 0;

//         for (const [provinceKey, provinceObj] of Object.entries(provinces)) {
//           if (onlyProvinceKey && onlyProvinceKey !== provinceKey) continue;

//           const province_en = provinceObj?.name_en || "";
//           const province_ar = provinceObj?.lang?.ar || "";
//           const province_ku = provinceObj?.lang?.ku || "";

//           const subCities = Array.isArray(provinceObj?.subCities)
//             ? provinceObj.subCities
//             : [];

//           for (const cityObj of subCities) {
//             if (limit && processedCities >= limit) break;

//             const city_en = cityObj?.en || "";
//             const city_ar = cityObj?.ar || "";
//             const city_ku = cityObj?.ku || "";

//             if (!city_en) continue;

//             console.log(`📍 Importing: ${city_en} (${province_en})`);

//             // ✅ Query Google using English name (most reliable)
//             const url =
//               `https://maps.googleapis.com/maps/api/place/textsearch/json` +
//               `?query=${encodeURIComponent(`${city_en} hospital`)}` +
//               `&key=${apiKey}`;

//             const response = await fetch(url);
//             const data = await response.json();

//             if (!Array.isArray(data.results)) {
//               console.error("❌ Google response invalid:", data);
//               summary.push({
//                 provinceKey,
//                 city_en,
//                 imported: 0,
//                 googleStatus: data?.status || "unknown",
//               });
//               processedCities++;
//               await sleep(1500);
//               continue;
//             }

//             let imported = 0;

//             for (const place of data.results) {
//               if (!place.place_id || !place.geometry?.location) continue;

//               const docRef = db.collection("google_doctors").doc(place.place_id);
//               const exists = await docRef.get();
//               if (exists.exists) continue;

//               await docRef.set({
//                 name: place.name || "",
//                 name_lower: (place.name || "").toLowerCase(),
//                 address: place.formatted_address || "",

//                 // ✅ Store province + city in multiple languages
//                 provinceKey,
//                 province_en,
//                 province_ar,
//                 province_ku: province_ku || null,

//                 city_en,
//                 city_ar,
//                 city_ku: city_ku || null,

//                 // ✅ Useful searchable fields
//                 city_lower: city_en.toLowerCase(),
//                 province_lower: province_en.toLowerCase(),

//                 latitude: place.geometry.location.lat,
//                 longitude: place.geometry.location.lng,

//                 specialty: "General Practice",
//                 specialty_lower: "general practice",

//                 sourceType: "google_places",
//                 sourceId: place.place_id,
//                 isPlaceholder: true,

//                 createdAt: admin.firestore.FieldValue.serverTimestamp(),
//               });

//               imported++;
//             }

//             summary.push({
//               provinceKey,
//               city_en,
//               imported,
//               googleStatus: data?.status || "OK",
//             });

//             processedCities++;
//             totalImported += imported;

//             // ✅ Rate-limit protection (important)
//             await sleep(1500);
//           }

//           if (limit && processedCities >= limit) break;
//         }

//         return res.json({
//           success: true,
//           processedCities,
//           totalImported,
//           summary,
//         });
//       } catch (err) {
//         console.error("🔥 adminBulkImportGoogleClinics failed:", err);
//         return res.status(500).json({ error: err.message });
//       }
//     });
//   }

// );


// exports.adminCountGoogleDoctors = onRequest(
//   { region: "us-central1" },
//   async (req, res) => {
//     const snap = await admin
//       .firestore()
//       .collection("google_doctors")
//       .count()
//       .get();

//     res.json({ total: snap.data().count });
//   }
// );





// const { onRequest } = require("firebase-functions/v2/https");
// const admin = require("firebase-admin");
// const cors = require("cors")({ origin: true });
// const crypto = require("crypto");

// admin.initializeApp();

// /**
//  * ADMIN: Import clinic from Facebook page (minimal, safe)
//  * POST body:
//  * {
//  *   "pageUrl": "https://www.facebook.com/clinicname",
//  *   "city_en": "Hillah",          // optional
//  *   "city_ar": "الحلة",           // optional
//  *   "provinceKey": "babil"        // optional
//  * }
//  */
// exports.adminImportFacebookClinic = onRequest(
//   { region: "us-central1" },
//   (req, res) => {
//     cors(req, res, async () => {
//       try {
//         const { pageUrl, city_en, city_ar, provinceKey } = req.body || {};

//         if (!pageUrl) {
//           return res.status(400).json({ error: "pageUrl is required" });
//         }

        

//         // 🔑 Create stable sourceId from URL
//         const sourceId = crypto
//           .createHash("sha1")
//           .update(pageUrl)
//           .digest("hex");

//         const docId = `facebook_${sourceId}`;
//         const db = admin.firestore();
//         const docRef = db.collection("facebook_clinic_discovery").doc(docId);

//         // 🛑 Prevent duplicates
//         const exists = await docRef.get();
//         if (exists.exists) {
//           return res.json({
//             success: true,
//             skipped: true,
//             reason: "already_exists",
//             docId,
//           });
//         }

//         // 🌐 Fetch OpenGraph title only (safe)
//         const html = await fetch(pageUrl, {
//           headers: { "User-Agent": "Mozilla/5.0" },
//         }).then((r) => r.text());



// // 🔍 DEBUG MODE — inspect what Facebook actually returns
// if (req.query.debug === "true") {
//   const ogTitle = html.match(
//     /<meta property="og:title" content="([^"]+)"/i
//   )?.[1] || null;

//   const ogDescription = html.match(
//     /<meta property="og:description" content="([^"]+)"/i
//   )?.[1] || null;

//   const ogType = html.match(
//     /<meta property="og:type" content="([^"]+)"/i
//   )?.[1] || null;

//   return res.json({
//     debug: true,
//     pageUrl,
//     og: {
//       title: ogTitle,
//       description: ogDescription,
//       type: ogType,
//     },
//   });
// }

        

//         const titleMatch = html.match(
//           /<meta property="og:title" content="([^"]+)"/i
//         );

//         const name = titleMatch?.[1]?.trim() || "Clinic";

//         // 🧱 Build payload (NO extra fields)
//         const payload = {
//           name,
//           name_lower: name.toLowerCase(),

//           address: null,

//           city_en: city_en || null,
//           city_ar: city_ar || null,
//           city_ku: null,
//           city_lower: city_en ? city_en.toLowerCase() : null,

//           provinceKey: provinceKey || null,
//           province_en: null,
//           province_ar: null,
//           province_ku: null,
//           province_lower: provinceKey || null,

//           latitude: null,
//           longitude: null,

//           specialty: "General Practice",
//           specialty_lower: "general practice",

//           sourceType: "facebook",
//           sourceId,
//           sourceUrl: pageUrl,

//           isPlaceholder: true,
//           createdAt: admin.firestore.FieldValue.serverTimestamp(),
//         };

//         await docRef.set(payload);

//         return res.json({
//           success: true,
//           imported: 1,
//           docId,
//         });
//       } catch (err) {
//         console.error("🔥 adminImportFacebookClinic failed:", err);
//         return res.status(500).json({ error: err.message });
//       }
//     });
//   }
// );



// const { onRequest } = require("firebase-functions/v2/https");
// const { defineSecret } = require("firebase-functions/params");
// const admin = require("firebase-admin");
// const cors = require("cors")({ origin: true });

// const GOOGLE_PLACES_KEY = defineSecret("GOOGLE_PLACES_KEY");

// admin.initializeApp();

// exports.adminEnrichGoogleClinicPhones = onRequest(
//   {
//     region: "us-central1",
//     secrets: [GOOGLE_PLACES_KEY],
//     timeoutSeconds: 540, // allow long run
//   },
//   async (req, res) => {
//     cors(req, res, async () => {
//       try {
//         const apiKey = GOOGLE_PLACES_KEY.value();
//         const db = admin.firestore();

//         const snapshot = await db
//           .collection("google_doctors")
//           .where("sourceType", "==", "google_places")
//           .get();

//         let processed = 0;
//         let updated = 0;
//         let skipped = 0;

//         for (const doc of snapshot.docs) {
//           processed++;

//           const data = doc.data();

//           // Skip if no place_id or phone already exists
//           if (!data.sourceId || data.phone) {
//             skipped++;
//             continue;
//           }

//           const url =
//             `https://maps.googleapis.com/maps/api/place/details/json` +
//             `?place_id=${data.sourceId}` +
//             `&fields=formatted_phone_number` +
//             `&key=${apiKey}`;

//           const response = await fetch(url);
//           const json = await response.json();

//           if (
//             json.status !== "OK" ||
//             !json.result?.formatted_phone_number
//           ) {
//             continue;
//           }

//           await doc.ref.update({
//             phone: json.result.formatted_phone_number,
//             phoneSource: "google",
//             phoneVerified: false,
//           });

//           updated++;
//         }

//         return res.json({
//           success: true,
//           processed,
//           updated,
//           skipped,
//         });
//       } catch (err) {
//         console.error("🔥 Phone enrichment failed:", err);
//         return res.status(500).json({ error: err.message });
//       }
//     });
//   }
// );


const { onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const { isPublicEligible, buildPublicDoc } = require("./lib/publicDoctorSanitizer");
const { isProviderPublicEligible, buildPublicProviderDoc } = require("./lib/publicDiagnosticProviderSanitizer");
const { isPharmacyPublicEligible, buildPublicPharmacyDoc } = require("./lib/publicPharmacyProviderSanitizer");
const {
  OPERATIONAL_COLLECTION,
  OPERATIONAL_DOC_ID,
  buildOperationalStatus,
  operationalStatusChanged,
} = require("./lib/operationalStatusMirror");

exports.attachDoctorOwnership = onDocumentUpdated(
  "doctors/{doctorId}",
  async (event) => {

    const after = event.data.after.data();
    const before = event.data.before.data();
    const doctorId = event.params.doctorId;

    // Run ONLY when doctor becomes ACTIVE
    if (before?.status !== "active" && after?.status === "active") {

      // Already attached
      if (after.userId === doctorId && after.claimedByUserId === doctorId) {
        console.log("Ownership already attached.");
        return;
      }

      console.log("Attaching ownership for:", doctorId);

      await admin.firestore()
        .collection("doctors")
        .doc(doctorId)
        .update({
          userId: doctorId,
          claimedByUserId: doctorId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      console.log("Ownership attached.");
    }
  }
);

// ─── Sync safe public doctor profile ─────────────────────────────────────────
// Fires on every doctors/{doctorId} write (create, update, delete).
// Eligible doctors → write safe fields to public_doctors/{doctorId}.
// Ineligible or deleted → remove public_doctors/{doctorId}.
exports.syncPublicDoctor = onDocumentWritten(
  "doctors/{doctorId}",
  async (event) => {
    const doctorId = event.params.doctorId;
    const after = event.data.after;
    const publicRef = db.collection("public_doctors").doc(doctorId);

    // Doctor document deleted → remove public profile
    if (!after.exists) {
      await publicRef.delete();
      console.log(`public_doctors: removed ${doctorId} (source doc deleted)`);
      return;
    }

    const data = after.data();

    if (!isPublicEligible(data)) {
      const existing = await publicRef.get();
      if (existing.exists) {
        await publicRef.delete();
        console.log(`public_doctors: removed ${doctorId} — no longer eligible (status=${data.status})`);
      } else {
        console.log(`public_doctors: skipped ${doctorId} — ineligible (status=${data.status})`);
      }
      return;
    }

    const existing = await publicRef.get();
    const publicDoc = buildPublicDoc(doctorId, data, existing.exists ? existing.data() : null);
    await publicRef.set(publicDoc);
    console.log(`public_doctors: synced ${doctorId}`);
  }
);

// ─── Sync safe public diagnostic provider profile ─────────────────────────────
// Fires on every diagnostic_providers/{providerId} write (create, update, delete).
// Eligible providers → write safe fields to public_diagnostic_providers/{providerId}.
// Ineligible or deleted → remove public_diagnostic_providers/{providerId}.
//
// centerId resolution:
//   Lab schedules store centerId = <medical_centers doc ID> and doctorId = providerId.
//   The diagnostic_providers doc does not store centerId directly (legacy gap).
//   If data.centerId is absent, this trigger queries the provider's first published
//   schedule to find the real centerId, then writes it back to the private doc so
//   all subsequent triggers use data.centerId directly (no repeated query).
exports.syncPublicDiagnosticProvider = onDocumentWritten(
  "diagnostic_providers/{providerId}",
  async (event) => {
    const providerId = event.params.providerId;
    const after = event.data.after;
    const publicRef = db.collection("public_diagnostic_providers").doc(providerId);

    if (!after.exists) {
      await publicRef.delete();
      console.log(`public_diagnostic_providers: removed ${providerId} (source doc deleted)`);
      return;
    }

    const data = after.data();

    if (!isProviderPublicEligible(data)) {
      const existing = await publicRef.get();
      if (existing.exists) {
        await publicRef.delete();
        console.log(
          `public_diagnostic_providers: removed ${providerId} — ineligible ` +
          `(status=${data.status}, isActive=${data.isActive}, isVerified=${data.isVerified})`
        );
      } else {
        console.log(`public_diagnostic_providers: skipped ${providerId} — ineligible`);
      }
      return;
    }

    // Resolve centerId from schedules when the private doc doesn't have it.
    // Lab schedules are keyed by doctorId = providerId and carry centerId from
    // the medical_centers collection — these are different IDs.
    let resolvedCenterId = (typeof data.centerId === "string" && data.centerId.trim())
      ? data.centerId.trim()
      : null;

    if (!resolvedCenterId) {
      try {
        const schedSnap = await db.collection("schedules")
          .where("doctorId", "==", providerId)
          .where("status", "==", "published")
          .limit(1)
          .get();
        if (!schedSnap.empty) {
          const schedCenterId = schedSnap.docs[0].data().centerId;
          if (typeof schedCenterId === "string" && schedCenterId.trim()) {
            resolvedCenterId = schedCenterId.trim();
            // Write centerId back to private doc so future triggers skip this query.
            await db.collection("diagnostic_providers").doc(providerId).update({
              centerId: resolvedCenterId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`diagnostic_providers: wrote back centerId=${resolvedCenterId} for ${providerId}`);
          }
        }
      } catch (e) {
        console.warn(`public_diagnostic_providers: centerId schedule lookup failed for ${providerId}:`, e.message);
      }
    }

    const existing = await publicRef.get();
    const publicDoc = buildPublicProviderDoc(
      providerId,
      data,
      existing.exists ? existing.data() : null,
      resolvedCenterId
    );
    await publicRef.set(publicDoc);
    console.log(`public_diagnostic_providers: synced ${providerId} [${data.serviceGroup}] centerId=${publicDoc.centerId}`);
  }
);

// ─── Sync safe public pharmacy provider profile ───────────────────────────────
// Fires on every pharmacy_providers/{pharmacyId} write (create, update, delete).
// Eligible pharmacies → write safe fields to public_pharmacy_providers/{pharmacyId}.
// Ineligible or deleted → remove public_pharmacy_providers/{pharmacyId}.
//
// Eligibility: status === 'active' && isVerified === true.
// No centerId resolution needed — pharmacy does not use the schedules collection.
exports.syncPublicPharmacyProvider = onDocumentWritten(
  "pharmacy_providers/{pharmacyId}",
  async (event) => {
    const pharmacyId = event.params.pharmacyId;
    const after = event.data.after;
    const publicRef = db.collection("public_pharmacy_providers").doc(pharmacyId);

    if (!after.exists) {
      await publicRef.delete();
      console.log(`public_pharmacy_providers: removed ${pharmacyId} (source doc deleted)`);
      return;
    }

    const data = after.data();

    if (!isPharmacyPublicEligible(data)) {
      const existing = await publicRef.get();
      if (existing.exists) {
        await publicRef.delete();
        console.log(
          `public_pharmacy_providers: removed ${pharmacyId} — ineligible ` +
          `(status=${data.status}, isVerified=${data.isVerified})`
        );
      } else {
        console.log(`public_pharmacy_providers: skipped ${pharmacyId} — ineligible`);
      }
      return;
    }

    const existing = await publicRef.get();
    const publicDoc = buildPublicPharmacyDoc(
      pharmacyId,
      data,
      existing.exists ? existing.data() : null
    );
    await publicRef.set(publicDoc);
    console.log(`public_pharmacy_providers: synced ${pharmacyId}`);
  }
);

// ─── Provider operational-status mirror ───────────────────────────────────────
//
// Projects the five subscription fields the access gate consumes into
//
//   pharmacy_providers/{pharmacyId}/operational/status
//   diagnostic_providers/{labId}/operational/status
//
// so an ACTIVE pharmacy/lab staff member can resolve whether their employer may
// operate WITHOUT reading the parent provider document — which carries the
// owner's national ID number, ID and licence document URLs, and personal phone
// and email, and therefore stays owner-and-admin-only in firestore.rules.
//
// See lib/operationalStatusMirror.js for the projection and the do-not-add list.
//
// Deliberately separate triggers rather than an extension of
// syncPublicPharmacyProvider / syncPublicDiagnosticProvider: those two build a
// PATIENT-facing projection gated on `status === 'active' && isVerified`, and a
// lapsed or suspended organization is removed from them entirely — which is
// precisely the state the access gate must still be able to observe. Merging
// the two concerns would make the access decision depend on public-listing
// eligibility.

async function syncOperationalStatus(collectionName, providerId, event) {
  const before = event.data.before;
  const after = event.data.after;
  const mirrorRef = db
    .collection(collectionName)
    .doc(providerId)
    .collection(OPERATIONAL_COLLECTION)
    .doc(OPERATIONAL_DOC_ID);

  if (!after.exists) {
    await mirrorRef.delete();
    console.log(
      `${collectionName}/${providerId}/operational: removed (source doc deleted)`
    );
    return;
  }

  const nextData = after.data();

  // A profile edit, a rename or a document upload touches none of the mirrored
  // fields. Writing anyway would double the write cost of every provider save.
  // The mirror must still be created the first time even when nothing changed,
  // so an existence check precedes the no-op short-circuit.
  const mirrorSnap = await mirrorRef.get();
  if (
    mirrorSnap.exists &&
    before.exists &&
    !operationalStatusChanged(before.data(), nextData)
  ) {
    return;
  }

  const payload = buildOperationalStatus(nextData);
  payload.syncedAt = admin.firestore.FieldValue.serverTimestamp();

  await mirrorRef.set(payload);
  console.log(
    `${collectionName}/${providerId}/operational: synced ` +
    `(status=${payload.status}, subscriptionStatus=${payload.subscriptionStatus})`
  );
}

exports.syncPharmacyOperationalStatus = onDocumentWritten(
  "pharmacy_providers/{pharmacyId}",
  async (event) =>
    syncOperationalStatus("pharmacy_providers", event.params.pharmacyId, event)
);

exports.syncLabOperationalStatus = onDocumentWritten(
  "diagnostic_providers/{providerId}",
  async (event) =>
    syncOperationalStatus("diagnostic_providers", event.params.providerId, event)
);

// ─── Keep diagnostic_providers.centerId in sync with published schedules ───────
// Fires on every schedules/{scheduleId} write.
// When a schedule is published and its doctorId matches a diagnostic_providers doc,
// writes centerId back to that private doc. This is the persistent fix: once stored,
// the syncPublicDiagnosticProvider trigger above always has data.centerId available
// without needing to query schedules.
exports.syncLabCenterId = onDocumentWritten(
  "schedules/{scheduleId}",
  async (event) => {
    const after = event.data.after;
    if (!after.exists) return; // schedule deleted — nothing to sync

    const schedule = after.data();

    // Only act on published schedules for potential lab providers.
    if (schedule.status !== "published") return;

    const doctorId = schedule.doctorId;
    const centerId = schedule.centerId;

    if (!doctorId || !centerId) return;

    // Check whether doctorId matches a diagnostic_providers doc.
    const providerSnap = await db.collection("diagnostic_providers").doc(doctorId).get();
    if (!providerSnap.exists) return; // not a lab provider — normal doctor schedule

    const providerData = providerSnap.data();

    // Skip if centerId is already correctly stored.
    if (providerData.centerId === centerId) return;

    await db.collection("diagnostic_providers").doc(doctorId).update({
      centerId: centerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`diagnostic_providers: centerId synced from schedule — providerId=${doctorId} centerId=${centerId}`);
    // syncPublicDiagnosticProvider will fire next and push centerId to the public doc.
  }
);

// ─── Recalculate doctor rating when any review is written or deleted ──────────
// Updates ratingAverage + ratingCount on doctors/{doctorId}.
// syncPublicDoctor trigger then propagates those fields to public_doctors.
exports.updateDoctorRating = onDocumentWritten(
  "doctors/{doctorId}/reviews/{reviewId}",
  async (event) => {
    const doctorId = event.params.doctorId;
    const doctorRef = db.collection("doctors").doc(doctorId);
    const reviewsSnap = await doctorRef.collection("reviews").get();
    const count = reviewsSnap.size;

    if (count === 0) {
      await doctorRef.update({ ratingAverage: 0, ratingCount: 0 });
      console.log(`updateDoctorRating: ${doctorId} → reset (no reviews)`);
      return;
    }

    let total = 0;
    reviewsSnap.forEach((doc) => { total += doc.data().rating || 0; });
    const avg = parseFloat((total / count).toFixed(1));

    await doctorRef.update({ ratingAverage: avg, ratingCount: count });
    console.log(`updateDoctorRating: ${doctorId} → ${avg} (${count} reviews)`);
  }
);

const staffFunctions = require("./staff/activateStaffInvite");
exports.activateStaffInvite = staffFunctions.activateStaffInvite;

// Legal Consent Modernization (Phase 1 — account-level Patient + Provider
// Terms/Privacy).
const legalConsentFunctions = require("./legal/legalConsent");
exports.getAccountLegalStatus = legalConsentFunctions.getAccountLegalStatus;
exports.acceptAccountLegalDocument = legalConsentFunctions.acceptAccountLegalDocument;

// Legal Consent Modernization (Phase 2 — facility-level agreements: Medical
// Center / Pharmacy / Lab-Imaging).
const facilityLegalConsentFunctions = require("./legal/facilityLegalConsent");
exports.getFacilityLegalStatus = facilityLegalConsentFunctions.getFacilityLegalStatus;
exports.acceptFacilityLegalAgreement = facilityLegalConsentFunctions.acceptFacilityLegalAgreement;

const { lookupPatientByPhone } = require("./staff/lookupPatientByPhone");
exports.lookupPatientByPhone = lookupPatientByPhone;

const { expireCenters } = require("./expireCenters");
exports.expireCenters = expireCenters;

const { scheduleDailyHealthWeather } = require("./scheduleDailyHealthWeather");
exports.scheduleDailyHealthWeather = scheduleDailyHealthWeather;

// ─── Account Lifecycle Domain ──────────────────────────────────────────────────
const { requestAccountDeletion } = require("./lifecycle/requestAccountDeletion");
const { restoreAccount } = require("./lifecycle/restoreAccount");
const { requestCenterClosure } = require("./lifecycle/requestCenterClosure");
const { processScheduledDeletions } = require("./lifecycle/processScheduledDeletions");
const { processScheduledCenterClosures } = require("./lifecycle/processScheduledCenterClosures");
const { adminPlaceLegalHold } = require("./lifecycle/adminPlaceLegalHold");
const { adminForceDeletion } = require("./lifecycle/adminForceDeletion");

exports.requestAccountDeletion = requestAccountDeletion;
exports.restoreAccount = restoreAccount;
exports.requestCenterClosure = requestCenterClosure;
exports.processScheduledDeletions = processScheduledDeletions;
exports.processScheduledCenterClosures = processScheduledCenterClosures;
exports.adminPlaceLegalHold = adminPlaceLegalHold;
exports.adminForceDeletion = adminForceDeletion;

// ─── Appointment Reminder Domain ───────────────────────────────────────────────
const { sendDailyReminders } = require('./reminders/sendDailyReminders');
const { sendSameDayReminders } = require('./reminders/sendSameDayReminders');

exports.sendDailyReminders = sendDailyReminders;
exports.sendSameDayReminders = sendSameDayReminders;

// ─── Patient Referral Notifications Domain ─────────────────────────────────────
// Handles doctor-created external partner referrals:
//   onClinicalReferralCreated       — creates patient_referral_requests + notification
//   onClinicalReferralStatusUpdated — mirrors safe status fields on change
const { onClinicalReferralCreated } = require('./notifications/onClinicalReferralCreated');
const { onClinicalReferralStatusUpdated } = require('./notifications/onClinicalReferralStatusUpdated');

exports.onClinicalReferralCreated       = onClinicalReferralCreated;
exports.onClinicalReferralStatusUpdated = onClinicalReferralStatusUpdated;

// ─── Lab Appointment Notifications Domain ──────────────────────────────────────
// Handles patient-self-booked lab/imaging appointments (clinical_requests where
// source='scheduled' and createdByRole='patient'):
//   onLabAppointmentCreated       — sends 'request_sent' notification on booking
//   onLabAppointmentStatusUpdated — sends 'confirmed' or 'cancelled' on status change
const { onLabAppointmentCreated } = require('./notifications/onLabAppointmentCreated');
const { onLabAppointmentStatusUpdated } = require('./notifications/onLabAppointmentStatusUpdated');

exports.onLabAppointmentCreated       = onLabAppointmentCreated;
exports.onLabAppointmentStatusUpdated = onLabAppointmentStatusUpdated;

// ─── Pharmacy Operations Dashboard Notifications (Phase 1) ─────────────────────
// Friendly, transition-specific push to the patient whenever a pharmacy
// action (or patient cancellation) changes marketplace_orders.fulfillmentStatus
// — see onMarketplaceOrderFulfillmentUpdated.js's own header for the full
// "never before Odoo confirms + Firestore projection updates" contract.
const {
  onMarketplaceOrderFulfillmentUpdated,
} = require('./notifications/onMarketplaceOrderFulfillmentUpdated');
exports.onMarketplaceOrderFulfillmentUpdated = onMarketplaceOrderFulfillmentUpdated;

// ─── Doctor Appointment Workflow Notifications (Phase 4) ──────────────────────
// TrustyDr Workflow & Notification Platform -- see
// NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root. NEW trigger (no
// equivalent existed before this phase): friendly, stage-specific push to the
// patient whenever appointments.status/visitStatus changes to confirmed,
// in_service, done, no_show, or cancelled -- see
// onAppointmentStatusUpdated.js's own header for the full contract. Booking/
// reception/waiting-room/visit-completion/cancellation logic is untouched;
// appointment REMINDERS (above) remain a separate, untouched system.
const {
  onAppointmentStatusUpdated,
} = require('./notifications/onAppointmentStatusUpdated');
exports.onAppointmentStatusUpdated = onAppointmentStatusUpdated;

// ─── Schedule Guard Domain ─────────────────────────────────────────────────────
// Server-side enforcement for protected schedule operations.
// All six functions use Firestore transactions to atomically validate
// appointment conflicts before executing the schedule mutation.
const scheduleGuard = require("./scheduleGuard");

exports.guardUpdateShift    = scheduleGuard.guardUpdateShift;
exports.guardDeleteShift    = scheduleGuard.guardDeleteShift;
exports.guardDisableDay     = scheduleGuard.guardDisableDay;
exports.guardClearDay       = scheduleGuard.guardClearDay;
exports.guardResetWeek      = scheduleGuard.guardResetWeek;
exports.guardPublishDrafts  = scheduleGuard.guardPublishDrafts;

// ─── TrustyDr Commerce Bridge (Milestone 2A — read-only, additive) ─────────
const { resolveAccessContext } = require("./commerce/resolveAccessContext");
exports.resolveAccessContext = resolveAccessContext;

// ─── TrustyDr Commerce Bridge — staff Store-permission resolution ──────────
// Read-only, additive, same bridge pattern as resolveAccessContext above —
// see resolveStaffStoreAccess.js's own header for the full contract.
const { resolveStaffStoreAccess } = require("./commerce/resolveStaffStoreAccess");
exports.resolveStaffStoreAccess = resolveStaffStoreAccess;

// ─── TrustyDr Commerce Bridge — Phase 1B (Commerce Billing) ────────────────
// The one write-capable bridge function — see startCommerceTrial.js's own
// header for the full owner-only, idempotent contract.
const { startCommerceTrial } = require("./commerce/startCommerceTrial");
exports.startCommerceTrial = startCommerceTrial;

// ─── TrustyDr Commerce Bridge — Phase 1C (Patient Marketplace, browse-only) ─
// The one Patient-App-facing bridge function — runs Healthcare -> Commerce
// (every other bridge above runs the opposite direction). See
// getMarketplaceCatalog.js's own header for the full contract.
const { getMarketplaceCatalog } = require("./commerce/getMarketplaceCatalog");
exports.getMarketplaceCatalog = getMarketplaceCatalog;

// ─── TrustyDr Commerce Bridge — Patient Product Experience (Milestone 5) ───
// Live single-product detail read (variants/attributes/fresh price+stock)
// — see getMarketplaceProductDetail.js's own header for the full contract.
const { getMarketplaceProductDetail } = require("./commerce/getMarketplaceProductDetail");
exports.getMarketplaceProductDetail = getMarketplaceProductDetail;

// ─── TrustyDr Commerce Bridge — Phase 1C (Patient Marketplace, browse-only) ─
// Store Discovery aggregate — see getActiveMarketplaceStores.js's own header
// for the full contract.
const { getActiveMarketplaceStores } = require("./commerce/getActiveMarketplaceStores");
exports.getActiveMarketplaceStores = getActiveMarketplaceStores;

// ─── TrustyDr Commerce Bridge — Shared Marketplace Category Engine ─────────
// Admin-only CRUD (mydoctor_admin -> Healthcare -> Commerce) — see
// adminMarketplaceCategories.js's own header for the full contract.
const {
  adminListMarketplaceCategories,
  adminCreateMarketplaceCategory,
  adminUpdateMarketplaceCategory,
  adminMoveMarketplaceCategory,
  adminDeleteMarketplaceCategory,
  adminSyncMarketplaceCategoriesToOdoo,
  adminBulkImportMarketplaceCategories,
} = require("./commerce/adminMarketplaceCategories");
exports.adminListMarketplaceCategories = adminListMarketplaceCategories;
exports.adminCreateMarketplaceCategory = adminCreateMarketplaceCategory;
exports.adminUpdateMarketplaceCategory = adminUpdateMarketplaceCategory;
exports.adminMoveMarketplaceCategory = adminMoveMarketplaceCategory;
exports.adminDeleteMarketplaceCategory = adminDeleteMarketplaceCategory;
exports.adminSyncMarketplaceCategoriesToOdoo = adminSyncMarketplaceCategoriesToOdoo;
exports.adminBulkImportMarketplaceCategories = adminBulkImportMarketplaceCategories;

// ─── TrustyDr Commerce Bridge — Canonical Product Foundation (Admin) ───────
// Marketplace Platform Phase 1 (trustydr-commerce's
// docs/progress/MARKETPLACE_PLATFORM_ROADMAP_PROGRESS.md). Admin-only
// canonical product CRUD + link moderation (mydoctor_admin -> Healthcare
// -> Commerce) — see adminCanonicalProducts.js's own header for the full
// contract. Same admin gate and OIDC-authenticated Commerce call pattern
// as adminMarketplaceCategories.js above.
const {
  adminCreateCanonicalProduct,
  adminUpdateCanonicalProduct,
  adminListCanonicalProducts,
  adminGetCanonicalProduct,
  adminListCanonicalLinkSuggestions,
  adminReviewCanonicalLink,
  adminProposeCanonicalLink,
  adminSearchMarketplaceListings,
  adminGenerateCanonicalLinkSuggestions,
} = require("./commerce/adminCanonicalProducts");
exports.adminCreateCanonicalProduct = adminCreateCanonicalProduct;
exports.adminUpdateCanonicalProduct = adminUpdateCanonicalProduct;
exports.adminListCanonicalProducts = adminListCanonicalProducts;
exports.adminGetCanonicalProduct = adminGetCanonicalProduct;
exports.adminListCanonicalLinkSuggestions = adminListCanonicalLinkSuggestions;
exports.adminReviewCanonicalLink = adminReviewCanonicalLink;
exports.adminProposeCanonicalLink = adminProposeCanonicalLink;
exports.adminSearchMarketplaceListings = adminSearchMarketplaceListings;
exports.adminGenerateCanonicalLinkSuggestions = adminGenerateCanonicalLinkSuggestions;

// ─── TrustyDr Commerce Bridge — Standalone Subscription Billing (Admin) ────
// Admin-only payment review (mydoctor_admin -> Healthcare -> Commerce) —
// see adminStandaloneSubscriptionPayments.js's own header for the full
// contract. Same admin gate and OIDC-authenticated Commerce call pattern
// as adminMarketplaceCategories.js above.
const {
  adminListStandaloneSubscriptionPayments,
  adminApproveStandaloneSubscriptionPayment,
  adminRejectStandaloneSubscriptionPayment,
} = require("./commerce/adminStandaloneSubscriptionPayments");
exports.adminListStandaloneSubscriptionPayments = adminListStandaloneSubscriptionPayments;
exports.adminApproveStandaloneSubscriptionPayment = adminApproveStandaloneSubscriptionPayment;
exports.adminRejectStandaloneSubscriptionPayment = adminRejectStandaloneSubscriptionPayment;

// ─── TrustyDr Commerce Bridge — Sponsored Placements (Admin Control) ───────
// Marketplace Platform Phase 5, Revenue/Control Gate correction
// (2026-08-16). Admin-only sponsoredChannels grant/revoke + sponsorship
// request review (mydoctor_admin -> Healthcare -> Commerce) — see
// adminSponsoredPlacements.js's own header for the full contract. Same
// admin gate and OIDC-authenticated Commerce call pattern as
// adminStandaloneSubscriptionPayments.js above.
const {
  adminSearchOrganizations,
  adminGetStandaloneCommerceOverview,
  adminListStandaloneOrganizations,
  adminGetStandaloneOrganization,
  adminUpdateSponsoredChannels,
  adminListSponsoredPlacementRequests,
  adminApproveSponsoredPlacementRequest,
  adminRejectSponsoredPlacementRequest,
} = require("./commerce/adminSponsoredPlacements");
exports.adminSearchOrganizations = adminSearchOrganizations;
exports.adminGetStandaloneCommerceOverview = adminGetStandaloneCommerceOverview;
exports.adminListStandaloneOrganizations = adminListStandaloneOrganizations;
exports.adminGetStandaloneOrganization = adminGetStandaloneOrganization;
exports.adminUpdateSponsoredChannels = adminUpdateSponsoredChannels;
exports.adminListSponsoredPlacementRequests = adminListSponsoredPlacementRequests;
exports.adminApproveSponsoredPlacementRequest = adminApproveSponsoredPlacementRequest;
exports.adminRejectSponsoredPlacementRequest = adminRejectSponsoredPlacementRequest;

// ─── TrustyDr Commerce Bridge — B2B Seller Regulatory Applications (Admin Control) ───
// Healthcare Wholesale Marketplace — Regulatory/Entitlement Foundation
// (Phase 4B.1, 2026-08-16/17). Admin-only seller regulatory-application
// review (pharmaceutical wholesale, etc.) — mydoctor_admin -> Healthcare ->
// Commerce — see adminB2BRegulatory.js's own header for the full contract.
// Same admin gate and OIDC-authenticated Commerce call pattern as
// adminSponsoredPlacements.js above.
const {
  adminListSellerRegulatoryApplications,
  adminGetSellerRegulatoryDocument,
  adminApproveSellerRegulatoryApplication,
  adminRejectSellerRegulatoryApplication,
} = require("./commerce/adminB2BRegulatory");
exports.adminListSellerRegulatoryApplications = adminListSellerRegulatoryApplications;
exports.adminGetSellerRegulatoryDocument = adminGetSellerRegulatoryDocument;
exports.adminApproveSellerRegulatoryApplication = adminApproveSellerRegulatoryApplication;
exports.adminRejectSellerRegulatoryApplication = adminRejectSellerRegulatoryApplication;

// ─── TrustyDr Commerce Bridge — B2B Marketplace Channels & Buyer Entitlement (Admin Control) ───
// Phase 4B.5, 2026-08-18. Admin-only grant/revoke of organizations/{orgId}.
// marketplaceChannels (base B2B/B2C selling access) and .buyerScopes
// (Healthcare Wholesale Marketplace buyer access for a standalone Commerce
// org) — mydoctor_admin -> Healthcare -> Commerce — see
// adminB2BMarketplaceAccess.js's own header for the full contract. Same
// admin gate and OIDC-authenticated Commerce call pattern as
// adminSponsoredPlacements.js/adminB2BRegulatory.js above; organization
// search reuses adminSearchOrganizations (adminSponsoredPlacements.js),
// never a second search endpoint.
const {
  adminUpdateMarketplaceChannels,
  adminUpdateErpCapabilities,
  adminGrantBuyerScopes,
} = require("./commerce/adminB2BMarketplaceAccess");
exports.adminUpdateMarketplaceChannels = adminUpdateMarketplaceChannels;
exports.adminUpdateErpCapabilities = adminUpdateErpCapabilities;
exports.adminGrantBuyerScopes = adminGrantBuyerScopes;

// ─── TrustyDr Commerce Bridge — Global Attribute Engine (Milestone 3) ──────
// Admin-only CRUD (mydoctor_admin -> Healthcare -> Commerce) — see
// adminMarketplaceAttributes.js's own header for the full contract. Same
// admin gate and OIDC-authenticated Commerce call pattern as
// adminMarketplaceCategories.js above.
const {
  adminListAttributeDefinitions,
  adminCreateAttributeDefinition,
  adminUpdateAttributeDefinition,
  adminDeleteAttributeDefinition,
  adminCreateAttributeValue,
  adminUpdateAttributeValue,
  adminDeleteAttributeValue,
} = require("./commerce/adminMarketplaceAttributes");
exports.adminListAttributeDefinitions = adminListAttributeDefinitions;
exports.adminCreateAttributeDefinition = adminCreateAttributeDefinition;
exports.adminUpdateAttributeDefinition = adminUpdateAttributeDefinition;
exports.adminDeleteAttributeDefinition = adminDeleteAttributeDefinition;
exports.adminCreateAttributeValue = adminCreateAttributeValue;
exports.adminUpdateAttributeValue = adminUpdateAttributeValue;
exports.adminDeleteAttributeValue = adminDeleteAttributeValue;

// ─── TrustyDr Commerce Bridge — Category <-> Attribute Rules (Milestone 4) ─
// Admin-only CRUD (mydoctor_admin -> Healthcare -> Commerce) — see
// adminMarketplaceCategoryRules.js's own header. The Commerce endpoints
// have been deployed and IAM-restricted since 2026-07-18, but this relay
// was never built, leaving the rules layer with no reachable admin path;
// added 2026-08-29. Same admin gate and shared OIDC helper as
// adminMarketplaceCategories.js above.
const {
  adminListCategoryAttributeRules,
  adminSetCategoryAttributeRule,
  adminDeleteCategoryAttributeRule,
} = require("./commerce/adminMarketplaceCategoryRules");
exports.adminListCategoryAttributeRules = adminListCategoryAttributeRules;
exports.adminSetCategoryAttributeRule = adminSetCategoryAttributeRule;
exports.adminDeleteCategoryAttributeRule = adminDeleteCategoryAttributeRule;

// ─── TrustyDr Commerce Bridge — Milestone 6 (Cart, Checkout, Order Creation) ─
// Patient-App-facing, Healthcare -> Commerce, write-capable and
// patient-identity-bound — see marketplaceCheckout.js's own header for the
// full idempotency/cancellation-boundary contract.
const {
  getMarketplaceCheckoutProfile,
  placeMarketplaceOrder,
  quoteMarketplaceCart,
  cancelMarketplaceOrder,
  getMarketplaceOrderStatus,
  getMarketplaceDeliveryMethods,
} = require("./commerce/marketplaceCheckout");
exports.getMarketplaceCheckoutProfile = getMarketplaceCheckoutProfile;
exports.placeMarketplaceOrder = placeMarketplaceOrder;
exports.quoteMarketplaceCart = quoteMarketplaceCart;
exports.cancelMarketplaceOrder = cancelMarketplaceOrder;
exports.getMarketplaceOrderStatus = getMarketplaceOrderStatus;
exports.getMarketplaceDeliveryMethods = getMarketplaceDeliveryMethods;

// ─── Product Ratings & Reviews, Phase 3 (2026-08-10) ───────────────────────
// Patient-App-facing, Healthcare -> Commerce, same relay shape as the
// Checkout bridge immediately above — see marketplaceProductReview.js's own
// header for the full contract. getProductReviews is the one public/
// unauthenticated exception (matches getMarketplaceProductDetail's own
// public-browse posture).
const {
  submitProductReview,
  withdrawProductReview,
  getMyProductReview,
  getProductReviews,
} = require("./commerce/marketplaceProductReview");
exports.submitProductReview = submitProductReview;
exports.withdrawProductReview = withdrawProductReview;
exports.getMyProductReview = getMyProductReview;
exports.getProductReviews = getProductReviews;

// ─── Sponsored/Promoted Monetization, Phase 5 (2026-08-15) ─────────────────
// Patient-App-facing, impression/click measurement foundation only — see
// commerce/sponsoredPlacements.js's own header for the full contract.
const { recordSponsoredEvent } = require("./commerce/sponsoredPlacements");
exports.recordSponsoredEvent = recordSponsoredEvent;

// ─── Pharmacy Operations Dashboard (Phase 1, Increment 2) — order actions ──
// Accept/Reject/Start Preparing/Mark Ready for Pickup/Mark Out for
// Delivery/Mark Completed — see pharmacyOrderActions.js's own header for
// the mandatory Commerce-first, projection-after-success write order.
const {
  acceptPharmacyOrder,
  rejectPharmacyOrder,
  startPharmacyOrderPreparation,
  markPharmacyOrderReadyForPickup,
  markPharmacyOrderReadyForDelivery,
  markPharmacyOrderOutForDelivery,
  markPharmacyOrderCompleted,
  assignPharmacyOrderDeliveryPerson,
  markPharmacyOrderDeliveryFailed,
} = require("./commerce/pharmacyOrderActions");
exports.acceptPharmacyOrder = acceptPharmacyOrder;
exports.rejectPharmacyOrder = rejectPharmacyOrder;
exports.startPharmacyOrderPreparation = startPharmacyOrderPreparation;
exports.markPharmacyOrderReadyForPickup = markPharmacyOrderReadyForPickup;
// Workflow refinement (2026-07-20) — the delivery equivalent of
// markPharmacyOrderReadyForPickup: preparing -> readyForDelivery. Missing
// from this file (this is the ACTUAL Cloud Functions deployment entry
// point — functions/package.json's "main" — pharmacyOrderActions.js
// exporting it is not enough on its own) meant the function was never
// deployed at all; a request to a nonexistent Cloud Function URL 404s with
// no CORS headers, which browsers surface as a misleading CORS error.
exports.markPharmacyOrderReadyForDelivery = markPharmacyOrderReadyForDelivery;
exports.markPharmacyOrderOutForDelivery = markPharmacyOrderOutForDelivery;
exports.markPharmacyOrderCompleted = markPharmacyOrderCompleted;
// Milestone 7 (Simple Delivery Management) — assign/reassign a Delivery
// Personnel record to an order; order metadata only, never touches
// fulfillmentStatus (see pharmacyOrderActions.js's own header comment).
exports.assignPharmacyOrderDeliveryPerson = assignPharmacyOrderDeliveryPerson;
// New terminal outcome (outForDelivery -> deliveryFailed), deliberately
// distinct from 'cancelled' — see pharmacyOrderActions.js's own header
// comment on markPharmacyOrderDeliveryFailed.
exports.markPharmacyOrderDeliveryFailed = markPharmacyOrderDeliveryFailed;

// ─── Standalone Commerce -> Healthcare Fulfillment Projection Bridge ───────
// (2026-08-10) — receives standalone-org fulfillment transitions from
// trustydr-commerce's own durable outbox/retry sweep (marketplaceOrdersForOrg.ts
// + healthcareFulfillmentOutbox.ts) and projects them into this project's
// marketplace_orders, reusing the exact fulfillmentStatus/
// fulfillmentStatusHistory shape pharmacyOrderActions.js already writes for
// the Healthcare-linked path. IAM-invoker-restricted to Commerce's own
// runtime service account — see receiveStandaloneFulfillmentSync.js's own
// header for the full security rationale.
const { receiveStandaloneFulfillmentSync } = require("./commerce/receiveStandaloneFulfillmentSync");
exports.receiveStandaloneFulfillmentSync = receiveStandaloneFulfillmentSync;

// ─── Medication Vocabulary — Prescription Platform Phase 1 (ADR-014) ───────
// Foundation for the Medication Library. Two server-owned responsibilities:
//
//   onCenterMedicationWritten — the client creates the center medication
//     document (authorization enforced by canAuthorMedications() in
//     firestore.rules, which is the security boundary); this trigger derives
//     normalizedKey + searchTokens server-side, per ADR-014's requirement that
//     the dedup algorithm be changeable without a client release, and records
//     an inert moderation candidate in medication_submissions. It promotes
//     nothing — global promotion is admin-reviewed only and is Phase 6.
//
//   searchMedicationCatalog — bounded server-side search over the global
//     medication_catalog. Exists because a client-side catalog read is the
//     broad-read pattern .claude/rules/firestore-safety.md §6 forbids. The
//     center library is NOT searched here; it is center-scoped and streamed
//     client-side, same as clinical_custom_types.
//
// RxNorm is Phase 2 and is registered as an additional source behind the
// client's MedicationSearchService — deliberately not called from here.
const { onCenterMedicationWritten } = require("./medications/onCenterMedicationWritten");
const { searchMedicationCatalog } = require("./medications/searchMedicationCatalog");
exports.onCenterMedicationWritten = onCenterMedicationWritten;
exports.searchMedicationCatalog = searchMedicationCatalog;

// ─── Medication Vocabulary — Prescription Platform Phase 2 (ADR-014 §7) ────
// RxNorm as a restricted, cached FALLBACK source. Registered behind the
// client's existing MedicationSearchService — the picker is unchanged.
//
//   searchRxNormMedications — cached RxNorm search. Never a runtime
//     requirement: every failure path returns { items: [], degraded: true } so
//     the client reports a partial result and prescribing continues.
//
//   materializeRxNormMedication — writes a picked concept into
//     medication_catalog once, keyed rxnorm_{rxcui} so repeated picks converge.
//     The client sends only an rxcui (an NLM identifier); the name is re-read
//     from RxNorm here, so no client can inject a name into the global catalog,
//     and medication_catalog stays `write: if false` for every client.
//
// Source boundary (ADR-014): only NLM-created RxNorm content is persisted.
// approximateTerm is used solely to discover rxcuis — a live probe shows its
// candidates attributed to GS/MMSL/NDDF/ATC — and every name kept is re-read
// from /rxcui/{id}/properties. allProperties is never called.
const { searchRxNormMedications } = require("./medications/searchRxNormMedications");
const { materializeRxNormMedication } = require("./medications/materializeRxNormMedication");
exports.searchRxNormMedications = searchRxNormMedications;
exports.materializeRxNormMedication = materializeRxNormMedication;

// ─── Prescriptions — Prescription Platform Phase 3 (ADR-013) ───────────────
// Fires on the draft -> issued edge only. Writes the patient-facing projection
// and notifies the patient.
//
// The projection is what makes a PRINT-ONLY prescription reach the patient at
// all: before Phase 3 the only patient-visible artifact was the pharmacy
// referral, so a prescription with no pharmacy produced no patient record.
//
// diagnosisNote is doctor-visible only and is deliberately not projected. Items
// are copied field-by-field rather than spread, so a clinical field added later
// cannot leak into the patient's view by default.
const { onPrescriptionIssued } = require("./prescriptions/onPrescriptionIssued");
exports.onPrescriptionIssued = onPrescriptionIssued;

// ─── Medication Catalog Moderation — Prescription Platform Phase 6 ─────────
// (ADR-014 §5). Admin review of clinician-contributed medications.
//
// NO AUTOMATIC PROMOTION EXISTS. distinctCenterCount — how many unrelated
// centres independently produced the same normalizedKey — is surfaced as
// review evidence and drives nothing. There is no threshold and no scheduled
// job; medication_catalog is written only when an admin acts here, which is
// what the collection's `write: if false` rule is protecting.
//
// Unlike adminCanonicalProducts.js there is no Commerce relay: the clinical
// medication catalog lives in this project (ADR-014 §9 keeps it separate from
// Commerce's canonical products), so these talk to Firestore directly.
const {
  adminListMedicationSubmissions,
  adminApproveMedicationSubmission,
  adminMergeMedicationSubmission,
  adminRejectMedicationSubmission,
  adminListMedicationCatalog,
  adminUpdateMedicationCatalogEntry,
} = require("./medications/adminMedicationCatalog");
exports.adminListMedicationSubmissions = adminListMedicationSubmissions;
exports.adminApproveMedicationSubmission = adminApproveMedicationSubmission;
exports.adminMergeMedicationSubmission = adminMergeMedicationSubmission;
exports.adminRejectMedicationSubmission = adminRejectMedicationSubmission;
exports.adminListMedicationCatalog = adminListMedicationCatalog;
exports.adminUpdateMedicationCatalogEntry = adminUpdateMedicationCatalogEntry;

// ─── Prescription Verification — Prescription Platform Phase 7 ─────────────
// (ADR-013 §8). The QR on a printed prescription resolves here.
//
// verifyPrescription is deliberately PUBLIC and unauthenticated, for the same
// reason getMarketplaceCatalog is: any pharmacy must be able to check a sheet,
// including one that has never heard of TrustyDr, with no account and no app.
// What makes that safe is not a login check but a field-level guarantee — the
// only accepted input is an unguessable 192-bit token, and the only output is a
// deliberately limited projection with no diagnosis and a masked patient.
//
// It is READ-ONLY. There is no anonymous "mark dispensed" in V1: changing a
// prescription's authoritative status requires an authenticated pharmacy on the
// Phase 5 clinical_requests rail, where the actor is known.
const {
  verifyPrescription,
  ensurePrescriptionVerification,
} = require("./prescriptions/verifyPrescription");
exports.verifyPrescription = verifyPrescription;
exports.ensurePrescriptionVerification = ensurePrescriptionVerification;
