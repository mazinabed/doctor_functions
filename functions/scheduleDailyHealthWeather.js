'use strict';

/**
 * scheduleDailyHealthWeather
 *
 * Fires daily at 08:00 Iraq time (05:00 UTC). Fetches current environmental
 * conditions for all 18 Iraq provinces from Open-Meteo (weather + air quality),
 * computes health signal categories and advisory flags, and writes cached
 * summaries to public_daily_health_weather/{provinceKey}.
 *
 * Design constraints:
 *   - Province failures are isolated: one failure does not abort others.
 *   - On failure: merge-writes isStale=true, preserving last known data.
 *   - Uses docRef.set() (overwrite) on success so each daily run is idempotent.
 *   - No patient data stored — documents are environmental awareness only.
 *   - Two API calls per province (weather + air quality) = ~36 calls/day total.
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const axios = require("axios");
const { IRAQ_PROVINCES } = require("./lib/iraqProvinces");
const { buildHealthWeatherDoc } = require("./lib/healthWeatherLogic");

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Returns the current date string in Iraq local time (UTC+3), formatted
 * as YYYY-MM-DD. Uses manual offset arithmetic to avoid a timezone library
 * dependency.
 *
 * @returns {string}
 */
function iraqDateStr() {
  const now = new Date();
  const local = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Fetches weather and air-quality data for a single province from Open-Meteo.
 * Both requests run in parallel.
 *
 * @param {{ key: string, lat: number, lon: number }} province
 * @returns {Promise<{ weather: Object, air: Object }>}
 */
async function fetchProvince(province) {
  const baseParams = {
    latitude: province.lat,
    longitude: province.lon,
    timezone: "Asia/Baghdad",
    forecast_days: 1,
  };

  const [weatherRes, airRes] = await Promise.all([
    axios.get(WEATHER_URL, {
      params: {
        ...baseParams,
        current: [
          "temperature_2m",
          "apparent_temperature",
          "uv_index",
          "weather_code",
          "wind_speed_10m",
        ].join(","),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }),
    axios.get(AIR_URL, {
      params: {
        ...baseParams,
        current: ["us_aqi", "pm10", "pm2_5", "dust"].join(","),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }),
  ]);

  return { weather: weatherRes.data, air: airRes.data };
}

exports.scheduleDailyHealthWeather = onSchedule(
  { schedule: "0 3 * * *", timeZone: "UTC" },
  async (_event) => {
    const db = getFirestore();
    const dateStr = iraqDateStr();
    const col = db.collection("public_daily_health_weather");

    console.log(
      `scheduleDailyHealthWeather: start date=${dateStr} provinces=${IRAQ_PROVINCES.length}`
    );

    let success = 0;
    let failed = 0;

    // Process sequentially — 18 provinces × 2 calls = 36 requests/day,
    // well within limits. Sequential is simpler and avoids burst traffic.
    for (const province of IRAQ_PROVINCES) {
      const docRef = col.doc(province.key);

      try {
        const { weather, air } = await fetchProvince(province);
        const payload = buildHealthWeatherDoc(province, weather, air, dateStr);

        await docRef.set({
          ...payload,
          fetchedAt: FieldValue.serverTimestamp(),
        });

        success++;
        console.log(
          `scheduleDailyHealthWeather: OK ${province.key}` +
          ` signal=${payload.healthSignal} advisory=${payload.advisoryKey}` +
          ` uv=${payload.uvIndex} aqi=${payload.aqi}` +
          ` dust=${payload.dustUgm3}µg/m³ pm10=${payload.pm10}` +
          ` temp=${payload.tempC}°C feels=${payload.feelsLikeC}°C` +
          ` wind=${payload.windSpeedKmh}km/h weather=${payload.weatherSummaryKey}`
        );
      } catch (err) {
        failed++;
        console.error(
          `scheduleDailyHealthWeather: FAILED ${province.key} — ${err.message}`
        );

        // Merge-write the stale flag only — preserves all previously fetched
        // weather fields so the UI can still show last known conditions.
        try {
          await docRef.set(
            {
              provinceKey: province.key,
              province_en: province.en,
              province_ar: province.ar,
              province_ku: province.ku,
              isStale: true,
              date: dateStr,
              fetchedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch (writeErr) {
          console.error(
            `scheduleDailyHealthWeather: stale-write also failed ${province.key}` +
            ` — ${writeErr.message}`
          );
        }
      }
    }

    console.log(
      `scheduleDailyHealthWeather: complete success=${success} failed=${failed}`
    );
  }
);
