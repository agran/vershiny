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
import {
  setPhotoCaption,
  DEFAULT_PHOTO_CAPTION,
  type PhotoCaption,
} from '../src/core/photo-caption';
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
/** Всё, что нарисовали текстом: содержимое и место */
let draws: { text: string; x: number; y: number; align: string }[] = [];
/** Заливки прямоугольников (плашки) — их на снимке быть не должно */
let fillRects: { x: number; y: number; w: number; h: number }[] = [];
/** Размер холста, на котором рисовали */
let captured: { width: number; height: number } | null = null;

/** Ширина текста, как её вернула бы заглушка холста (моноширинное приближение) */
const textWidth = (text: string, fontSize: number): number => text.length * fontSize * 0.5;

beforeEach(() => {
  fontSizes = [];
  lineWidths = [];
  draws = [];
  fillRects = [];
  captured = null;
  // Состав подписи живёт в localStorage: без сброса выбор одного теста
  // протекал бы в следующий
  setPhotoCaption(DEFAULT_PHOTO_CAPTION);

  // jsdom не умеет 2D-контекст: подменяем его записывающей заглушкой
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    const canvas = this;
    let fontSize = 10;
    const ctx = {
      canvas,
      set font(value: string) {
        const size = Number.parseFloat(value);
        if (Number.isFinite(size)) {
          fontSize = size;
          fontSizes.push(size);
        }
      },
      get font() {
        return `${fontSize}px`;
      },
      set lineWidth(value: number) {
        lineWidths.push(value);
      },
      get lineWidth() {
        return 0;
      },
      textAlign: 'left',
      textBaseline: 'alphabetic',
      miterLimit: 10,
      lineJoin: 'round',
      fillStyle: '',
      strokeStyle: '',
      createLinearGradient: () => ({ addColorStop: () => {} }),
      // Ширина зависит от текста и кегля: с фиксированным числом не проверить
      // ни перенос длинной строки, ни то, что подпись влезла в кадр
      measureText: (text: string) => ({ width: textWidth(text, fontSize) }),
      fillRect: (x: number, y: number, w: number, h: number) =>
        fillRects.push({ x, y, w, h }),
      fillText: (text: string, x: number, y: number) =>
        draws.push({ text, x, y, align: ctx.textAlign }),
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
    // Контуры включены явно: по умолчанию на снимке их нет (см. ниже)
    setPhotoCaption({ ridges: true });
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

  it('снимок из AR: по умолчанию контуров и шкалы нет, только подписи', async () => {
    // Настройка сброшена в beforeEach: ridges = false. В AR кадр содержит
    // настоящие горы, и нарисованный силуэт конфликтовал бы с ними
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(800, 450),
      fromCamera: true,
    });

    const expectedScale = 3840 / 800;
    // Шкала азимутов (кегль 12) и засечки (толщина 3) не рисовались
    expect(fontSizes).not.toContain(12 * expectedScale);
    expect(lineWidths).not.toContain(3 * expectedScale);
    // Подпись снимка (кегль 13) на месте — кадр не пустой
    expect(fontSizes).toContain(13 * expectedScale);
  });

  it('снимок без камеры: контуры рисуются при любом положении переключателя', async () => {
    // ridges = false (сброшено в beforeEach), но конфликтовать силуэту не с
    // чем — настройка действует только на кадр с камерой
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(800, 450),
    });

    const expectedScale = 3840 / 800;
    expect(fontSizes).toContain(12 * expectedScale); // шкала азимутов
    expect(lineWidths).toContain(3 * expectedScale); // засечки
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

  it('подписи в углах снимка не мельче подписей вершин', async () => {
    // Метаданные и адрес сайта рисовались кеглем 7 и 6 CSS-пикселей — вдвое
    // мельче всего остального в кадре. На снимке 4K это превращалось в еле
    // различимую полоску, хотя именно она отвечает «откуда снято»
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(800, 450),
    });

    const scale = 3840 / 800;
    expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(12 * scale);
  });

  it('вытесненные подписи не превращаются в «+N»', async () => {
    // Счётчик «+N» рядом с подписью не сообщал ничего: какая именно вершина
    // за ним стоит — не узнать, а место в кадре он занимал
    // Имена латиницей: подписи проходят через транслитерацию под локаль,
    // и кириллица сделала бы тест зависимым от языка окружения
    const crowd: PanoramaState = {
      ...STATE,
      peaks: [
        { name: 'Alpha', lat: 43.3, lon: 42.4, ele: 5000, azimuthRad: 0.02,
          elevationRad: 0.05, distanceM: 4000, visibility: 'visible' },
        { name: 'Beta', lat: 43.3, lon: 42.4, ele: 4900, azimuthRad: 0.021,
          elevationRad: 0.05, distanceM: 4100, visibility: 'visible' },
        { name: 'Gamma', lat: 43.3, lon: 42.4, ele: 4800, azimuthRad: 0.022,
          elevationRad: 0.05, distanceM: 4200, visibility: 'visible' },
      ],
    };

    await capturePhoto(crowd, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(800, 450),
    });

    // Место нашлось не всем — иначе тест ничего не проверяет
    expect(draws.some((d) => d.text.startsWith('Alpha'))).toBe(true);
    expect(draws.some((d) => d.text.startsWith('Gamma'))).toBe(false);
    expect(draws.filter((d) => d.text.includes('+'))).toEqual([]);
  });

  /**
   * Строки подписи снимка: всё, что нарисовано текстом, кроме шкалы азимутов
   * («N 0°», «NE 45°») и самого адреса сайта
   */
  const captionLines = (): typeof draws =>
    draws.filter((d) => !/^\S+ \d+°$/.test(d.text) && !d.text.includes('agran.github.io'));
  const siteLine = (): (typeof draws)[number] =>
    draws.find((d) => d.text.includes('agran.github.io'))!;

  it('подпись и адрес стоят на одной нижней строке', async () => {
    // Адрес рисовался отдельным блоком НАД координатами и оказывался тем
    // дальше от нижнего края, чем выше была плашка координат
    setPhotoCaption({ place: true, time: true });
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      region: 'elbrus',
      source: screenCanvas(1600, 900),
    });

    const lines = captionLines();
    expect(lines).toHaveLength(1); // широкий кадр — всё влезает в строку
    expect(siteLine().y).toBe(lines[0].y);
  });

  it('подписи рисуются обводкой, без прямоугольной подложки', async () => {
    // Плашка выглядела наклейкой поверх кадра и на светлом небе рвала его
    // тёмным квадратом. Обводка читается на любом фоне и ничего не закрывает
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      source: screenCanvas(1600, 900),
    });

    // Заливка неба на весь кадр законна — а вот плашек под текстом быть не должно
    const shot = captured!;
    const plates = fillRects.filter(
      (r) => !(r.x === 0 && r.y === 0 && r.w === shot.width && r.h === shot.height),
    );
    expect(plates).toEqual([]);
  });

  it('в портретном кадре длинная подпись переносится и влезает по ширине', async () => {
    // Портретный телефон: кадр вдвое уже, и строка с координатами, высотой и
    // датой уходила за правый край вместе с адресом сайта
    setPhotoCaption({ place: true, time: true });
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      region: 'elbrus',
      source: screenCanvas(390, 844),
    });

    const width = captured!.width;
    const lines = captionLines();
    expect(lines.length).toBeGreaterThan(1); // перенесли, а не обрезали

    const scale = width / 390;
    for (const line of lines) {
      // Слева направо от отступа: правый край строки обязан остаться в кадре
      expect(line.x + textWidth(line.text, 13 * scale)).toBeLessThan(width);
    }
    // Адрес выровнен по правому краю и тоже не вылезает
    const site = siteLine();
    expect(site.align).toBe('right');
    expect(site.x).toBeLessThan(width);
    expect(site.x - textWidth(site.text, 13 * scale)).toBeGreaterThan(0);
    // И по-прежнему на одной строке с последней строкой координат
    expect(site.y).toBe(lines[lines.length - 1].y);
  });

  /** Снимок с заданным составом подписи; возвращает её строки */
  const captionWith = async (caption: Partial<PhotoCaption>): Promise<string[]> => {
    setPhotoCaption(caption);
    draws = []; // иначе в выборку попадут строки предыдущего снимка
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      region: 'elbrus',
      source: screenCanvas(1600, 900),
    });
    return captionLines().map((d) => d.text);
  };

  it('по умолчанию снимок не подписан ничем, кроме адреса сайта', async () => {
    // Снимком делятся, а координаты с точностью до метра и время съёмки —
    // данные о человеке, а не о горах
    await capturePhoto(STATE, VIEW, {
      origin: { lat: 43.3, lon: 42.4 },
      observerH: 4100,
      region: 'elbrus',
      source: screenCanvas(1600, 900),
    });

    expect(captionLines()).toEqual([]);
    expect(siteLine()).toBeDefined(); // авторство остаётся
  });

  it('место и время включаются в настройках по отдельности', async () => {
    const place = (await captionWith({ place: true, time: false })).join(' ');
    expect(place).toContain('43.3°N');
    expect(place).toContain('42.4°E');
    expect(place).toContain('4100'); // высота наблюдателя
    expect(place).toContain('elbrus'); // район съёмки
    expect(place).not.toMatch(/\d{1,2}:\d{2}/); // времени съёмки нет

    const time = (await captionWith({ place: false, time: true })).join(' ');
    expect(time).toMatch(/\d{1,2}:\d{2}/); // время есть
    expect(time).not.toContain('°N');
    expect(time).not.toContain('elbrus');
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
