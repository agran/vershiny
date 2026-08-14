/**
 * Гео-математика проекции «азимут / угол возвышения».
 * Сферическое приближение: погрешность много меньше шага DEM-сетки (90 м).
 * Все азимуты — истинные (от севера, по часовой).
 */

export const EARTH_RADIUS_M = 6_371_000;
/** Коэффициент рефракции: эффективный радиус Земли R/(1-k) */
export const REFRACTION_K = 0.13;

export interface LatLon {
  /** Широта, градусы */
  lat: number;
  /** Долгота, градусы */
  lon: number;
}

const DEG = Math.PI / 180;

export function toRad(deg: number): number {
  return deg * DEG;
}

export function toDeg(rad: number): number {
  return rad / DEG;
}

/**
 * Опускание горизонта из-за кривизны Земли с учётом рефракции, метры.
 * drop(d) = d²·(1−k)/(2R)
 */
export function earthDrop(distanceM: number): number {
  return (distanceM * distanceM * (1 - REFRACTION_K)) / (2 * EARTH_RADIUS_M);
}

/** Расстояние между точками по сфере (haversine), метры */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Истинный азимут из точки a в точку b, радианы [0, 2π) — точная формула на сфере */
export function azimuthRad(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const az = Math.atan2(
    Math.sin(dLon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon),
  );
  return az < 0 ? az + 2 * Math.PI : az;
}

/**
 * Нормализация долготы в [−180, 180).
 *
 * За антимеридианом счёт продолжается: 180.8° — это арифметически честно и
 * та же самая точка, но каждый потребитель считает такую долготу «за краем
 * мира». Terrarium зажимал индекс тайла в нулевой, глобальная пирамида
 * отсекала точку по `gx < 0` — и у наблюдателя на Врангеле (реестр:
 * 177.5…−177.5) оба источника разом молчали, оставляя пустой сектор
 * панорамы. Поэтому долгота нормализуется там, где она рождается.
 */
export function normalizeLon(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * Точка назначения: из origin по азимуту azRad на дистанцию distM.
 * Используется ray-marching'ом для выборки DEM вдоль луча.
 */
export function destination(origin: LatLon, azRad: number, distM: number): LatLon {
  const d = distM / EARTH_RADIUS_M;
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(azRad),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(azRad) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lon: normalizeLon(toDeg(lon2)) };
}

/**
 * Угол возвышения цели над наблюдателем, радианы.
 * Учитывает кривизну Земли: видимая высота цели уменьшается на drop(d).
 */
export function elevationAngleRad(
  observerH: number,
  targetH: number,
  distM: number,
): number {
  return Math.atan2(targetH - observerH - earthDrop(distM), distM);
}

/** Нормализация угла в диапазон (−π, π] — для разностей азимутов */
export function wrapAngle(rad: number): number {
  let a = rad % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Нормализация азимута в диапазон [0, 2π) — для абсолютных направлений.
 *
 * Свайп крутит камеру простым вычитанием, поэтому без нормализации
 * `centerAzRad` уходит и в минус, и за 2π, а любая последующая арифметика
 * через `%` (остаток в JS сохраняет знак делимого) считает не тот сектор.
 */
export function normalizeAz(rad: number): number {
  const a = rad % (2 * Math.PI);
  return a < 0 ? a + 2 * Math.PI : a;
}

/**
 * Точка пригодна для расчёта? Широта вне ±90 ломает ray-marching молча:
 * `destination` вернёт бессмысленные координаты, DEM отдаст пустоту, а на
 * экране будет «нет данных» без единого намёка на причину.
 */
export function isValidLatLon(p: LatLon): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}
