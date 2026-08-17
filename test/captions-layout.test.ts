// @vitest-environment jsdom
/**
 * Плашки подписей кнопок (addCaption/layoutCaptions в main.ts) не должны
 * налезать ни друг на друга, ни на кнопки. Тест воссоздаёт типовую раскладку
 * главного экрана и проверяет непересечение геометрически — тот же критерий,
 * что проверяли вручную в браузере (скриншот с «Автоповорот экрана»,
 * налезшим на «Настройки», и «К моему положению» на кнопке «Вперёд»).
 */

import { describe, it, expect, beforeAll } from 'vitest';

// --- Минимальная копия алгоритма раскладки из main.ts (та же математика) ---

interface Cap {
  btn: { left: number; top: number; width: number; height: number };
  side: 'left' | 'right' | 'above' | 'below';
  text: string;
  w: number;
  h: number;
}

interface Placed {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pt {
  x: number;
  y: number;
}

// --- Геометрия отрезков (та же, что в main.ts) ---
function segSeg(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segIntersectsRect(a: Pt, b: Pt, r: { left: number; top: number; right: number; bottom: number }): boolean {
  if ((a.x < r.left && b.x < r.left) || (a.x > r.right && b.x > r.right) ||
      (a.y < r.top && b.y < r.top) || (a.y > r.bottom && b.y > r.bottom)) return false;
  const inside = (p: Pt) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  if (inside(a) || inside(b)) return true;
  const tl = { x: r.left, y: r.top }, tr = { x: r.right, y: r.top };
  const bl = { x: r.left, y: r.bottom }, br = { x: r.right, y: r.bottom };
  return segSeg(a, b, tl, tr) || segSeg(a, b, tr, br) || segSeg(a, b, br, bl) || segSeg(a, b, bl, tl);
}
function rectBorderPoint(rx: number, ry: number, rw: number, rh: number, tx: number, ty: number): Pt {
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx !== 0 ? rw / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? rh / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}
function circleBorderPoint(cx: number, cy: number, r: number, tx: number, ty: number): Pt {
  const dx = tx - cx, dy = ty - cy;
  const dist = Math.hypot(dx, dy);
  if (!dist) return { x: cx, y: cy };
  return { x: cx + (dx / dist) * r, y: cy + (dy / dist) * r };
}

interface LaidOut {
  placed: Placed[];
  arrows: [Pt, Pt][];
}

function layout(caps: Cap[], W: number, H: number): LaidOut {
  const placed: Placed[] = [];
  const arrows: [Pt, Pt][] = [];
  for (const c of caps) {
    const br = c.btn;
    const gap = 6;
    const cx = br.left + br.width / 2;
    const cy = br.top + br.height / 2;
    let x = 0;
    let y = 0;
    if (c.side === 'left') {
      x = br.left - gap - c.w;
      y = cy - c.h / 2;
    } else if (c.side === 'right') {
      x = br.left + br.width + gap;
      y = cy - c.h / 2;
    } else if (c.side === 'above') {
      x = cx - c.w / 2;
      y = br.top - gap - c.h;
    } else {
      x = cx - c.w / 2;
      y = br.top + br.height + gap;
    }
    x = Math.max(4, Math.min(x, W - c.w - 4));
    y = Math.max(4, Math.min(y, H - c.h - 4));
    if (c.side === 'above' || c.side === 'below') {
      // Выше/ниже чужих кнопок того же ряда: плашка шире кнопки и по центру
      // задевает соседей (навипад: центр на строке с «Вперёд»)
      let guard = 0;
      const vertHits = (ry: number): boolean => {
        const self = { top: ry, bottom: ry + c.h };
        for (const o of caps) {
          if (o === c) continue;
          const b = o.btn;
          const horiz = x < b.left + b.width && x + c.w > b.left;
          if (horiz && self.top < b.top + b.height && self.bottom > b.top) return true;
        }
        return false;
      };
      while (vertHits(y) && guard++ < 100) {
        y = c.side === 'above' ? y - 14 : y + 14;
        if (y < 4 || y + c.h > H - 4) break;
      }
    }

    const rectHits = (rx: number, ry: number): boolean => {
      const self = { left: rx, right: rx + c.w, top: ry, bottom: ry + c.h };
      const hits = (r: { left: number; right: number; top: number; bottom: number }) =>
        self.left < r.right && self.right > r.left && self.top < r.bottom && self.bottom > r.top;
      for (const o of caps) {
        if (o === c) continue;
        const b = o.btn;
        if (hits({ left: b.left, right: b.left + b.width, top: b.top, bottom: b.top + b.height }))
          return true;
      }
      return placed.some((p) => hits({ left: p.x, right: p.x + p.w, top: p.y, bottom: p.y + p.h }));
    };
    const arrowHits = (rx: number, ry: number): boolean => {
      const from = rectBorderPoint(rx, ry, c.w, c.h, cx, cy);
      const to = circleBorderPoint(cx, cy, br.width / 2, rx + c.w / 2, ry + c.h / 2);
      for (const p of placed)
        if (segIntersectsRect(from, to, { left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h }))
          return true;
      for (const o of caps) {
        if (o === c) continue;
        const b = o.btn;
        const ocx = b.left + b.width / 2, ocy = b.top + b.height / 2, orad = b.width / 2;
        const len = Math.hypot(to.x - from.x, to.y - from.y);
        if (Math.hypot(ocx - from.x, ocy - from.y) - orad < len &&
            segIntersectsRect(from, to, { left: ocx - orad, top: ocy - orad, right: ocx + orad, bottom: ocy + orad }))
          return true;
      }
      for (const [a2, b2] of arrows)
        if (segSeg(from, to, a2, b2)) return true;
      return false;
    };
    const collides = (rx: number, ry: number): boolean => rectHits(rx, ry) || arrowHits(rx, ry);
    const vertical = c.side === 'left' || c.side === 'right';
    // Ближайший сдвиг без коллизий: боковые — по вертикали, верхние/нижние —
    // по обеим осям (крест навипада: чистый сдвиг вбок задевает боковые стрелки).
    // Нет чистой позиции (портрет: четыре плашки правого края не влезают в одну
    // колонку) — берём позицию с наименьшим пересечением, а не исходную.
    let ok = false;
    let bestOverlap = Infinity;
    let bestPos: { x: number; y: number } | null = null;
    const overlapArea = (rx: number, ry: number): number => {
      const self = { left: rx, right: rx + c.w, top: ry, bottom: ry + c.h };
      let area = 0;
      const add = (r: { left: number; right: number; top: number; bottom: number }) => {
        const w = Math.min(self.right, r.right) - Math.max(self.left, r.left);
        const h = Math.min(self.bottom, r.bottom) - Math.max(self.top, r.top);
        if (w > 0 && h > 0) area += w * h;
      };
      for (const o of caps) {
        if (o === c) continue;
        add({ left: o.btn.left, right: o.btn.left + o.btn.width, top: o.btn.top, bottom: o.btn.top + o.btn.height });
      }
      for (const p of placed) add({ left: p.x, right: p.x + p.w, top: p.y, bottom: p.y + p.h });
      return area;
    };
    const consider = (tx: number, ty: number): boolean => {
      if (!collides(tx, ty)) {
        x = tx;
        y = ty;
        ok = true;
        return true;
      }
      // Грязная стрелка штрафуется сильнее любого пересечения плашки
      const score = overlapArea(tx, ty) + (arrowHits(tx, ty) ? 1e6 : 0);
      if (score < bestOverlap) {
        bestOverlap = score;
        bestPos = { x: tx, y: ty };
      }
      return false;
    };
    if (vertical) {
      for (let step = 0; step <= 40 && !ok; step++) {
        for (const dir of step === 0 ? [1] : [1, -1]) {
          const v = y + dir * step * 14;
          if (v < 4 || v > H - c.h - 4) continue;
          if (consider(x, v)) break;
        }
      }
    } else {
      for (let radius = 0; radius <= 60 && !ok; radius++) {
        for (let dx = -radius; dx <= radius && !ok; dx++) {
          for (const dy of [-radius, radius]) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const tx = x + dx * 14;
            const ty = y + dy * 14;
            if (tx < 4 || tx > W - c.w - 4 || ty < 4 || ty > H - c.h - 4) continue;
            if (consider(tx, ty)) break;
          }
        }
      }
    }
    if (!ok && bestPos) {
      x = (bestPos as { x: number; y: number }).x;
      y = (bestPos as { x: number; y: number }).y;
    }
    placed.push({ text: c.text, x, y, w: c.w, h: c.h });
    const from = rectBorderPoint(x, y, c.w, c.h, cx, cy);
    const to = circleBorderPoint(cx, cy, br.width / 2, x + c.w / 2, y + c.h / 2);
    arrows.push([from, to]);
  }
  return { placed, arrows };
}

// --- Проверки ---

/** Типовой набор кнопок главного экрана телефона в ландшафте 800×360 */
function typicalCaps(): Cap[] {
  const sz = 44; // кнопка 44×44 (телефон)
  const mk = (left: number, top: number) => ({ left, top, width: sz, height: sz });
  const text = (t: string) => ({ text: t, w: t.length * 6 + 16, h: 18 });
  return [
    { btn: mk(12, 12), side: 'right', ...text('Настройки') },
    { btn: mk(68, 12), side: 'right', ...text('Автоповорот экрана') }, // было налезание на «Настройки»
    { btn: mk(12, 300), side: 'above', ...text('Карта') },
    { btn: mk(124, 258), side: 'left', ...text('К моему положению') }, // центр креста — плашка левее навипада
    { btn: mk(240, 246), side: 'right', ...text('Выше на 100 м') },
    { btn: mk(240, 310), side: 'right', ...text('Ниже на 100 м') },
    { btn: mk(744, 12), side: 'left', ...text('Скачать регион для офлайна') },
    { btn: mk(744, 190), side: 'left', ...text('Сохранить фото с подписями') },
    { btn: mk(744, 300), side: 'left', ...text('Включить камеру') },
    // кнопка навипада без подписи — но плашки не должны её задевать
    { btn: mk(124, 204), side: 'above', w: 0, h: 0, text: '' },
    // ...и соседние стрелки навипада: «К моему положению» налезала на «Вперёд»
    { btn: mk(124, 150), side: 'above', w: 0, h: 0, text: '' }, // «Вперёд»
    { btn: mk(70, 204), side: 'above', w: 0, h: 0, text: '' }, // «Влево»
    { btn: mk(178, 204), side: 'above', w: 0, h: 0, text: '' }, // «Вправо»
    { btn: mk(124, 312), side: 'above', w: 0, h: 0, text: '' }, // «Назад»
  ];
}

/**
 * Реальная геометрия телефона в ландшафте: плашка «К моему положению»
 * (центр навипада) окружена стрелками со всех сторон — сдвигом по одной
 * оси из креста не выйти, поэтому выход ищем диагонально.
 */

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

describe('раскладка плашек подписей', () => {
  let laid: LaidOut;
  let placed: Placed[];
  let arrows: [Pt, Pt][];
  const caps = typicalCaps();
  const W = 800;
  const H = 360;

  beforeAll(() => {
    laid = layout(caps.filter((c) => c.text), W, H);
    placed = laid.placed;
    arrows = laid.arrows;
  });

  it('плашки не налезают друг на друга', () => {
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        expect(
          overlaps(placed[i], placed[j]),
          `${placed[i].text} × ${placed[j].text}`,
        ).toBe(false);
      }
  });

  it('плашки не налезают на ЧУЖИЕ кнопки (включая без подписей)', () => {
    for (const p of placed) {
      const own = caps.find((c) => c.text === p.text)!.btn;
      for (const b of caps.map((c) => c.btn)) {
        if (b === own) continue;
        expect(
          overlaps(p, { x: b.left, y: b.top, w: b.width, h: b.height }),
          `${p.text} на чужой кнопке`,
        ).toBe(false);
      }
    }
  });

  it('плашки в пределах экрана', () => {
    for (const p of placed) {
      expect(p.x, p.text).toBeGreaterThanOrEqual(0);
      expect(p.y, p.text).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w, p.text).toBeLessThanOrEqual(W);
      expect(p.y + p.h, p.text).toBeLessThanOrEqual(H);
    }
  });

  it('каждая плашка на своей стороне кнопки (стрелка короткая)', () => {
    for (const p of placed) {
      const cap = caps.find((c) => c.text === p.text && c.text !== '')!;
      const b = cap.btn;
      if (cap.side === 'right') expect(p.x, p.text).toBeGreaterThanOrEqual(b.left + b.width);
      if (cap.side === 'left') expect(p.x + p.w, p.text).toBeLessThanOrEqual(b.left);
      if (cap.side === 'above') expect(p.y + p.h, p.text).toBeLessThanOrEqual(b.top);
      if (cap.side === 'below') expect(p.y, p.text).toBeGreaterThanOrEqual(b.top + b.height);
    }
  });

  it('стрелки не режут чужие плашки', () => {
    placed.forEach((p, i) => {
      const [a, b] = arrows[i];
      placed.forEach((q, j) => {
        if (i === j) return; // своя плашка — начало стрелки
        expect(
          segIntersectsRect(a, b, { left: q.x, top: q.y, right: q.x + q.w, bottom: q.y + q.h }),
          `стрелка «${p.text}» режет плашку «${q.text}»`,
        ).toBe(false);
      });
    });
  });

  it('стрелки не режут чужие кнопки', () => {
    const textCaps = caps.filter((c) => c.text);
    placed.forEach((p, i) => {
      const own = textCaps[i].btn;
      const [a, b] = arrows[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (const btn of caps.map((c) => c.btn)) {
        if (btn === own) continue;
        const ocx = btn.left + btn.width / 2, ocy = btn.top + btn.height / 2, orad = btn.width / 2;
        if (Math.hypot(ocx - a.x, ocy - a.y) - orad >= len) continue; // кнопка дальше конца стрелки
        expect(
          segIntersectsRect(a, b, { left: ocx - orad, top: ocy - orad, right: ocx + orad, bottom: ocy + orad }),
          `стрелка «${p.text}» режет чужую кнопку`,
        ).toBe(false);
      }
    });
  });

  it('стрелки не пересекаются между собой', () => {
    for (let i = 0; i < arrows.length; i++)
      for (let j = i + 1; j < arrows.length; j++) {
        expect(
          segSeg(arrows[i][0], arrows[i][1], arrows[j][0], arrows[j][1]),
          `стрелка «${placed[i].text}» × стрелка «${placed[j].text}»`,
        ).toBe(false);
      }
  });
});

/**
 * Портрет смартфона 390×844 — геометрия со скриншота пользователя.
 * Кнопки правого края (скачать, калибровка, фото, камера) берут подпись
 * ВЛЕВО; на узком экране плашка упирается в левый край, и четырём длинным
 * плашкам не хватает одной колонки — раньше они наезжали друг на друга
 * («Сохранить фото с подписями» × «Ниже на 100 м» и т.п.). Здесь критерий
 * мягче: непересечение гарантировать нельзя, поэтому проверяем, что
 * перекрытие минимально (fallback «наименьшее пересечение»), а не половина
 * плашки.
 */
function portraitCaps(): Cap[] {
  const sz = 48;
  const mk = (left: number, top: number) => ({ left, top, width: sz, height: sz });
  const text = (t: string) => ({ text: t, w: t.length * 6 + 16, h: 18 });
  return [
    { btn: mk(12, 12), side: 'right', ...text('Настройки') },
    { btn: mk(68, 12), side: 'right', ...text('Поворот экрана') },
    { btn: mk(330, 12), side: 'left', ...text('Скачать регион для офлайна') },
    { btn: mk(330, 100), side: 'left', ...text('Совместить вершины с камерой') },
    { btn: mk(330, 640), side: 'left', ...text('Сохранить фото с подписями') },
    { btn: mk(330, 720), side: 'left', ...text('Включить камеру') },
    { btn: mk(12, 780), side: 'above', ...text('Карта') },
    // навипад (без подписей) — плашки не должны резать его стрелки
    { btn: mk(90, 700), side: 'above', w: 0, h: 0, text: '' },
    { btn: mk(150, 760), side: 'above', w: 0, h: 0, text: '' },
    { btn: mk(90, 820), side: 'above', w: 0, h: 0, text: '' },
    // стрелки высоты — их подписи справа от кнопок
    { btn: mk(240, 700), side: 'right', ...text('Выше на 100 м') },
    { btn: mk(240, 780), side: 'right', ...text('Ниже на 100 м') },
  ];
}

describe('раскладка плашек в портрете (узкий экран)', () => {
  const caps = portraitCaps();
  const W = 390;
  const H = 844;
  const { placed, arrows } = layout(caps.filter((c) => c.text), W, H);

  it('плашки в пределах экрана', () => {
    for (const p of placed) {
      expect(p.x, p.text).toBeGreaterThanOrEqual(0);
      expect(p.y, p.text).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w, p.text).toBeLessThanOrEqual(W);
      expect(p.y + p.h, p.text).toBeLessThanOrEqual(H);
    }
  });

  it('плашки не налезают друг на друга', () => {
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(
          w > 0 && h > 0,
          `«${a.text}» × «${b.text}» пересекаются на ${w}x${h}`,
        ).toBe(false);
      }
  });

  it('стрелки не режут чужие плашки', () => {
    placed.forEach((p, i) => {
      const [a, b] = arrows[i];
      placed.forEach((q, j) => {
        if (i === j) return;
        expect(
          segIntersectsRect(a, b, { left: q.x, top: q.y, right: q.x + q.w, bottom: q.y + q.h }),
          `стрелка «${p.text}» режет плашку «${q.text}»`,
        ).toBe(false);
      });
    });
  });
});
