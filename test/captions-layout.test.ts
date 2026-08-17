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

function layout(caps: Cap[], W: number, H: number): Placed[] {
  const placed: Placed[] = [];
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

    const vertical = c.side === 'left' || c.side === 'right';
    const collides = (rx: number, ry: number): boolean => {
      const self = { left: rx, right: rx + c.w, top: ry, bottom: ry + c.h };
      const hits = (r: { left: number; right: number; top: number; bottom: number }) =>
        self.left < r.right && self.right > r.left && self.top < r.bottom && self.bottom > r.top;
      // Своя кнопка не считается: плашка может касаться её зазором, но не пересекать
      for (const o of caps) {
        if (o === c) continue;
        const b = o.btn;
        if (
          hits({ left: b.left, right: b.left + b.width, top: b.top, bottom: b.top + b.height })
        )
          return true;
      }
      return placed.some((p) =>
        hits({ left: p.x, right: p.x + p.w, top: p.y, bottom: p.y + p.h }),
      );
    };
    // Ближайший сдвиг без коллизий: боковые — по вертикали, верхние/нижние —
    // по обеим осям (крест навипада: чистый сдвиг вбок задевает боковые стрелки)
    let ok = false;
    if (vertical) {
      for (let step = 0; step <= 40 && !ok; step++) {
        for (const dir of step === 0 ? [1] : [1, -1]) {
          const v = y + dir * step * 14;
          if (v < 4 || v > H - c.h - 4) continue;
          if (!collides(x, v)) {
            y = v;
            ok = true;
            break;
          }
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
            if (!collides(tx, ty)) {
              x = tx;
              y = ty;
              ok = true;
              break;
            }
          }
        }
      }
    }
    placed.push({ text: c.text, x, y, w: c.w, h: c.h });
  }
  return placed;
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
  let placed: Placed[];
  const caps = typicalCaps();
  const W = 800;
  const H = 360;

  beforeAll(() => {
    placed = layout(caps.filter((c) => c.text), W, H);
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
});
