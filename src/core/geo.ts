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
    Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon),
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
export function destination(
  origin: LatLon,
  azRad: number,
  distM: number,
): LatLon {
  const d = distM / EARTH_RADIUS_M;
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(azRad),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(azRad) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lon: normalizeLon(toDeg(lon2)) };
}

/** Таблица шагов луча: дистанции и предвычисленные sin/cos(d/R) */
export interface RayStepTable {
  readonly d: ArrayLike<number>;
  readonly sinD: ArrayLike<number>;
  readonly cosD: ArrayLike<number>;
}

/**
 * Маркирующая функция точек луча: то же, что `destination(origin, az, d)`,
 * но константы наблюдателя и азимута (sin/cos широты, sin/cos азимута)
 * вынесены из цикла, а sin/cos(d/R) берутся из таблицы — последовательность
 * дистанций общая для всех лучей панорамы, поэтому тригонометрия дистанции
 * считается один раз (ALGORITHMS.md §1). Выражения и порядок операций
 * повторяют `destination`, результаты совпадают побитово.
 *
 * Возвращаемый объект переиспользуется между вызовами: сэмплеры читают
 * координаты синхронно и не удерживают ссылку, а ~2 млн короткоживущих
 * объектов на панораму — лишнее давление на GC в worker.
 */
export function makeRayMarcher(
  origin: LatLon,
  azRad: number,
  table: RayStepTable,
): (stepIdx: number) => LatLon {
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const out: LatLon = { lat: 0, lon: 0 };
  return (stepIdx: number): LatLon => {
    const cosD = table.cosD[stepIdx];
    const sinD = table.sinD[stepIdx];
    const lat2 = Math.asin(sinLat1 * cosD + cosLat1 * sinD * cosAz);
    const lon2 =
      lon1 +
      Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * Math.sin(lat2));
    out.lat = toDeg(lat2);
    out.lon = normalizeLon(toDeg(lon2));
    return out;
  };
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

/**
 * Точка внутри bbox, с учётом перехода через антимеридиан (minLon > maxLon).
 *
 * Регион Врангеля в реестре — 177.5…−177.5; наивное сравнение
 * `minLon <= lon <= maxLon` для такого bbox не вернёт true никогда, и
 * детальный слой рельефа молча не подхватывался бы (DemSource до починки
 * считал именно так, хотя ui/download.ts знал про антимеридиан всегда).
 */
export function bboxContains(
  pos: LatLon,
  bbox: [number, number, number, number],
): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonOk =
    minLon <= maxLon
      ? pos.lon >= minLon && pos.lon <= maxLon
      : pos.lon >= minLon || pos.lon <= maxLon;
  return lonOk && pos.lat >= minLat && pos.lat <= maxLat;
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
