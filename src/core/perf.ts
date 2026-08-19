/**
 * Отладочный профайлер рендера (?perf в URL): считает частоту кадров,
 * время фаз рендера, объём нарисованной геометрии и источники перерисовок;
 * раз в 2 с печатает сводку в консоль. По сводке видно, что именно ест
 * GPU/CPU: длинные фазы (JS-время) — CPU, точки/штрихи на кадр — объём
 * работы GPU, счётчики src* — откуда приходят перерисовки.
 *
 * Без ?perf все вызовы — no-op (одно булево сравнение): в проде ничего
 * не замеряется и не аллоцируется.
 */

const REPORT_MS = 2000;

export const perfEnabled =
  typeof location !== "undefined" &&
  typeof URLSearchParams !== "undefined" &&
  new URLSearchParams(location.search).has("perf");

interface PhaseStat {
  sum: number;
  n: number;
  max: number;
}
const phases = new Map<string, PhaseStat>();
const counters = new Map<string, number>();

function phase(name: string): PhaseStat {
  let p = phases.get(name);
  if (!p) {
    p = { sum: 0, n: 0, max: 0 };
    phases.set(name, p);
  }
  return p;
}

/** Замер длительности фазы, мс (JS-время фазы — это CPU-часть кадра) */
export function perfPhase(name: string, ms: number): void {
  if (!perfEnabled || !Number.isFinite(ms)) return;
  const p = phase(name);
  p.sum += ms;
  p.n++;
  if (ms > p.max) p.max = ms;
}

/** Счётчик событий: источники перерисовок, точки/штрихи/тексты на кадр */
export function perfCount(name: string, by = 1): void {
  if (!perfEnabled) return;
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/** Полный кадр (draw() панорамы или кадр AR) */
export function perfFrame(ms: number): void {
  perfPhase("frame", ms);
  perfCount("frames");
}

if (perfEnabled) {
  console.info(
    `[perf] включено: раз в ${REPORT_MS / 1000} с печатается сводка фаз ` +
      "рендера и источников перерисовок",
  );
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dtS = (now - last) / 1000;
    last = now;
    const frames = counters.get("frames") ?? 0;
    counters.delete("frames");
    // В покое кадров нет — молчим, чтобы не спамить консоль
    if (!frames) {
      phases.clear();
      counters.clear();
      return;
    }
    const canvas =
      typeof document !== "undefined"
        ? (document.querySelector("canvas") as HTMLCanvasElement | null)
        : null;
    const mp = canvas ? (canvas.width * canvas.height) / 1e6 : 0;
    const fmt = (ms: number): string =>
      ms < 1 ? ms.toFixed(2) : ms.toFixed(1);
    const phaseParts: string[] = [];
    for (const [name, p] of phases) {
      const avg = p.sum / p.n;
      phaseParts.push(`${name} ${fmt(avg)}мс×${p.n} (max ${fmt(p.max)})`);
    }
    const countParts: string[] = [];
    for (const [name, v] of counters) countParts.push(`${name} ${v}`);
    console.log(
      `[perf] ${dtS.toFixed(1)} с · кадров ${frames} ` +
        `(${(frames / dtS).toFixed(1)}/с)` +
        (canvas
          ? ` · холст ${canvas.width}×${canvas.height} (${mp.toFixed(1)} Мп)`
          : ""),
    );
    if (phaseParts.length) console.log("  " + phaseParts.join(" · "));
    if (countParts.length) console.log("  " + countParts.join(" · "));
    phases.clear();
    counters.clear();
  }, REPORT_MS);
}
