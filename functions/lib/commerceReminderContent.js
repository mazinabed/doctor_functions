'use strict';

/**
 * Phase 1B (Commerce Billing) — localized notification content per reminder
 * stage. Mirrors sendDailyReminders.js's buildContent()/buildLabReminderContent()
 * shape exactly (titleEn/Ar/Ku, bodyEn/Ar/Ku) so it can be handed straight to
 * the same sendFcmPush() helper without any adaptation.
 */

const DAY_COUNT_STAGES = { '14d': 14, '7d': 7, '3d': 3, '1d': 1 };

function commerceReminderContent(stage) {
  if (stage in DAY_COUNT_STAGES) {
    const days = DAY_COUNT_STAGES[stage];
    return {
      titleEn: 'Your Store trial is ending soon',
      titleAr: 'تجربة متجرك على وشك الانتهاء',
      titleKu: 'تاقیکردنەوەی فرۆشگاکەت بەم زووانە کۆتایی دێت',
      bodyEn: `Your Commerce/Store subscription ends in ${days} day${days === 1 ? '' : 's'}. Renew to keep using your ERP without interruption.`,
      bodyAr: `سينتهي اشتراك المتجر (Commerce) خلال ${days} ${days === 1 ? 'يوم' : 'أيام'}. جدّد الاشتراك لمواصلة استخدام نظام ERP دون انقطاع.`,
      bodyKu: `بەشداریکردنی فرۆشگا (Commerce) لە ماوەی ${days} ڕۆژدا کۆتایی دێت. نوێی بکەرەوە بۆ بەردەوامبوون لە بەکارهێنانی ERP بەبێ ڕاوەستان.`,
    };
  }

  if (stage === 'expiry') {
    return {
      titleEn: 'Your Store trial has ended',
      titleAr: 'انتهت تجربة متجرك',
      titleKu: 'تاقیکردنەوەی فرۆشگاکەت کۆتایی هات',
      bodyEn: 'Your Commerce/Store subscription has ended. You have a 7-day grace period to renew before Store access is suspended.',
      bodyAr: 'انتهى اشتراك المتجر (Commerce). لديك فترة سماح 7 أيام لتجديد الاشتراك قبل تعليق الوصول إلى المتجر.',
      bodyKu: 'بەشداریکردنی فرۆشگا (Commerce) کۆتایی هات. ماوەی ٧ ڕۆژی مۆڵەتت هەیە بۆ نوێکردنەوە پێش ڕاگرتنی دەستگەیشتن بۆ فرۆشگا.',
    };
  }

  if (stage === 'grace') {
    return {
      titleEn: 'Store access — grace period active',
      titleAr: 'الوصول إلى المتجر — فترة السماح فعّالة',
      titleKu: 'دەستگەیشتنی فرۆشگا — ماوەی مۆڵەت چالاکە',
      bodyEn: 'You are now in your 7-day grace period. Renew your Commerce/Store subscription soon to avoid losing access.',
      bodyAr: 'أنت الآن في فترة السماح لمدة 7 أيام. جدّد اشتراك المتجر (Commerce) قريبًا لتجنب فقدان الوصول.',
      bodyKu: 'ئێستا لە ماوەی مۆڵەتی ٧ ڕۆژیدایت. بەشداریکردنی فرۆشگا (Commerce) بەم زووانە نوێ بکەرەوە بۆ ئەوەی دەستگەیشتن لەدەست نەدەیت.',
    };
  }

  // 'final' — the moment Store access actually suspends.
  return {
    titleEn: 'Store access suspended',
    titleAr: 'تم تعليق الوصول إلى المتجر',
    titleKu: 'دەستگەیشتنی فرۆشگا ڕاگیرا',
    bodyEn: 'Your Commerce/Store subscription grace period has ended. Store access is suspended — your data, products, and history are all preserved. Renew to resume immediately.',
    bodyAr: 'انتهت فترة سماح اشتراك المتجر (Commerce). تم تعليق الوصول إلى المتجر — بياناتك ومنتجاتك وسجلك محفوظة بالكامل. جدّد الاشتراك للاستئناف فورًا.',
    bodyKu: 'ماوەی مۆڵەتی بەشداریکردنی فرۆشگا (Commerce) کۆتایی هات. دەستگەیشتنی فرۆشگا ڕاگیرا — داتا و بەرهەم و مێژووەکەت بە تەواوی پارێزراون. بۆ بەردەوامبوونەوەی دەستبەجێ نوێی بکەرەوە.',
  };
}

module.exports = { commerceReminderContent };
