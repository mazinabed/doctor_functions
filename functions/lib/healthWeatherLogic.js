'use strict';

/**
 * Pure computation logic for the Daily Health Weather feature.
 *
 * All functions are deterministic and injectable — no I/O, no Firebase,
 * no Date.now(). Safe to unit test without mocking infrastructure.
 *
 * Category thresholds are contextualised for Iraq / Middle East:
 *   - Heat thresholds shifted higher than WHO defaults (45°C+ is "extreme")
 *   - Dust thresholds account for Saharan/Arabian dust storm patterns
 *   - AQI uses US EPA standard (consistent with Open-Meteo output)
 */

// ─── UV INDEX ────────────────────────────────────────────────────────────────
// Source: WHO UVI classification

/**
 * @param {number} uv  UV index value
 * @returns {string}
 */
function uvCategory(uv) {
  if (uv <= 2) return "low";
  if (uv <= 5) return "moderate";
  if (uv <= 7) return "high";
  if (uv <= 10) return "very_high";
  return "extreme";
}

// ─── US AQI ──────────────────────────────────────────────────────────────────
// Source: US EPA AQI breakpoints

/**
 * @param {number} aqi  US AQI value (0–500+)
 * @returns {string}
 */
function aqiCategory(aqi) {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "unhealthy_sensitive";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "very_unhealthy";
  return "hazardous";
}

// ─── DUST (PM10 µg/m³) ───────────────────────────────────────────────────────
// Thresholds tuned for Iraq where 300+ µg/m³ dust events are common.

/**
 * @param {number} pm10Ugm3  PM10 concentration in µg/m³
 * @returns {string}
 */
function dustCategory(pm10Ugm3) {
  if (pm10Ugm3 <= 50) return "low";
  if (pm10Ugm3 <= 150) return "moderate";
  if (pm10Ugm3 <= 300) return "high";
  return "very_high";
}

// ─── HEAT (apparent temperature °C) ─────────────────────────────────────────
// Iraq-contextual — shifted relative to European baselines.

/**
 * @param {number} feelsLikeC  Apparent temperature in °C
 * @returns {string}
 */
function heatCategory(feelsLikeC) {
  if (feelsLikeC < 30) return "comfortable";
  if (feelsLikeC < 38) return "warm";
  if (feelsLikeC < 45) return "hot";
  return "extreme";
}

// ─── WIND (km/h) ─────────────────────────────────────────────────────────────

/**
 * @param {number} windKmh  Wind speed in km/h
 * @returns {string}
 */
function windCategory(windKmh) {
  if (windKmh < 20) return "calm";
  if (windKmh < 39) return "breezy";
  if (windKmh < 61) return "windy";
  return "strong";
}

// ─── HEALTH SIGNAL ───────────────────────────────────────────────────────────
// Composite signal — worst of UV / AQI / dust / heat wins.

const SIGNAL_ORDER = ["safe", "caution", "warning", "danger"];

/** @param {...string} signals */
function worstSignal(...signals) {
  let maxIdx = 0;
  for (const s of signals) {
    const i = SIGNAL_ORDER.indexOf(s);
    if (i > maxIdx) maxIdx = i;
  }
  return SIGNAL_ORDER[maxIdx];
}

function uvSignal(cat) {
  if (cat === "low" || cat === "moderate") return "safe";
  if (cat === "high") return "caution";
  if (cat === "very_high") return "warning";
  return "danger"; // extreme
}

function aqiSignal(cat) {
  if (cat === "good") return "safe";
  if (cat === "moderate") return "caution";
  if (cat === "unhealthy_sensitive") return "warning";
  return "danger"; // unhealthy, very_unhealthy, hazardous
}

function dustSignal(cat) {
  if (cat === "low") return "safe";
  if (cat === "moderate") return "caution";
  if (cat === "high") return "warning";
  return "danger"; // very_high
}

function heatSignal(cat) {
  if (cat === "comfortable" || cat === "warm") return "safe";
  if (cat === "hot") return "caution";
  return "warning"; // extreme — heat alone does not reach danger
}

/**
 * @param {string} uvCat
 * @param {string} aqiCat
 * @param {string} dustCat
 * @param {string} heatCat
 * @returns {string}  "safe" | "caution" | "warning" | "danger"
 */
function computeHealthSignal(uvCat, aqiCat, dustCat, heatCat) {
  return worstSignal(
    uvSignal(uvCat),
    aqiSignal(aqiCat),
    dustSignal(dustCat),
    heatSignal(heatCat)
  );
}

// ─── ADVISORY KEY ────────────────────────────────────────────────────────────
// Priority: windy_dust > dusty > poor_air_sensitive > high_uv > hot_day > normal

/**
 * @param {string} dustCat
 * @param {string} aqiCat
 * @param {string} uvCat
 * @param {string} heatCat
 * @param {string} windCat
 * @returns {string}
 */
function computeAdvisoryKey(dustCat, aqiCat, uvCat, heatCat, windCat) {
  const highDust = dustCat === "high" || dustCat === "very_high";
  const moderateDust = dustCat === "moderate";
  const strongWind = windCat === "windy" || windCat === "strong";
  const poorAir = aqiCat === "unhealthy_sensitive" || aqiCat === "unhealthy" ||
    aqiCat === "very_unhealthy" || aqiCat === "hazardous";

  if (highDust && strongWind) return "windy_dust";
  if (highDust) return "dusty";
  if (moderateDust && strongWind) return "windy_dust";
  if (poorAir) return "poor_air_sensitive";
  if (uvCat === "very_high" || uvCat === "extreme") return "high_uv";
  if (heatCat === "extreme") return "hot_day";
  if (moderateDust) return "dusty";
  return "normal";
}

// ─── WEATHER CODE ─────────────────────────────────────────────────────────────
// WMO Weather Interpretation Codes (as returned by Open-Meteo)

/**
 * @param {number} code  WMO weather code
 * @returns {string}
 */
function weatherSummaryKey(code) {
  if (code === 0) return "clear";
  if (code <= 3) return "partly_cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  return "thunderstorm";
}

// ─── DOCUMENT BUILDER ─────────────────────────────────────────────────────────

/**
 * Builds the full Firestore document payload from raw Open-Meteo API responses.
 *
 * Defensive defaults are applied for every field so a partial API response
 * (missing fields, null values) never produces an exception.
 *
 * NOTE: fetchedAt is NOT included here — the caller adds FieldValue.serverTimestamp().
 *
 * @param {{ key: string, en: string, ar: string, ku: string }} province
 * @param {Object} weatherData  Response body from api.open-meteo.com/v1/forecast
 * @param {Object} airData      Response body from air-quality-api.open-meteo.com/v1/air-quality
 * @param {string} dateStr      ISO date string (YYYY-MM-DD) in Iraq local time
 * @returns {Object}  Firestore document payload (without fetchedAt)
 */
function buildHealthWeatherDoc(province, weatherData, airData, dateStr) {
  const w = (weatherData && weatherData.current) ? weatherData.current : {};
  const a = (airData && airData.current) ? airData.current : {};

  // ── Weather fields ──────────────────────────────────────────────────────────
  const tempC = typeof w["temperature_2m"] === "number"
    ? Math.round(w["temperature_2m"])
    : null;

  const feelsLikeC = typeof w["apparent_temperature"] === "number"
    ? Math.round(w["apparent_temperature"])
    : tempC;

  const uvIndex = typeof w["uv_index"] === "number"
    ? Math.round(w["uv_index"] * 10) / 10
    : 0;

  const windSpeedKmh = typeof w["wind_speed_10m"] === "number"
    ? Math.round(w["wind_speed_10m"])
    : 0;

  const weatherCode = typeof w["weather_code"] === "number"
    ? w["weather_code"]
    : 0;

  // ── Air quality fields ──────────────────────────────────────────────────────
  const aqi = typeof a["us_aqi"] === "number" ? Math.round(a["us_aqi"]) : 0;

  const pm10 = typeof a["pm10"] === "number" ? Math.round(a["pm10"]) : 0;

  const pm25 = typeof a["pm2_5"] === "number" ? Math.round(a["pm2_5"]) : null;

  // Open-Meteo `dust` field: Saharan/Arabian dust aerosol in µg/m³ (CAMS data).
  // Use the larger of dust vs pm10 so either dust-storm or general pollution
  // triggers the correct category.
  const dustRaw = typeof a["dust"] === "number" ? Math.round(a["dust"]) : pm10;
  const dustUgm3 = dustRaw;
  const effectiveDust = Math.max(dustRaw, pm10);

  // ── Categories ──────────────────────────────────────────────────────────────
  const uvCat = uvCategory(uvIndex);
  const aqiCat = aqiCategory(aqi);
  const dustCat = dustCategory(effectiveDust);
  const heatCat = (feelsLikeC !== null) ? heatCategory(feelsLikeC) : "comfortable";
  const windCat = windCategory(windSpeedKmh);

  // ── Composite signals ───────────────────────────────────────────────────────
  const healthSig = computeHealthSignal(uvCat, aqiCat, dustCat, heatCat);
  const advKey = computeAdvisoryKey(dustCat, aqiCat, uvCat, heatCat, windCat);

  return {
    // ── Identity ──────────────────────────────────────────────────────────────
    provinceKey: province.key,
    province_en: province.en,
    province_ar: province.ar,
    province_ku: province.ku,

    // ── Metadata ──────────────────────────────────────────────────────────────
    date: dateStr,
    source: "open_meteo",
    isStale: false,

    // ── Temperature ───────────────────────────────────────────────────────────
    tempC,
    feelsLikeC,
    heatCategory: heatCat,

    // ── UV ────────────────────────────────────────────────────────────────────
    uvIndex,
    uvCategory: uvCat,

    // ── Air Quality ───────────────────────────────────────────────────────────
    aqi,
    aqiCategory: aqiCat,
    pm10,
    pm25,

    // ── Dust ──────────────────────────────────────────────────────────────────
    dustUgm3,
    dustCategory: dustCat,

    // ── Wind ──────────────────────────────────────────────────────────────────
    windSpeedKmh,
    windCategory: windCat,

    // ── Weather condition ─────────────────────────────────────────────────────
    weatherCode,
    weatherSummaryKey: weatherSummaryKey(weatherCode),

    // ── Composite health signal ───────────────────────────────────────────────
    healthSignal: healthSig,
    advisoryKey: advKey,

    // ── Advisory flags ────────────────────────────────────────────────────────
    adviseHydration: feelsLikeC !== null && feelsLikeC >= 38,
    adviseUVProtection: uvIndex >= 6,
    adviseReduceOutdoor: aqi >= 151 || dustCat === "very_high",
    adviseSensitiveGroups: aqi >= 101 || dustCat === "high" || dustCat === "very_high",
    adviseDustMask: dustCat === "high" || dustCat === "very_high" || pm10 > 150,
  };
}

module.exports = {
  buildHealthWeatherDoc,
  // Exported for unit testing
  uvCategory,
  aqiCategory,
  dustCategory,
  heatCategory,
  windCategory,
  computeHealthSignal,
  computeAdvisoryKey,
  weatherSummaryKey,
};
