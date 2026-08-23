/**
 * Изолированный тест: в реальном марчере lon2 = lon1 + atan2(sinAz·sinD·cosLat1,
 * cosD − sinLat1·Math.sin(lat2)), где lat2 = asin(clamped).
 * Гипотеза: заменить Math.sin(lat2) на clamped (sin(asin(x))≈x).
 *
 * Считаем ОБА варианта с ТОЧНО теми же константами реального марчера
 * (toRad/toDeg из geo.ts), меняя только sin(asin(clamped)) → clamped.
 * Вопрос: (1) меняется ли lon2? (2) пересекает ли это границу пикселя?
 *
 * Запуск: npx tsx tools/perf/bench-sinasin.ts
 */

import { toRad, toDeg, type LatLon } from "../../src/core/geo";
import { buildMarchTable } from "../../src/core/horizon";
import { lonLatToTileAndPixel, zoomForDistance } from "../../src/core/terrarium";

const ORIGIN: LatLon = { lat: 43.318, lon: 42.458 };
const march = buildMarchTable(135, 200_000);
const rayCount = 3600;
const stepRad = (2 * Math.PI) / rayCount;

const lat1 = toRad(ORIGIN.lat);
const lon1 = toRad(ORIGIN.lon);
const sinLat1 = Math.sin(lat1);
const cosLat1 = Math.cos(lat1);

let lonChanged = 0;
let pixelChanged = 0;
let total = 0;
let maxLonDiff = 0;

for (let i = 0; i < rayCount; i++) {
  const az = i * stepRad;
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  for (let s = 0; s < march.count; s++) {
    const cosD = march.cosD[s];
    const sinD = march.sinD[s];
    const clamped = Math.min(1, Math.max(-1, sinLat1 * cosD + cosLat1 * sinD * cosAz));
    const lat2 = Math.asin(clamped);

    // Текущий марчер
    const lon2a = lon1 + Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * Math.sin(lat2));
    // Гипотеза: clamped вместо Math.sin(lat2)
    const lon2b = lon1 + Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * clamped);

    const lonA = toDeg(lon2a);
    const lonB = toDeg(lon2b);
    total++;
    if (lonA !== lonB) {
      lonChanged++;
      const d = Math.abs(lonA - lonB);
      if (d > maxLonDiff) maxLonDiff = d;
      // Пересекает ли границу пикселя Terrarium?
      const z = zoomForDistance(march.d[s]);
      const pa = lonLatToTileAndPixel({ lat: toDeg(lat2), lon: lonA }, z);
      const pb = lonLatToTileAndPixel({ lat: toDeg(lat2), lon: lonB }, z);
      if (pa.tx !== pb.tx || pa.ty !== pb.ty || pa.px !== pb.px || pa.py !== pb.py) {
        pixelChanged++;
      }
    }
  }
}

console.log(`точек: ${total}`);
console.log(`долгота (deg) отличается: ${lonChanged} (${((lonChanged / total) * 100).toFixed(3)}%)`);
console.log(`max |Δlon| = ${maxLonDiff.toExponential(3)} deg`);
console.log(`из них пересекает пиксель Terrarium: ${pixelChanged} (${((pixelChanged / total) * 100).toFixed(5)}%)`);
console.log(pixelChanged === 0
  ? "→ выборка DEM не меняется → профиль побитово идентичен"
  : "→ выборка меняется → НЕ побитово");
