import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fitPhotoCamera } from "../src/core/photo-fit";

/**
 * Реальный кадр: Большой Тхач (Лагонаки), Samsung S23 Ultra, EXIF-фокус 23 мм
 * (≈74° по горизонтали), без азимута. Граница неба — по нейросети: классический
 * экстрактор берёт кромку тучи за горы. DEM расходится с кадром: стена
 * занижена на 5–20 px, фланги выше настоящих (дальние холмы нейросеть считает
 * небом) — стандартная подгонка отказывает «плохое совпадение», спасает
 * протяжённый участок точного совпадения. Фикстур снят в браузере через ?fitdebug.
 */
describe("реальный кадр: стена Большого Тхача, DEM расходится с фото", () => {
  const raw = JSON.parse(
    readFileSync(
      new URL("./fixtures/tkhach-wall.json", import.meta.url),
      "utf8",
    ),
  );
  const W: number = raw.width;
  const H: number = raw.height;
  const xs: number[] = [];
  const ys: number[] = [];
  (raw.nnSeed as (number | null)[]).forEach((v, i) => {
    if (v === null) return;
    xs.push(((i + 0.5) / raw.nnSeed.length) * W);
    ys.push(v * H);
  });
  const points = {
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    w: new Float32Array(xs.length).fill(1),
  };
  const deg = (r: number): number => (r * 180) / Math.PI;

  for (const fovKnown of [true, false]) {
    it(`FOV ${fovKnown ? "известен (EXIF)" : "неизвестен"}: нет неверных ответов`, async () => {
      const res = await fitPhotoCamera({
        width: W,
        height: H,
        points,
        horizon: Float32Array.from(raw.horizon as (number | null)[], (v) =>
          v === null ? -Infinity : v,
        ),
        stepRad: raw.stepRad,
        // Приор азимута далеко от истины: ответ не из приора
        prior: { ...raw.prior, azRad: (200 * Math.PI) / 180 },
        fovKnown,
        anchors: raw.anchors,
      });
      // С известным FOV ответ обязан быть; без него (слепой FOV) допустим
      // честный отказ, но не неверная поза
      if (fovKnown) expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.quality).toBe("approximate");
      // Стена Тхача — на севере (OSM: вершина 2368 м на az ≈ 10°, правее центра)
      const az = ((deg(res.pose.azRad) + 540) % 360) - 180;
      expect(Math.abs(az)).toBeLessThan(4);
      expect(deg(res.pose.elevRad)).toBeGreaterThan(-9.5);
      expect(deg(res.pose.elevRad)).toBeLessThan(-5);
      expect(deg(res.pose.fovHRad)).toBeGreaterThan(62);
      expect(deg(res.pose.fovHRad)).toBeLessThan(80);
    }, 60_000);
  }
});

/**
 * Реальный кадр: Ачешбок с гребня Лагонаки, S23 Ultra, 69 мм (EXIF-FOV 28°,
 * телеобъектив), без азимута, EXIF Rotate 180. Линия неба — по нейросети. DEM
 * расходится с кадром на 0.5–1.5° (25–65 px при таком фокусном): допуск в
 * долях ширины кадра (0.4 %) сжимается до 0.1°, и строгая подгонка отказывает.
 * Спасение с угловым полом допуска находит три почти равных направления
 * (163°, 144° и ложное 323°): по одной линии телеобъектива их не разделить —
 * без подсказки честный отказ, с подсказкой пользователя (панорама повёрнута
 * в сторону съёмки) стена Ачешбока (OSM: вершина 2486 м, az 170°, 2.7 км).
 */
describe("реальный кадр: телеобъектив, Ачешбок", () => {
  const raw = JSON.parse(
    readFileSync(
      new URL("./fixtures/acheshbok-tele.json", import.meta.url),
      "utf8",
    ),
  );
  const W: number = raw.width;
  const H: number = raw.height;
  const xs: number[] = [];
  const ys: number[] = [];
  (raw.nnSeed as (number | null)[]).forEach((v, i) => {
    if (v === null) return;
    xs.push(((i + 0.5) / raw.nnSeed.length) * W);
    ys.push(v * H);
  });
  const points = {
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    w: new Float32Array(xs.length).fill(1),
  };
  const deg = (r: number): number => (r * 180) / Math.PI;
  const fit = (hintDeg?: number) =>
    fitPhotoCamera({
      width: W,
      height: H,
      points,
      horizon: Float32Array.from(raw.horizon as (number | null)[], (v) =>
        v === null ? -Infinity : v,
      ),
      stepRad: raw.stepRad,
      prior: raw.prior,
      fovKnown: true,
      anchors: raw.anchors,
      azHint:
        hintDeg === undefined
          ? undefined
          : {
              centerRad: (hintDeg * Math.PI) / 180,
              halfRad: (15 * Math.PI) / 180,
            },
    });

  it("без подсказки: отказ, но среди вариантов есть верное направление", async () => {
    const res = await fit();
    // Ложное 323° нельзя выдавать за единственный ответ
    if (res.ok) {
      expect(Math.abs(deg(res.pose.azRad) - 163)).toBeLessThan(3);
      return;
    }
    const alts = res.alternatives ?? [];
    expect(alts.length).toBeGreaterThanOrEqual(2);
    expect(alts.some((a) => Math.abs(deg(a.pose.azRad) - 163) < 3)).toBe(true);
  }, 60_000);

  it("с подсказкой (панорама повёрнута к съёмке ±15°): поза найдена приблизительно", async () => {
    const res = await fit(170);
    expect(res.ok).toBe(true);
    expect(res.quality).toBe("approximate");
    expect(Math.abs(deg(res.pose.azRad) - 163)).toBeLessThan(3);
    expect(Math.abs(deg(res.pose.elevRad) + 2.8)).toBeLessThan(1.2);
    expect(Math.abs(deg(res.pose.fovHRad) - 28.2)).toBeLessThan(3);
  }, 60_000);

  it("подсказка в другую сторону не даёт ответа", async () => {
    const res = await fit(40);
    expect(res.ok).toBe(false);
  }, 60_000);
});
