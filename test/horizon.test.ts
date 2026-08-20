import { describe, expect, it } from "vitest";
import {
    azimuthRad,
    destination,
    earthDrop,
    makeRayMarcher,
    wrapAngle,
    type LatLon,
} from "../src/core/geo";
import {
    buildMarchTable,
    checkPeakVisibility,
    computeHorizon,
    computeLayeredHorizon,
    nextRayStep,
    type SampleFn,
} from "../src/core/horizon";
import type { Peak } from "../src/core/peaks";

/** Синтетический рельеф: один конус высотой peakH на дистанции coneDist по азимуту coneAz */
function conicSampler(
  origin: LatLon,
  coneAz: number,
  coneDist: number,
  peakH: number,
): SampleFn {
  const apex = destination(origin, coneAz, coneDist);
  return (pos) => {
    const d = Math.hypot(pos.lat - apex.lat, pos.lon - apex.lon) * 111_320;
    return Math.max(0, peakH - d * 0.5); // склон 0.5 м/м
  };
}

const ORIGIN: LatLon = { lat: 43, lon: 42 };

describe("ray-marching горизонта", () => {
  it("адаптивный шаг растёт с дистанцией", () => {
    expect(nextRayStep(1_000)).toBe(90);
    expect(nextRayStep(10_000)).toBe(180);
    expect(nextRayStep(50_000)).toBe(350);
    expect(nextRayStep(150_000)).toBe(700);
  });

  it("конус виден на горизонте под своим азимутом", () => {
    const coneAz = Math.PI / 3;
    const sample = conicSampler(ORIGIN, coneAz, 20_000, 3000);
    const { angles, stepRad } = computeHorizon(ORIGIN, 0, sample, {
      maxDistM: 50_000,
    });
    const idx = Math.round(coneAz / stepRad);
    // Угол на конус: atan((3000 − drop(20км)) / 20000) ≈ 8.4°
    expect(angles[idx]).toBeGreaterThan(0.12);
    expect(angles[idx]).toBeLessThan(0.16);
    // Перпендикулярный азимут — ровная земля, горизонт ≈ 0
    const flatIdx = Math.round(((coneAz + Math.PI) % (2 * Math.PI)) / stepRad);
    expect(angles[flatIdx]).toBeLessThan(0.005);
  });

  it("пик за высоким хребтом невидим, без хребта — виден", () => {
    const far: Peak = { lat: 0, lon: 0, name: "Дальняя", ele: 5000 };
    // Разместим дальний пик через destination на 80 км на восток
    const farPos = destination(ORIGIN, Math.PI / 2, 80_000);
    far.lat = farPos.lat;
    far.lon = farPos.lon;

    // Рельеф: хребет 4000 м на 30 км — закрывает дальний пик
    const blocked = conicSampler(ORIGIN, Math.PI / 2, 30_000, 4000);
    expect(checkPeakVisibility(ORIGIN, 1000, far, blocked, 30_000)).toBeNull();

    // Ровная земля — пик виден (угол ~0.4°)
    const flat: SampleFn = () => 0;
    const visible = checkPeakVisibility(ORIGIN, 1000, far, flat, Infinity);
    expect(visible).not.toBeNull();
    expect(visible!.distanceM).toBeCloseTo(80_000, -3);
  });

  it("пик, которому чуть не хватило до гребня, подписывается как hidden", () => {
    // Хребет 4000 м на 30 км; за ним, на 35 км, вершина
    const ridge = conicSampler(ORIGIN, Math.PI / 2, 30_000, 4000);
    const pos = destination(ORIGIN, Math.PI / 2, 35_000);

    // 4350 м — не дотягивает до линии гребня меньше 150 м: «немного не видно»
    const barely = checkPeakVisibility(
      ORIGIN,
      1000,
      { ...pos, name: "Почти видна", ele: 4350 },
      ridge,
      30_000,
    );
    expect(barely).not.toBeNull();
    expect(barely!.visibility).toBe("hidden");
    // Недобор до гребня измерен и доступен раскладке подписей
    expect(barely!.hiddenDeficitM).toBeGreaterThan(0);
    expect(barely!.hiddenDeficitM).toBeLessThan(400);

    // 4000 м — не хватает уже больше 400 м: не подписываем
    const buried = checkPeakVisibility(
      ORIGIN,
      1000,
      { ...pos, name: "Погребённая", ele: 4000 },
      ridge,
      30_000,
    );
    expect(buried).toBeNull();

    // 3000 м — погребена под хребтом на полтора километра
    expect(
      checkPeakVisibility(
        ORIGIN,
        1000,
        { ...pos, name: "Глубоко", ele: 3000 },
        ridge,
        30_000,
      ),
    ).toBeNull();

    // 4600 м — выше гребня, обычная видимая вершина с маркером
    const above = checkPeakVisibility(
      ORIGIN,
      1000,
      { ...pos, name: "Над гребнем", ele: 4600 },
      ridge,
      30_000,
    );
    expect(above!.visibility).toBe("visible");
  });

  it("пик вне 200 км отбрасывается", () => {
    const flat: SampleFn = () => 0;
    const farPos = destination(ORIGIN, 0, 250_000);
    const peak: Peak = { ...farPos, name: "Очень дальняя", ele: 8000 };
    expect(checkPeakVisibility(ORIGIN, 1000, peak, flat, Infinity)).toBeNull();
  });

  it("ближний и дальний хребты дают разные фронты", () => {
    // Раньше ветка «провал — закрываем фронт» на каждой точке ниже максимума
    // растягивала distEndM до текущей дистанции. Разрыв между фронтами не
    // возникал никогда: дальний хребет прилипал к ближнему, один фронт тянулся
    // на десятки километров, и маркер вершины выбирал его для чего угодно
    const az = Math.PI / 2;
    // Дальний хребет должен быть выше ближнего по углу, иначе он честно
    // скрыт за ним и своего фронта не получает
    const near = conicSampler(ORIGIN, az, 5_000, 600);
    const far = conicSampler(ORIGIN, az, 40_000, 8_000);
    const sample: SampleFn = (pos, dist) =>
      Math.max(near(pos, dist), far(pos, dist));

    const { fronts, stepRad } = computeLayeredHorizon(ORIGIN, 0, sample, {
      maxDistM: 60_000,
      azimuthStepRad: (0.5 * Math.PI) / 180,
    });
    const ray = fronts[Math.round(az / stepRad)];

    expect(ray.length).toBeGreaterThanOrEqual(2);
    const nearFront = ray[ray.length - 2];
    const farFront = ray[ray.length - 1];
    // Ближний фронт заканчивается на своём гребне, а не тянется до дальнего
    expect(nearFront.distEndM).toBeLessThan(10_000);
    expect(farFront.distM).toBeGreaterThan(20_000);
  });

  it("маркирующая функция луча совпадает с destination побитово", () => {
    // Таблица шагов общая для всех лучей панорамы; точки из неё должны
    // совпадать бит-в-бит с прямым вызовом destination() на каждом шаге.
    // Проверяем несколько азимутов из рабочего диапазона марша [0, 2π)
    const march = buildMarchTable(100, 50_000);
    for (const az of [0.0001, 1.234, 3.5, 5.9]) {
      const pointAt = makeRayMarcher(ORIGIN, az, march);
      for (let s = 0; s < march.count; s += 17) {
        const ref = destination(ORIGIN, az, march.d[s]);
        const p = pointAt(s);
        expect(p.lat).toBe(ref.lat);
        expect(p.lon).toBe(ref.lon);
      }
    }
  });

  it("дальний слой сглаживается своей дистанцией, а не ближним гребнем", () => {
    // Регресс: все слои гладились общим distanceToHorizonM (минимум по
    // корзинам). Ближний гребень (1 км) на луче 0 задавал окно ±8 лучей
    // дальнему слою, и острая гора на 100 км усреднялась с дальним плато
    // соседних лучей (155–170 км) — дальние пики смазывались.
    const step = 1 / 600; // окно сглаживания на 100 км = 2 луча
    // Дистанция марша, ближайшая к 100 км СВЕРХУ: гора должна попасть
    // в корзину 100–200 км (layers[4]), а не в 40–100 км
    const march = buildMarchTable(100 * 1.5, 200_000);
    let D = 0;
    for (let s = 0; s < march.count; s++) {
      if (march.d[s] >= 100_000) {
        D = march.d[s];
        break;
      }
    }
    expect(D).toBeGreaterThan(0);

    const sample: SampleFn = (pos, d) => {
      // Ближний гребень на всех лучах: общая дистанция горизонта ≈ 1 км
      if (d >= 900 && d <= 1_100) return 500;
      // Дальние признаки — по азимуту, без «размывания» конуса на соседей
      const az = Math.abs(wrapAngle(azimuthRad(ORIGIN, pos)));
      if (az < step / 2 && Math.abs(d - D) < 1) return 5000; // гора на 100 км
      // Плато соседей на ~160 км: выше drop (кривизна там ≈ 1.7 км),
      // иначе его угол не поднимется над плоским максимумом корзины
      if (d > 150_000 && d < 170_000) return 2000;
      return 0;
    };

    const layered = computeLayeredHorizon(ORIGIN, 0, sample, {
      azimuthStepRad: step,
    });
    // Дальний слой (100–200 км) на луче 0: только своя гора, без примеси
    // плато соседних лучей (у него разрыв дистанции >50% от 100 км)
    const expected = Math.atan(
      (5000 - 1.7 - earthDrop(D)) / D,
    );
    expect(layered.layers[4][0]).toBeCloseTo(expected, 8);
  });

  it("фронтов на луче может быть больше 32 — кап не теряет дальние", () => {
    // Регресс: жёсткий FRONT_CAP = 32 молча отбрасывал фронты сверх капа.
    // Гребни с возрастающими наклонами ставятся ровно на шаги марша —
    // каждый образует новый фронт (разрыв между ними > 2 км)
    const march = buildMarchTable(100 * 1.5, 200_000);
    const step = (1 * Math.PI) / 180; // 360 лучей — тест быстрый
    const ridges: { d: number; h: number }[] = [];
    let k = 0;
    let started = false;
    for (let s = 0; s < march.count; s++) {
      const d = march.d[s];
      if (!started && d >= 500) started = true;
      if (started && s % 10 === 0) {
        // Наклон гребня растёт с номером: каждый следующий — новый максимум
        ridges.push({ d, h: d * (0.02 + 0.001 * k) });
        k++;
      }
    }
    const ridgeByD = new Map(ridges.map((r) => [r.d, r.h]));
    const sample: SampleFn = (_pos, d) => ridgeByD.get(d) ?? 0;

    const { fronts } = computeLayeredHorizon(ORIGIN, 0, sample, {
      azimuthStepRad: step,
    });
    expect(ridges.length).toBeGreaterThan(32);
    // В ближней зоне гребни сливаются в один фронт (разрывы < 2 км — это
    // штатное поведение), поэтому проверяем не точное равенство, а то, что
    // кап не режет счётчик и самый дальний гребень дошёл до конца
    expect(fronts[0].length).toBeGreaterThan(32);
    expect(fronts[0][fronts[0].length - 1].distM).toBe(
      ridges[ridges.length - 1].d,
    );
  });

  it("horizon и layers[0] делят буфер: дубль в трансферах postMessage запрещён", () => {
    // Регресс: воркер передавал result.horizon.buffer И layers[0].buffer
    // в списке трансферов — это один и тот же ArrayBuffer (horizon ===
    // layers[0]), и postMessage падал с «ArrayBuffer at index N is a
    // duplicate of an earlier ArrayBuffer». Трансферить надо layers,
    // horizon читать из layers[0] на приёмной стороне
    const sample: SampleFn = () => 100;
    const layered = computeLayeredHorizon(ORIGIN, 0, sample, {
      maxDistM: 20_000,
      azimuthStepRad: (1 * Math.PI) / 180,
    });
    // Инвариант, который ломал прод: horizon — это ссылка на layers[0]
    const horizon = layered.layers[0];
    expect(horizon.buffer).toBe(layered.layers[0].buffer);
    // Список буферов для трансфера не должен содержать дублей
    const transfers = [
      ...layered.layers.map((a) => a.buffer),
      layered.distanceToHorizonM.buffer,
      ...layered.crests.map((a) => a.buffer),
    ];
    expect(new Set(transfers).size).toBe(transfers.length);
  });
});
