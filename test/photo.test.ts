// @vitest-environment jsdom
/**
 * «Фото с подписями»: снимок должен показывать то же, что было на экране.
 *
 * Регресс, ради которого написан тест: холст снимка не вставлен в страницу,
 * его `clientWidth` равен нулю, и масштаб интерфейса вырождался в единицу —
 * на картинке шириной 3840 px подписи рисовались кеглем 12 px, а контуры
 * линией в 1.4 px. Плюс кадр был жёстко 16:9, хотя углы обзора считаются под
 * форму экрана: на портретном телефоне снимок кадрировал не то.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { capturePhoto, photoFilename } from '../src/ui/photo';
import type { PanoramaState, ViewState } from '../src/ui/panorama';

const STATE: PanoramaState = {
  horizon: Float32Array.from({ length: 360 }, (_, i) => 0.05 + Math.sin(i / 30) * 0.01),
  stepRad: (2 * Math.PI) / 360,
  peaks: [],
};

const VIEW: ViewState = {
  centerAzRad: 0,
  tiltRad: 0,
  fovRad: (60 * Math.PI) / 180,
  fovVRad: (45 * Math.PI) / 180,
};

/** Экранный холст заданного размера в CSS-пикселях */
function screenCanvas(cssWidth: number, cssHeight: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperties(canvas, {
    clientWidth: { value: cssWidth },
    clientHeight: { value: cssHeight },
  });
  return canvas;
}

/** Кегль каждого шрифта, который выставили при рисовании */
let fontSizes: number[] = [];
/** Толщина каждой линии */
let lineWidths: number[] = [];
/** Размер холста, на котором рисовали */
let captured: { width: number; height: number } | null = null;

beforeEach(() => {
  fontSizes = [];
  lineWidths = [];
  captured = null;

  // jsdom не умеет 2D-контекст: подменяем его записывающей заглушкой
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    const canvas = this;
    const ctx = {
      canvas,
      set font(value: string) {
        const size = Number.parseFloat(value);
        if (Number.isFinite(size)) fontSizes.push(size);
      },
      get font() {
        return '';
      },
      set lineWidth(value: number) {
        lineWidths.push(value);
      },
      get lineWidth() {
        return 0;
      },
      textAlign: 'left',
      lineJoin: 'round',
      fillStyle: '',
      strokeStyle: '',
      createLinearGradient: () => ({ addColorStop: () => {} }),
      measureText: () => ({ width: 100 }),
      fillRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      closePath: () => {},
      clip: () => {},
      stroke: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      setLineDash: () => {},
      arc: () => {},
      fill: () => {},
    };
    captured = { width: canvas.width, height: canvas.height };
    return ctx as unknown as CanvasRenderingContext2D;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob([''], { type: 'image/png' }));
  };
});

describe('снимок панорамы', () => {
  it('подписи и линии крупнее ровно во столько, во сколько крупнее кадр', async () => {
    // Экран 800 CSS-пикселей, снимок 3840 → всё должно вырасти в 4.8 раза
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(800, 450),
    });

    const expectedScale = 3840 / 800;
    // Кегль шкалы азимутов в drawOverlay — 12 CSS-пикселей
    expect(fontSizes).toContain(12 * expectedScale);
    // Толщина засечки — 3 CSS-пикселя
    expect(lineWidths).toContain(3 * expectedScale);
    // Ничего не осталось нарисованным «по одному пикселю»
    expect(Math.min(...fontSizes)).toBeGreaterThan(12);
  });

  it('кадр повторяет форму экрана, а не фиксированные 16:9', async () => {
    // Портретный телефон: 390×844
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(390, 844),
    });

    expect(captured).not.toBeNull();
    const shot = captured!;
    expect(shot.height).toBe(3840);
    expect(shot.width / shot.height).toBeCloseTo(390 / 844, 3);
  });

  it('ландшафтный экран даёт снимок той же пропорции', async () => {
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(1600, 900),
    });

    const shot = captured!;
    expect(shot.width).toBe(3840);
    expect(shot.width / shot.height).toBeCloseTo(1600 / 900, 3);
  });

  it('без экранного холста остаётся 16:9 — тесты и вызовы без источника', async () => {
    await capturePhoto(STATE, VIEW, { origin: { lat: 43.3, lon: 42.4 }, observerH: 4100 });

    const shot = captured!;
    expect(shot.width / shot.height).toBeCloseTo(16 / 9, 3);
    // Даже здесь масштаб не единица: иначе подписи снова станут микроскопическими
    expect(Math.min(...fontSizes)).toBeGreaterThan(12);
  });
});

describe('имя файла снимка', () => {
  const AT = new Date(2026, 7, 13, 22, 38);

  it('содержит место, вершину и время', () => {
    // Имя должно объяснять снимок через полгода в папке «Загрузки»
    expect(
      photoFilename(
        {
          origin: { lat: 43.3, lon: 42.4 },
          observerH: 4100,
          region: 'elbrus',
          peakName: 'Эльбрус Западный',
        },
        AT,
      ),
    ).toBe('vershiny-elbrus-zapadnyy-2026-08-13-2238.png');
  });

  it('без вершины в кадре — регион и время', () => {
    expect(
      photoFilename({ origin: { lat: 43.3, lon: 42.4 }, observerH: 4100, region: 'alps' }, AT),
    ).toBe('vershiny-alps-2026-08-13-2238.png');
  });

  it('в имени нет ничего, кроме латиницы, цифр и дефисов', () => {
    const name = photoFilename(
      {
        origin: { lat: 43.3, lon: 42.4 },
        observerH: 4100,
        region: 'кавказ/западный',
        peakName: 'Ушба (Южная) 4710 м',
      },
      AT,
    );

    // Слэш увёл бы файл в несуществующий каталог, пробелы и кириллица —
    // ломаются в облаках и на чужих файловых системах
    expect(name).toMatch(/^[a-z0-9-]+\.png$/);
    expect(name.startsWith('vershiny-')).toBe(true);
    expect(name.endsWith('-2026-08-13-2238.png')).toBe(true);
  });

  it('время дописывается с ведущими нулями и сортируется по порядку', () => {
    const early = photoFilename(
      { origin: { lat: 0, lon: 0 }, observerH: 0, region: 'alps' },
      new Date(2026, 0, 5, 7, 4),
    );
    const late = photoFilename(
      { origin: { lat: 0, lon: 0 }, observerH: 0, region: 'alps' },
      new Date(2026, 0, 5, 18, 40),
    );

    expect(early).toBe('vershiny-alps-2026-01-05-0704.png');
    expect(early < late).toBe(true);
  });
});
