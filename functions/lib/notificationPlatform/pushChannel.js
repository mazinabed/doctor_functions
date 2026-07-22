'use strict';

const { getMessaging } = require('firebase-admin/messaging');

// Centralized FCM fan-out. Phase 1 of the notification platform pulls this
// out of the near-identical copies duplicated across notifications/*.js and
// reminders/*.js (see NOTIFICATION_PLATFORM_PROGRESS.md, "Known Phase 1
// Simplifications"). Only the Marketplace workflow (this pilot) is wired to
// this shared copy today; the other 5 copies are untouched and migrate in a
// later phase, per the approved Phase 1 scope.
//
// `content.dataPayload`, if provided, becomes the FCM `data` payload -- FCM
// requires every value in `data` to be a string, so callers must only pass
// string fields there (see marketplaceOrderWorkflow.js's `legacyFields` for
// the pattern).
async function sendPush(db, recipientUid, content) {
  const tokensSnap = await db
    .collection('users')
    .doc(recipientUid)
    .collection('fcmTokens')
    .get();

  if (tokensSnap.empty) return { sent: 0, cleaned: 0 };

  const byLang = {};
  for (const doc of tokensSnap.docs) {
    const { token, language } = doc.data();
    if (!token) continue;
    const lang = language || 'ar';
    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push({ docId: doc.id, token });
  }

  const messaging = getMessaging();
  const titleMap = { en: content.titleEn, ar: content.titleAr, ku: content.titleKu };
  const bodyMap = { en: content.bodyEn, ar: content.bodyAr, ku: content.bodyKu };

  let sent = 0;
  let cleaned = 0;

  for (const [lang, tokenDocs] of Object.entries(byLang)) {
    const title = titleMap[lang] || titleMap.ar;
    const body = bodyMap[lang] || bodyMap.ar;
    const tokens = tokenDocs.map((t) => t.token);

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: content.dataPayload || {},
        webpush: {
          notification: {
            icon: '/icons/Icon-192.png',
            badge: '/icons/Icon-192.png',
          },
        },
      });

      sent += response.successCount;

      for (let i = 0; i < response.responses.length; i++) {
        if (!response.responses[i].success) {
          const code = response.responses[i].error && response.responses[i].error.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            try {
              await db
                .collection('users')
                .doc(recipientUid)
                .collection('fcmTokens')
                .doc(tokenDocs[i].docId)
                .delete();
              cleaned++;
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.error(`sendPush: multicast error uid=${recipientUid} lang=${lang}: ${e.message}`);
    }
  }

  return { sent, cleaned };
}

module.exports = { sendPush };
