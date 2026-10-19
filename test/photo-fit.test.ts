/**
 * Калибровка камеры по линии неба фото (core/photo-fit.ts).
 *
 * Кадр синтетический: по известной позе (азимут, наклон, крен, FOV)
 * силуэт придуманного рельефа проецируется ТОЙ ЖЕ createPinholeProjection,
 * что рисует оверлей, поверх — шум экстрактора, человек у объектива и
 * одиночные срывы. Подгонка стартует с неверным азимутом и (где это
 * оговорено) неверным FOV и обязана вернуть исходную позу.
 */

import { describe, it, expect } from "vitest";
import {
  fitPhotoCamera as fitPhotoCameraRaw,
  liftSilhouetteByPeaks,
  type CameraPose,
  type PhotoFitOptions,
} from "../src/core/photo-fit";
import type { SkylinePoints } from "../src/core/photo-skyline";
import { createPinholeProjection } from "../src/core/camera-projection";
import { fovForFrame } from "../src/core/camera-fov";

/**
 * Подгонка синхронна и в сумме занимает больше минуты: без уступок циклу
 * событий воркер vitest не отвечает на heartbeat (`onTaskUpdate` timeout) и
 * прогон завершается ошибкой. Уступаем не чаще раза в 2 с.
 */
let lastYield = 0;
const fitPhotoCamera = (options: PhotoFitOptions) =>
  fitPhotoCameraRaw({
    yieldToUi: async () => {
      if (performance.now() - lastYield < 2000) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    },
    ...options,
  });

const deg = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const RAYS = 3600;
const STEP = (2 * Math.PI) / RAYS;

/** Детерминированный ГПСЧ (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Рельеф без периодичности: ~70 пиков разной ширины/высоты, есть обрывы */
function makeHorizon(seed: number): Float32Array {
  const r = rng(seed);
  const peaks = Array.from({ length: 70 }, () => ({
    c: r() * 2 * Math.PI,
    w: deg(0.3 + r() * 2.7),
    h: deg(0.5 + r() * r() * 9),
  }));
  const out = new Float32Array(RAYS);
  for (let i = 0; i < RAYS; i++) {
    const az = i * STEP;
    let e = deg(0.4);
    for (const p of peaks) {
      let d = Math.abs(az - p.c);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < p.w) e = Math.max(e, p.h * Math.pow(1 - d / p.w, 1.2));
    }
    out[i] = e;
  }
  return out;
}

/** Дистанции до силуэта: 1.5–8 км, плавно по азимуту */
function makeDistances(seed: number): Float32Array {
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  return Float32Array.from({ length: RAYS }, (_, i) => {
    const a = i * STEP;
    return (
      1500 +
      6500 *
        (0.5 +
          0.17 *
            (Math.sin(3 * a + ph[0]) +
              Math.sin(7 * a + ph[1]) +
              Math.sin(13 * a + ph[2])))
    );
  });
}

interface RenderOptions {
  width: number;
  height: number;
  noisePx?: number;
  /** Доля колонок, где линия сорвана вниз (деревья, фонари) */
  outlierFrac?: number;
  /** Ширина блока «человек у объектива», доля кадра */
  blockFrac?: number;
  /** Облака, закрывшие верх гор: доли ширины и доля срезанной высоты рельефа */
  clouds?: { from: number; to: number; cut: number; onPeak?: boolean }[];
  seed?: number;
}

/** Линия неба кадра для позы: верхняя точка проекции силуэта в колонке */
function renderSkyline(
  horizon: Float32Array,
  pose: CameraPose,
  o: RenderOptions,
): SkylinePoints {
  const { width: W, height: H } = o;
  const r = rng(o.seed ?? 7);
  const proj = createPinholeProjection({
    width: W,
    height: H,
    centerAzRad: pose.azRad,
    tiltRad: pose.elevRad,
    fovRad: pose.fovHRad,
    fovVRad: 2 * Math.atan((Math.tan(pose.fovHRad / 2) * H) / W),
    horizonFrac: 0.5,
  });
  const top = new Float32Array(W).fill(Infinity);
  const sub = 4;
  const cosR = Math.cos(pose.rollRad);
  const sinR = Math.sin(pose.rollRad);
  const span = Math.ceil(pose.fovHRad / STEP) + 120;
  const i0 = Math.round(pose.azRad / STEP) - (span >> 1);
  for (let k = 0; k < span * sub; k++) {
    const idx = i0 + k / sub;
    const a = Math.floor(idx);
    const f = idx - a;
    const e0 = horizon[((a % RAYS) + RAYS) % RAYS];
    const e1 = horizon[(((a + 1) % RAYS) + RAYS) % RAYS];
    const p = proj.angleToView(idx * STEP, e0 + (e1 - e0) * f);
    if (!p) continue;
    // Крен — поворот картинной плоскости вокруг центра, как у оверлея
    const dx = p.x - W / 2;
    const dy = p.y - H / 2;
    const x = W / 2 + cosR * dx - sinR * dy;
    const y = H / 2 + sinR * dx + cosR * dy;
    const col = Math.floor(x);
    if (col < 0 || col >= W || y < 0 || y >= H) continue;
    if (y < top[col]) top[col] = y;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  const step = 3;
  // Облака: в колонках диапазона линия не выше кромки облака — вершины ниже
  // yCut закрыты, остаётся нижний край облака
  const clouds = (o.clouds ?? []).map((c0) => {
    let c = c0;
    if (c0.onPeak) {
      // Облако садится на самую высокую вершину кадра
      let best = 0;
      for (let x = 0; x < W; x++) if (top[x] < top[best]) best = x;
      const half = (c0.to - c0.from) / 2;
      const mid = Math.min(1 - half, Math.max(half, best / W));
      c = { ...c0, from: mid - half, to: mid + half };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = Math.floor(c.from * W); x < Math.ceil(c.to * W); x++) {
      if (!Number.isFinite(top[x])) continue;
      lo = Math.min(lo, top[x]);
      hi = Math.max(hi, top[x]);
    }
    return {
      x0: c.from * W,
      x1: c.to * W,
      yCut: lo + c.cut * (hi - lo),
    };
  });
  const blockStart = r() * W * (1 - (o.blockFrac ?? 0));
  const blockEnd = blockStart + W * (o.blockFrac ?? 0);
  for (let x = 1; x < W; x += step) {
    if (!Number.isFinite(top[x])) continue;
    let y = top[x] + gauss(r) * (o.noisePx ?? 1);
    for (const c of clouds) {
      if (x >= c.x0 && x < c.x1) y = Math.max(y, c.yCut + gauss(r) * 2);
    }
    if (x >= blockStart && x < blockEnd) y += 0.15 * H;
    else if (r() < (o.outlierFrac ?? 0)) y += (0.02 + r() * 0.08) * H;
    xs.push(x + 0.5);
    ys.push(Math.min(H - 1, y));
    ws.push(0.6 + 0.4 * r());
  }
  return {
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    w: Float32Array.from(ws),
  };
}

const wrapDeg = (d: number): number => ((d + 540) % 360) - 180;

describe("liftSilhouetteByPeaks: силуэт DEM подтягивается к вершинам", () => {
  it("поднимает занижённую вершину и не трогает остальное", () => {
    const horizon = new Float32Array(RAYS).fill(deg(0.5));
    const peakAz = deg(100);
    const out = liftSilhouetteByPeaks(horizon, STEP, [
      { azimuthRad: peakAz, elevationRad: deg(3), distanceM: 3000 },
    ]);
    const at = (azDeg: number): number => out[Math.round(deg(azDeg) / STEP)];
    // В точке вершины силуэт достиг её высоты
    expect(toDeg(at(100))).toBeCloseTo(3, 1);
    // Выше DEM всюду, ниже — нигде; за пределами горба — без изменений
    for (let i = 0; i < RAYS; i++)
      expect(out[i]).toBeGreaterThanOrEqual(horizon[i]);
    expect(toDeg(at(100 + 15))).toBeCloseTo(0.5, 5);
    expect(toDeg(at(100 - 15))).toBeCloseTo(0.5, 5);
    // Горб убывает к краям, а не обрывается ступенью
    expect(at(102)).toBeLessThan(at(100));
    expect(at(104)).toBeLessThan(at(102));
  });

  it("далёкие вершины и вершины ниже силуэта игнорируются", () => {
    const horizon = new Float32Array(RAYS).fill(deg(2));
    const out = liftSilhouetteByPeaks(horizon, STEP, [
      { azimuthRad: deg(50), elevationRad: deg(6), distanceM: 60_000 },
      { azimuthRad: deg(200), elevationRad: deg(1), distanceM: 2000 },
      { azimuthRad: deg(300), elevationRad: deg(2.1), distanceM: 2000 },
    ]);
    expect(Array.from(out)).toEqual(Array.from(horizon));
  });

  it("поза восстанавливается, когда DEM занижает ближнюю вершину на 2°", async () => {
    const W = 1280;
    const H = 720;
    const trueHorizon = makeHorizon(77);
    // Самая высокая вершина вокруг — «ближняя»: DEM срезает её на 2°
    let peakIdx = 0;
    for (let i = 0; i < RAYS; i++) {
      if (trueHorizon[i] > trueHorizon[peakIdx]) peakIdx = i;
    }
    const dem = Float32Array.from(trueHorizon);
    const half = Math.round(deg(8) / STEP);
    for (let d = -half; d <= half; d++) {
      const k = (((peakIdx + d) % RAYS) + RAYS) % RAYS;
      const cut = deg(2) * Math.pow(1 - Math.abs(d) / (half + 1), 0.5);
      dem[k] = Math.max(deg(0.2), dem[k] - cut);
    }
    const truth: CameraPose = {
      azRad: peakIdx * STEP - deg(6),
      elevRad: deg(2),
      rollRad: deg(1),
      fovHRad: deg(60),
    };
    const points = renderSkyline(trueHorizon, truth, {
      width: W,
      height: H,
      noisePx: 1,
      outlierFrac: 0.04,
      seed: 4,
    });
    const res = await fitPhotoCamera({
      width: W,
      height: H,
      points,
      horizon: dem,
      stepRad: STEP,
      prior: {
        azRad: deg(10),
        elevRad: 0,
        rollRad: 0,
        fovHRad: fovForFrame(deg(70), W, H).h,
      },
      anchors: [
        {
          azimuthRad: peakIdx * STEP,
          elevationRad: trueHorizon[peakIdx],
          distanceM: 3000,
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)))).toBeLessThan(
      0.5,
    );
    expect(Math.abs(toDeg(res.pose.elevRad - truth.elevRad))).toBeLessThan(0.6);
    expect(Math.abs(res.pose.fovHRad / truth.fovHRad - 1)).toBeLessThan(0.04);
  }, 60_000);
});

describe("ошибка высоты наблюдателя и расхождение DEM с реальностью", () => {
  async function heightScene(
    scene: number,
    dh: number,
    useDistance: boolean,
  ): Promise<{
    dAz: number;
    dEl: number;
    dFov: number;
    dDh: number;
    ok: boolean;
    reason?: string;
  }> {
    const W = 1280;
    const H = 720;
    const rand = rng(4242 + scene);
    const horizon = makeHorizon(700 + scene);
    const dist = makeDistances(800 + scene);
    // «Реальный» силуэт: тот же рельеф, увиденный с высоты +dh
    const real = Float32Array.from(horizon, (e, i) => e - dh / dist[i]);
    const truth: CameraPose = {
      azRad: deg(rand() * 360),
      elevRad: deg(-3 + rand() * 9),
      rollRad: deg(-2 + rand() * 4),
      fovHRad: deg(50 + rand() * 40),
    };
    const points = renderSkyline(real, truth, {
      width: W,
      height: H,
      noisePx: 1.2,
      outlierFrac: 0.04,
      seed: scene + 1,
    });
    const res = await fitPhotoCamera({
      width: W,
      height: H,
      points,
      horizon,
      stepRad: STEP,
      prior: {
        azRad: deg(rand() * 360),
        elevRad: 0,
        rollRad: 0,
        fovHRad: fovForFrame(deg(70), W, H).h,
      },
      distanceM: useDistance ? dist : undefined,
    });
    return {
      ok: res.ok,
      reason: res.reason,
      dAz: Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad))),
      dEl: Math.abs(toDeg(res.pose.elevRad - truth.elevRad)),
      dFov: Math.abs(res.pose.fovHRad / truth.fovHRad - 1),
      dDh: Math.abs((res.observerDeltaM ?? 0) - dh),
    };
  }

  it("ошибка высоты в ±70 м восстанавливается вместе с позой", async () => {
    const scenes = Number(process.env.PF_HEIGHT ?? 4);
    let good = 0;
    const lines: string[] = [];
    for (let s = 0; s < scenes; s++) {
      const dh = s % 2 === 0 ? 70 : -70;
      const on = await heightScene(s, dh, true);
      const pass =
        on.ok && on.dAz < 0.4 && on.dEl < 0.5 && on.dFov < 0.03 && on.dDh < 25;
      if (pass) good++;
      let off = "";
      if (process.env.PF_HEIGHT) {
        const o = await heightScene(s, dh, false);
        off = ` | без высоты: ${o.ok ? "ok" : o.reason} az ${o.dAz.toFixed(2)} el ${o.dEl.toFixed(2)} fov ${(o.dFov * 100).toFixed(1)}%`;
      }
      lines.push(
        `#${s} dh ${dh} ${pass ? "ok" : "--"} ${on.reason ?? ""} az ${on.dAz.toFixed(2)} el ${on.dEl.toFixed(2)} fov ${(on.dFov * 100).toFixed(1)}% dDh ${on.dDh.toFixed(0)}${off}`,
      );
    }
    if (process.env.PF_HEIGHT) console.log(lines.join("\n"));
    expect(good).toBeGreaterThanOrEqual(scenes - Math.floor(scenes / 4));
  }, 300_000);

  it("DEM врёт на флангах и искажён: неверных ответов нет", async () => {
    const scenes = Number(process.env.PF_FLANKS ?? 6);
    const W = 1280;
    const H = 720;
    let wrong = 0;
    const lines: string[] = [];
    for (let s = 0; s < scenes; s++) {
      const rand = rng(9100 + s);
      const real = makeHorizon(1300 + s);
      const truth: CameraPose = {
        azRad: deg(rand() * 360),
        elevRad: deg(-4 + rand() * 6),
        rollRad: deg(-1.5 + rand() * 3),
        fovHRad: deg(55 + rand() * 25),
      };
      // DEM выше настоящего силуэта на флангах кадра (дымка, дальние гребни,
      // принятые за небо), в середине — точная форма с плавным искажением
      // ±0.5° (острую стену DEM 90 м сглаживает на 5–10 px)
      const dem = Float32Array.from(real, (e, k) => {
        const dA = Math.abs(wrapDeg(toDeg(k * STEP - truth.azRad)));
        const wobble = deg(0.5) * Math.sin(k * STEP * 9 + s);
        return dA > 0.27 * toDeg(truth.fovHRad)
          ? e + deg(2.8) + wobble
          : e + wobble;
      });
      const points = renderSkyline(real, truth, {
        width: W,
        height: H,
        noisePx: 1.2,
        outlierFrac: 0.04,
        seed: s + 1,
      });
      const res = await fitPhotoCamera({
        width: W,
        height: H,
        points,
        horizon: dem,
        stepRad: STEP,
        prior: {
          azRad: deg(rand() * 360),
          elevRad: 0,
          rollRad: 0,
          fovHRad: fovForFrame(deg(70), W, H).h,
        },
        distanceM: makeDistances(1400 + s),
      });
      const dAz = Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)));
      const dEl = Math.abs(toDeg(res.pose.elevRad - truth.elevRad));
      const dFov = Math.abs(res.pose.fovHRad / truth.fovHRad - 1);
      const right = res.ok && dAz < 1.5 && dEl < 1.5 && dFov < 0.1;
      if (res.ok && !right) wrong++;
      lines.push(
        `#${s} ${res.ok ? (right ? "ok" : "WRONG") : res.reason} az ${dAz.toFixed(2)} el ${dEl.toFixed(2)} fov ${(dFov * 100).toFixed(1)}%`,
      );
    }
    if (process.env.PF_FLANKS) console.log(lines.join("\n"));
    // Лучше честный отказ, чем неверный ответ
    expect(wrong).toBe(0);
  }, 300_000);
});

describe("облака закрывают часть гор", () => {
  const prior = (W: number, H: number): CameraPose => ({
    azRad: deg(10),
    elevRad: 0,
    rollRad: 0,
    fovHRad: fovForFrame(deg(70), W, H).h,
  });

  /** Серия сцен: облако скрывает вершины на доле ширины `cover` */
  async function cloudSweep(
    scenes: number,
    cover: number,
    occlusion: boolean,
  ): Promise<{ good: number; wrong: number; lines: string[] }> {
    const W = 1280;
    const H = 720;
    const rand = rng(31337);
    let good = 0;
    let wrong = 0;
    const lines: string[] = [];
    for (let s = 0; s < scenes; s++) {
      const horizon = makeHorizon(300 + s);
      const truth: CameraPose = {
        azRad: deg(rand() * 360),
        elevRad: deg(-4 + rand() * 12),
        rollRad: deg(-2 + rand() * 4),
        fovHRad: deg(50 + rand() * 40),
      };
      const from = 0.1 + rand() * (0.8 - cover);
      const points = renderSkyline(horizon, truth, {
        width: W,
        height: H,
        noisePx: 1.2,
        outlierFrac: 0.04,
        clouds: [{ from, to: from + cover, cut: 0.9, onPeak: true }],
        seed: s + 1,
      });
      const res = await fitPhotoCamera({
        width: W,
        height: H,
        points,
        horizon,
        stepRad: STEP,
        prior: prior(W, H),
        occlusion,
      });
      const dAz = Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)));
      const dEl = Math.abs(toDeg(res.pose.elevRad - truth.elevRad));
      const dFov = Math.abs(res.pose.fovHRad / truth.fovHRad - 1);
      const pass = res.ok && dAz < 0.4 && dEl < 0.5 && dFov < 0.04;
      if (pass) good++;
      if (res.ok && !pass) wrong++;
      lines.push(
        `#${s} ${pass ? "ok" : "--"} ${res.reason ?? res.quality} az ${dAz.toFixed(2)} el ${dEl.toFixed(2)} fov ${(dFov * 100).toFixed(1)}% inl ${res.diagnostics.inlierFrac.toFixed(2)} occ ${res.diagnostics.occludedFrac.toFixed(2)} uniq ${res.diagnostics.uniqueness.toFixed(2)}`,
      );
    }
    return { good, wrong, lines };
  }

  it("гора, закрытая облаком на трети кадра, находится без ошибочных ответов", async () => {
    const scenes = Number(process.env.PF_CLOUDS ?? 6);
    const cover = Number(process.env.PF_COVER ?? 0.3);
    const on = await cloudSweep(scenes, cover, true);
    if (process.env.PF_CLOUDS) {
      const off = await cloudSweep(scenes, cover, false);
      console.log(
        `occlusion on: ${on.good}/${scenes} wrong ${on.wrong}\n${on.lines.join("\n")}\noff: ${off.good}/${scenes} wrong ${off.wrong}\n${off.lines.join("\n")}`,
      );
    }
    expect(on.wrong).toBe(0);
    expect(on.good).toBeGreaterThanOrEqual(scenes - Math.floor(scenes / 6));
  }, 300_000);

  it("ложных срабатываний нет: случайная линия и линия другого рельефа", async () => {
    const W = 1280;
    const H = 720;
    const trials = Number(process.env.PF_FP ?? 6);
    const rand = rng(777);
    let falsePositives = 0;
    const lines: string[] = [];
    for (let t = 0; t < trials; t++) {
      const horizon = makeHorizon(500 + t);
      // (а) снимок ДРУГОГО рельефа: тот же размах, другие вершины
      const foreign = makeHorizon(900 + t);
      const truth: CameraPose = {
        azRad: deg(rand() * 360),
        elevRad: deg(-3 + rand() * 9),
        rollRad: deg(-2 + rand() * 4),
        fovHRad: deg(50 + rand() * 40),
      };
      const withCloud = rand() < 0.5;
      const points = renderSkyline(foreign, truth, {
        width: W,
        height: H,
        noisePx: 1.2,
        outlierFrac: 0.04,
        clouds: withCloud ? [{ from: 0.3, to: 0.65, cut: 0.6 }] : [],
        seed: t + 1,
      });
      const res = await fitPhotoCamera({
        width: W,
        height: H,
        points,
        horizon,
        stepRad: STEP,
        prior: prior(W, H),
        distanceM: makeDistances(1000 + t),
      });
      // (б) случайная ломаная
      const xs: number[] = [];
      const ys: number[] = [];
      const ws: number[] = [];
      let y = H * 0.45;
      for (let x = 3; x < W; x += 3) {
        y = Math.min(H * 0.8, Math.max(H * 0.2, y + gauss(rand) * 6));
        xs.push(x);
        ys.push(y);
        ws.push(1);
      }
      const rnd = await fitPhotoCamera({
        width: W,
        height: H,
        points: {
          x: Float32Array.from(xs),
          y: Float32Array.from(ys),
          w: Float32Array.from(ws),
        },
        horizon,
        stepRad: STEP,
        prior: prior(W, H),
        distanceM: makeDistances(1000 + t),
      });
      if (res.ok) falsePositives++;
      if (rnd.ok) falsePositives++;
      lines.push(
        `#${t} foreign ${res.ok ? "OK!" : res.reason} fov ${toDeg(res.pose.fovHRad).toFixed(0)}/${toDeg(truth.fovHRad).toFixed(0)} cost ${res.diagnostics.cost.toFixed(3)} rms ${res.diagnostics.rmsPx.toFixed(1)} cov ${res.diagnostics.coverage.toFixed(2)} inl ${res.diagnostics.inlierFrac.toFixed(2)} uniq ${res.diagnostics.uniqueness.toFixed(2)} | random ${rnd.ok ? "OK!" : rnd.reason} inl ${rnd.diagnostics.inlierFrac.toFixed(2)}`,
      );
    }
    if (process.env.PF_FP) console.log(lines.join("\n"));
    expect(falsePositives).toBe(0);
  }, 300_000);

  it("варианты направлений: на чужом рельефе и случайной линии не предлагаются", async () => {
    const W = 1280;
    const H = 720;
    const trials = Number(process.env.PF_ALT ?? 6);
    const rand = rng(4242);
    let offered = 0;
    const lines: string[] = [];
    for (let t = 0; t < trials; t++) {
      const horizon = makeHorizon(3500 + t);
      const foreign = makeHorizon(3900 + t);
      const truth: CameraPose = {
        azRad: deg(rand() * 360),
        elevRad: deg(-3 + rand() * 9),
        rollRad: deg(-2 + rand() * 4),
        fovHRad: deg(50 + rand() * 40),
      };
      const common = {
        width: W,
        height: H,
        horizon,
        stepRad: STEP,
        prior: prior(W, H),
        distanceM: makeDistances(4000 + t),
        fovKnown: true,
      };
      const alien = await fitPhotoCamera({
        ...common,
        points: renderSkyline(foreign, truth, {
          width: W,
          height: H,
          noisePx: 1.2,
          outlierFrac: 0.04,
          seed: t + 1,
        }),
      });
      const xs: number[] = [];
      const ys: number[] = [];
      let y = H * 0.45;
      for (let x = 3; x < W; x += 3) {
        y = Math.min(H * 0.8, Math.max(H * 0.2, y + gauss(rand) * 6));
        xs.push(x);
        ys.push(y);
      }
      const rnd = await fitPhotoCamera({
        ...common,
        points: {
          x: Float32Array.from(xs),
          y: Float32Array.from(ys),
          w: new Float32Array(xs.length).fill(1),
        },
      });
      const bad = (r: typeof alien): boolean =>
        r.ok || (r.alternatives?.length ?? 0) >= 2;
      if (bad(alien)) offered++;
      if (bad(rnd)) offered++;
      lines.push(
        `#${t} alien ${alien.ok ? "OK!" : (alien.alternatives?.length ?? 0) >= 2 ? `ALT${alien.alternatives?.length}` : alien.reason} | random ${rnd.ok ? "OK!" : (rnd.alternatives?.length ?? 0) >= 2 ? `ALT${rnd.alternatives?.length}` : rnd.reason}`,
      );
    }
    if (process.env.PF_ALT) console.log(lines.join("\n"));
    // Варианты — предложение пользователю, а не ответ, но применяются сразу
    expect(offered).toBeLessThanOrEqual(Math.ceil(trials * 2 * 0.05));
  }, 300_000);

  it("с подсказкой азимута: своя сцена находится, чужая и случайная линия — нет", async () => {
    const W = 1280;
    const H = 720;
    const trials = Number(process.env.PF_HINT ?? 6);
    const rand = rng(31337);
    let found = 0;
    let falsePositives = 0;
    const lines: string[] = [];
    for (let t = 0; t < trials; t++) {
      const horizon = makeHorizon(2000 + t);
      const foreign = makeHorizon(2500 + t);
      const truth: CameraPose = {
        azRad: deg(rand() * 360),
        elevRad: deg(-3 + rand() * 9),
        rollRad: deg(-2 + rand() * 4),
        fovHRad: deg(50 + rand() * 40),
      };
      const common = {
        width: W,
        height: H,
        horizon,
        stepRad: STEP,
        prior: prior(W, H),
        distanceM: makeDistances(3000 + t),
      };
      // Подсказка пользователя отличается от истины до ±10°
      const hint = {
        centerRad: truth.azRad + deg(-10 + rand() * 20),
        halfRad: deg(15),
      };
      const own = await fitPhotoCamera({
        ...common,
        points: renderSkyline(horizon, truth, {
          width: W,
          height: H,
          noisePx: 1.2,
          outlierFrac: 0.04,
          seed: t + 1,
        }),
        azHint: hint,
      });
      if (
        own.ok &&
        Math.abs(wrapDeg(toDeg(own.pose.azRad - truth.azRad))) < 0.5 &&
        Math.abs(own.pose.fovHRad / truth.fovHRad - 1) < 0.03
      ) {
        found++;
      }
      const alien = await fitPhotoCamera({
        ...common,
        points: renderSkyline(foreign, truth, {
          width: W,
          height: H,
          noisePx: 1.2,
          outlierFrac: 0.04,
          seed: t + 1,
        }),
        azHint: hint,
      });
      const xs: number[] = [];
      const ys: number[] = [];
      let y = H * 0.45;
      for (let x = 3; x < W; x += 3) {
        y = Math.min(H * 0.8, Math.max(H * 0.2, y + gauss(rand) * 6));
        xs.push(x);
        ys.push(y);
      }
      const rnd = await fitPhotoCamera({
        ...common,
        points: {
          x: Float32Array.from(xs),
          y: Float32Array.from(ys),
          w: new Float32Array(xs.length).fill(1),
        },
        azHint: hint,
      });
      if (alien.ok) falsePositives++;
      if (rnd.ok) falsePositives++;
      // Известный FOV (EXIF) включает ослабленный критерий спасения
      const rndKnown = await fitPhotoCamera({
        ...common,
        points: {
          x: Float32Array.from(xs),
          y: Float32Array.from(ys),
          w: new Float32Array(xs.length).fill(1),
        },
        fovKnown: true,
        azHint: hint,
      });
      const alienKnown = await fitPhotoCamera({
        ...common,
        points: renderSkyline(foreign, truth, {
          width: W,
          height: H,
          noisePx: 1.2,
          outlierFrac: 0.04,
          seed: t + 1,
        }),
        fovKnown: true,
        azHint: hint,
      });
      if (alienKnown.ok) falsePositives++;
      if (rndKnown.ok) falsePositives++;
      if (alienKnown.ok || rndKnown.ok) {
        const w = alienKnown.ok ? alienKnown : rndKnown;
        lines.push(
          `FP#${t} ${alienKnown.ok ? "alien" : "random"} inl ${w.diagnostics.inlierFrac.toFixed(2)} cov ${w.diagnostics.coverage.toFixed(2)} run ${(w.diagnostics.runFrac ?? 0).toFixed(2)}/${(w.diagnostics.runReliefDeg ?? 0).toFixed(1)} fov ${toDeg(w.pose.fovHRad).toFixed(0)} rms ${w.diagnostics.rmsPx.toFixed(1)}`,
        );
      }
      lines.push(
        `#${t} own ${own.ok ? "ok" : own.reason} | foreign ${alien.ok ? "OK!" : alien.reason} | random ${rnd.ok ? "OK!" : rnd.reason} inl ${rnd.diagnostics.inlierFrac.toFixed(2)} cov ${rnd.diagnostics.coverage.toFixed(2)} fov ${toDeg(rnd.pose.fovHRad).toFixed(0)} own-inl ${own.diagnostics.inlierFrac.toFixed(2)}`,
      );
    }
    if (process.env.PF_HINT) console.log(lines.join("\n"));
    expect(found).toBeGreaterThanOrEqual(Math.ceil(trials * 0.8));
    // Подсказка убирает из поиска все направления, кроме ±15°, и неоднозначность
    // между азимутами пропадает: чужой рельеф изредка подходит в узком окне
    // (измерено ~2 % на 240 попытках). Предел 3 % — характеристика режима,
    // а не «ноль»; результат всегда «приблизительно»
    expect(falsePositives).toBeLessThanOrEqual(Math.ceil(trials * 4 * 0.03));
  }, 300_000);
});

describe("fitPhotoCamera: восстановление позы по линии неба", () => {
  it("слепой азимут и FOV: ландшафт, крен, наклон, выбросы и человек", async () => {
    const W = 1280;
    const H = 720;
    const horizon = makeHorizon(11);
    const truth: CameraPose = {
      azRad: deg(137.3),
      elevRad: deg(4.2),
      rollRad: deg(1.6),
      fovHRad: deg(63),
    };
    const points = renderSkyline(horizon, truth, {
      width: W,
      height: H,
      noisePx: 1.2,
      outlierFrac: 0.08,
      blockFrac: 0.08,
    });
    const prior: CameraPose = {
      azRad: deg(300),
      elevRad: 0,
      rollRad: 0,
      fovHRad: fovForFrame(deg(70), W, H).h,
    };
    const res = await fitPhotoCamera({
      width: W,
      height: H,
      points,
      horizon,
      stepRad: STEP,
      prior,
    });
    expect(res.ok).toBe(true);
    expect(Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)))).toBeLessThan(
      0.15,
    );
    expect(Math.abs(toDeg(res.pose.elevRad - truth.elevRad))).toBeLessThan(0.2);
    expect(Math.abs(toDeg(res.pose.rollRad - truth.rollRad))).toBeLessThan(0.3);
    expect(Math.abs(res.pose.fovHRad / truth.fovHRad - 1)).toBeLessThan(0.02);
    expect(res.diagnostics.fovObservable).toBe(true);
    expect(res.diagnostics.rmsPx).toBeLessThan(3);
  }, 60_000);

  it("FOV известен (EXIF): тот же кадр, узкий коридор FOV", async () => {
    const W = 1280;
    const H = 720;
    const horizon = makeHorizon(23);
    const truth: CameraPose = {
      azRad: deg(20.5),
      elevRad: deg(-2.5),
      rollRad: deg(-2.2),
      fovHRad: deg(55),
    };
    const points = renderSkyline(horizon, truth, {
      width: W,
      height: H,
      noisePx: 1,
      outlierFrac: 0.05,
      seed: 3,
    });
    const res = await fitPhotoCamera({
      width: W,
      height: H,
      points,
      horizon,
      stepRad: STEP,
      prior: {
        azRad: deg(200),
        elevRad: 0,
        rollRad: 0,
        // EXIF чуть врёт: 35-мм эквивалент округлён и кадр может быть кропом
        fovHRad: deg(55 * 1.04),
      },
      fovKnown: true,
    });
    console.log(
      JSON.stringify({
        ok: res.ok,
        reason: res.reason,
        pose: {
          az: toDeg(res.pose.azRad),
          el: toDeg(res.pose.elevRad),
          roll: toDeg(res.pose.rollRad),
          fov: toDeg(res.pose.fovHRad),
        },
        d: res.diagnostics,
      }),
    );
    expect(res.ok).toBe(true);
    expect(Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)))).toBeLessThan(
      0.15,
    );
    expect(Math.abs(toDeg(res.pose.elevRad - truth.elevRad))).toBeLessThan(0.2);
    expect(Math.abs(toDeg(res.pose.rollRad - truth.rollRad))).toBeLessThan(0.3);
    expect(Math.abs(res.pose.fovHRad / truth.fovHRad - 1)).toBeLessThan(0.02);
  }, 60_000);

  it("портретный кадр и широкий угол", async () => {
    const W = 720;
    const H = 1280;
    const horizon = makeHorizon(5);
    const truth: CameraPose = {
      azRad: deg(251),
      elevRad: deg(8),
      rollRad: deg(-0.8),
      fovHRad: deg(66),
    };
    const points = renderSkyline(horizon, truth, {
      width: W,
      height: H,
      noisePx: 1,
      outlierFrac: 0.05,
      seed: 9,
    });
    const res = await fitPhotoCamera({
      width: W,
      height: H,
      points,
      horizon,
      stepRad: STEP,
      prior: {
        azRad: 0,
        elevRad: 0,
        rollRad: 0,
        fovHRad: fovForFrame(deg(70), W, H).h,
      },
    });
    console.log(
      JSON.stringify({
        ok: res.ok,
        reason: res.reason,
        pose: {
          az: toDeg(res.pose.azRad),
          el: toDeg(res.pose.elevRad),
          roll: toDeg(res.pose.rollRad),
          fov: toDeg(res.pose.fovHRad),
        },
        d: res.diagnostics,
      }),
    );
    expect(res.ok).toBe(true);
    expect(Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)))).toBeLessThan(
      0.2,
    );
    expect(Math.abs(toDeg(res.pose.elevRad - truth.elevRad))).toBeLessThan(0.3);
    expect(Math.abs(toDeg(res.pose.rollRad - truth.rollRad))).toBeLessThan(0.4);
    expect(Math.abs(res.pose.fovHRad / truth.fovHRad - 1)).toBeLessThan(0.03);
  }, 60_000);

  it("линия, не имеющая отношения к рельефу, отклоняется", async () => {
    const W = 1280;
    const H = 720;
    const horizon = makeHorizon(31);
    const r = rng(99);
    const xs: number[] = [];
    const ys: number[] = [];
    const ws: number[] = [];
    for (let x = 3; x < W; x += 3) {
      xs.push(x);
      ys.push(H * (0.2 + 0.6 * r()));
      ws.push(1);
    }
    const res = await fitPhotoCamera({
      width: W,
      height: H,
      points: {
        x: Float32Array.from(xs),
        y: Float32Array.from(ys),
        w: Float32Array.from(ws),
      },
      horizon,
      stepRad: STEP,
      prior: {
        azRad: 0,
        elevRad: 0,
        rollRad: 0,
        fovHRad: fovForFrame(deg(70), W, H).h,
      },
    });
    expect(res.ok).toBe(false);
  }, 60_000);

  it("серия случайных сцен и поз: азимут и FOV слепые", async () => {
    const scenes = Number(process.env.PF_SWEEP ?? 6);
    const rand = rng(2024);
    let good = 0;
    let wrong = 0;
    const lines: string[] = [];
    for (let s = 0; s < scenes; s++) {
      const portrait = rand() < 0.3;
      const W = portrait ? 720 : 1280;
      const H = portrait ? 1280 : 720;
      const horizon = makeHorizon(100 + s);
      const truth: CameraPose = {
        azRad: deg(rand() * 360),
        elevRad: deg(-6 + rand() * 18),
        rollRad: deg(-3 + rand() * 6),
        fovHRad: deg(portrait ? 40 + rand() * 25 : 45 + rand() * 50),
      };
      const withBlock = rand() < 0.5;
      const priorAz = deg(rand() * 360);
      if (process.env.PF_ONLY && Number(process.env.PF_ONLY) !== s) {
        good++;
        continue;
      }
      const points = renderSkyline(horizon, truth, {
        width: W,
        height: H,
        noisePx: 1.2,
        outlierFrac: 0.06,
        blockFrac: withBlock ? 0.07 : 0,
        seed: s + 1,
      });
      const res = await fitPhotoCamera({
        width: W,
        height: H,
        points,
        horizon,
        stepRad: STEP,
        prior: {
          azRad: priorAz,
          elevRad: 0,
          rollRad: 0,
          fovHRad: fovForFrame(deg(70), W, H).h,
        },
      });
      const dAz = Math.abs(wrapDeg(toDeg(res.pose.azRad - truth.azRad)));
      const dEl = Math.abs(toDeg(res.pose.elevRad - truth.elevRad));
      const dRoll = Math.abs(toDeg(res.pose.rollRad - truth.rollRad));
      const dFov = Math.abs(res.pose.fovHRad / truth.fovHRad - 1);
      const pass =
        res.ok && dAz < 0.3 && dEl < 0.4 && dRoll < 0.6 && dFov < 0.03;
      if (pass) good++;
      // Честный отказ допустим (плоский рельеф в кадре), уверенная ошибка — нет
      if (res.ok && !pass) wrong++;
      lines.push(
        `#${s} ${pass ? "ok" : "FAIL"} ${res.reason ?? ""} truth az ${toDeg(truth.azRad).toFixed(0)} el ${toDeg(truth.elevRad).toFixed(1)} fov ${toDeg(truth.fovHRad).toFixed(0)} ${W}x${H} | az ${dAz.toFixed(2)} el ${dEl.toFixed(2)} roll ${dRoll.toFixed(2)} fov ${(dFov * 100).toFixed(1)}% cost ${res.diagnostics.cost.toFixed(3)} uniq ${res.diagnostics.uniqueness.toFixed(2)} pts ${points.x.length}`,
      );
    }
    if (process.env.PF_SWEEP) console.log(lines.join("\n"));
    expect(wrong).toBe(0);
    expect(good).toBeGreaterThanOrEqual(
      scenes - Math.max(1, Math.floor(scenes / 12)),
    );
  }, 300_000);

  it("пустая линия неба — отказ no-skyline", async () => {
    const res = await fitPhotoCamera({
      width: 1280,
      height: 720,
      points: {
        x: new Float32Array(0),
        y: new Float32Array(0),
        w: new Float32Array(0),
      },
      horizon: makeHorizon(1),
      stepRad: STEP,
      prior: { azRad: 0, elevRad: 0, rollRad: 0, fovHRad: deg(60) },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-skyline");
  });
});
