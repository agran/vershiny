/**
 * Подтяжка профилей панорамы к вершинам OSM (core/silhouette-lift.ts).
 * Вершина поднимает только корзину своей дистанции и верхний слой.
 */

import { describe, it, expect } from "vitest";
import { liftPanoramaByPeaks } from "../src/core/silhouette-lift";

const deg = (d: number): number => (d * Math.PI) / 180;
const RAYS = 3600;
const STEP = (2 * Math.PI) / RAYS;

const flat = (v: number): Float32Array => new Float32Array(RAYS).fill(deg(v));
const at = (p: Float32Array, azDeg: number): number =>
  (p[Math.round(deg(azDeg) / STEP)] * 180) / Math.PI;

describe("liftPanoramaByPeaks", () => {
  it("поднимает верхний слой и корзину гребней с дистанцией вершины", () => {
    const crests = [flat(-1), flat(-1), flat(0.5), flat(-1)];
    const horizon = flat(0.5);
    const panorama = { horizon, stepRad: STEP, crests };
    liftPanoramaByPeaks(panorama, [
      { azimuthRad: deg(120), elevationRad: deg(3), distanceM: 3000 },
    ]);
    // Корзина 2000–5000 м и horizon дотянулись до вершины
    expect(at(crests[2], 120)).toBeCloseTo(3, 1);
    expect(at(horizon, 120)).toBeCloseTo(3, 1);
    // Остальные корзины не тронуты
    expect(at(crests[0], 120)).toBeCloseTo(-1, 5);
    expect(at(crests[1], 120)).toBeCloseTo(-1, 5);
    expect(at(crests[3], 120)).toBeCloseTo(-1, 5);
    // Вдали от вершины всё как было
    expect(at(horizon, 200)).toBeCloseTo(0.5, 5);
  });

  it("без вершин ничего не меняет", () => {
    const horizon = flat(1);
    liftPanoramaByPeaks({ horizon, stepRad: STEP }, []);
    expect(at(horizon, 10)).toBeCloseTo(1, 5);
  });
});
