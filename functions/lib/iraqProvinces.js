'use strict';

/**
 * Iraq governorate list with provincial-capital coordinates.
 * Used by scheduleDailyHealthWeather to fetch one data point per province.
 *
 * Keys must match the provinceKey values used in the schedules and
 * medical_centers Firestore collections.
 */
const IRAQ_PROVINCES = [
  { key: 'baghdad',      en: 'Baghdad',       ar: 'بغداد',       ku: 'بەغدا',      lat: 33.3152, lon: 44.3661 },
  { key: 'basra',        en: 'Basra',          ar: 'البصرة',      ku: 'بەسرە',      lat: 30.5085, lon: 47.7804 },
  { key: 'nineveh',      en: 'Ninewa',         ar: 'نينوى',       ku: 'نینەوا',     lat: 36.3459, lon: 43.1453 },
  { key: 'erbil',        en: 'Erbil',          ar: 'أربيل',       ku: 'هەولێر',     lat: 36.1901, lon: 44.0091 },
  { key: 'sulaymaniyah', en: 'Sulaymaniyah',   ar: 'السليمانية',  ku: 'سلێمانی',    lat: 35.5556, lon: 45.4358 },
  { key: 'duhok',        en: 'Duhok',          ar: 'دهوك',        ku: 'دهۆک',       lat: 36.8669, lon: 42.9503 },
  { key: 'kirkuk',       en: 'Kirkuk',         ar: 'كركوك',       ku: 'کەرکووک',    lat: 35.4681, lon: 44.3922 },
  { key: 'al_anbar',     en: 'Anbar',          ar: 'الأنبار',     ku: 'ئەنبار',     lat: 33.4177, lon: 43.2969 },
  { key: 'diyala',       en: 'Diyala',         ar: 'ديالى',       ku: 'دیالە',      lat: 33.7734, lon: 44.6405 },
  { key: 'babil',        en: 'Babil',          ar: 'بابل',        ku: 'بابل',       lat: 32.5571, lon: 44.4238 },
  { key: 'najaf',        en: 'Najaf',          ar: 'النجف',       ku: 'نەجەف',      lat: 31.9904, lon: 44.3266 },
  { key: 'karbala',      en: 'Karbala',        ar: 'كربلاء',      ku: 'کەربەلا',    lat: 32.6161, lon: 44.0209 },
  { key: 'wasit',        en: 'Wasit',          ar: 'واسط',        ku: 'واسط',       lat: 32.6000, lon: 45.8260 },
  { key: 'muthanna',     en: 'Al-Muthanna',    ar: 'المثنى',      ku: 'موسەنا',     lat: 31.3200, lon: 45.2800 },
  { key: 'qadisiyyah',   en: 'Al-Qadisiyyah',  ar: 'القادسية',    ku: 'قادسییە',    lat: 31.9936, lon: 44.9106 },
  { key: 'dhi_qar',      en: 'Dhi Qar',        ar: 'ذي قار',      ku: 'ذی قار',     lat: 31.0461, lon: 46.2750 },
  { key: 'maysan',       en: 'Maysan',         ar: 'ميسان',       ku: 'میسان',      lat: 31.8241, lon: 47.1508 },
  { key: 'salah_ad_din', en: 'Saladin',        ar: 'صلاح الدين',  ku: 'سەلاحەدین',  lat: 34.5337, lon: 43.6769 },
  { key: 'halabja',      en: 'Halabja',        ar: 'حلبجة',       ku: 'هەڵەبجە',    lat: 35.1766, lon: 45.9863 },
];

module.exports = { IRAQ_PROVINCES };
