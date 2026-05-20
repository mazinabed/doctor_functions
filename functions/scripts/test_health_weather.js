'use strict';

/**
 * Manual test script — hits Open-Meteo live API for one province.
 * No Firebase credentials required. No deployment needed.
 *
 * Usage (from the functions/ directory):
 *   node scripts/test_health_weather.js [provinceKey]
 *
 * Examples:
 *   node scripts/test_health_weather.js
 *   node scripts/test_health_weather.js baghdad
 *   node scripts/test_health_weather.js basra
 *   node scripts/test_health_weather.js erbil
 *
 * Prints raw API response then the computed Firestore document payload.
 */

const axios = require("axios");
const { IRAQ_PROVINCES } = require("../lib/iraqProvinces");
const { buildHealthWeatherDoc } = require("../lib/healthWeatherLogic");

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

function iraqDateStr() {
  const now = new Date();
  const local = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function runTest(provinceKey = "baghdad") {
  const province = IRAQ_PROVINCES.find((p) => p.key === provinceKey);

  if (!province) {
    console.error(`\nUnknown province key: "${provinceKey}"`);
    console.log("Available keys:", IRAQ_PROVINCES.map((p) => p.key).join(", "));
    process.exit(1);
  }

  const dateStr = iraqDateStr();

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Province  : ${province.en} (${province.key})`);
  console.log(`Coords    : ${province.lat}°N, ${province.lon}°E`);
  console.log(`Date      : ${dateStr}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const baseParams = {
    latitude: province.lat,
    longitude: province.lon,
    timezone: "Asia/Baghdad",
    forecast_days: 1,
  };

  console.log("Fetching from Open-Meteo...");

  const [weatherRes, airRes] = await Promise.all([
    axios.get(WEATHER_URL, {
      params: {
        ...baseParams,
        current: "temperature_2m,apparent_temperature,uv_index,weather_code,wind_speed_10m",
      },
    }),
    axios.get(AIR_URL, {
      params: {
        ...baseParams,
        current: "us_aqi,pm10,pm2_5,dust",
      },
    }),
  ]);

  console.log("\n─── Raw Weather (current) ───────────────────────────");
  console.log(JSON.stringify(weatherRes.data.current, null, 2));

  console.log("\n─── Raw Air Quality (current) ───────────────────────");
  console.log(JSON.stringify(airRes.data.current, null, 2));

  const doc = buildHealthWeatherDoc(province, weatherRes.data, airRes.data, dateStr);

  console.log("\n─── Computed Firestore Document ─────────────────────");
  console.log(JSON.stringify(doc, null, 2));

  console.log("\n─── Health Summary ──────────────────────────────────");
  console.log(`Signal    : ${doc.healthSignal.toUpperCase()}`);
  console.log(`Advisory  : ${doc.advisoryKey}`);
  console.log(`Temp      : ${doc.tempC}°C / feels ${doc.feelsLikeC}°C (${doc.heatCategory})`);
  console.log(`UV        : ${doc.uvIndex} (${doc.uvCategory})`);
  console.log(`AQI       : ${doc.aqi} (${doc.aqiCategory})`);
  console.log(`Dust      : ${doc.dustUgm3} µg/m³ (${doc.dustCategory})`);
  console.log(`PM10      : ${doc.pm10} µg/m³`);
  console.log(`PM2.5     : ${doc.pm25 !== null ? doc.pm25 + " µg/m³" : "n/a"}`);
  console.log(`Wind      : ${doc.windSpeedKmh} km/h (${doc.windCategory})`);
  console.log(`Weather   : ${doc.weatherSummaryKey} (code ${doc.weatherCode})`);
  console.log("\n─── Advisories ──────────────────────────────────────");
  console.log(`Hydration       : ${doc.adviseHydration}`);
  console.log(`UV Protection   : ${doc.adviseUVProtection}`);
  console.log(`Reduce Outdoor  : ${doc.adviseReduceOutdoor}`);
  console.log(`Sensitive Groups: ${doc.adviseSensitiveGroups}`);
  console.log(`Dust Mask       : ${doc.adviseDustMask}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

runTest(process.argv[2]).catch((err) => {
  console.error("\nTest failed:", err.message);
  process.exit(1);
});
