import { describe, expect, it } from 'vitest';
import {
  decodeTerrarium,
  lonLatToPixel,
  lonLatToTile,
  zoomForDistance,
  TerrariumSampler,
} from '../src/core/terrarium';

describe('terrarium', () => {
  it('slippy-конверсия: Эльбрус z15 → x=20246 y=11996', () => {
    const t = lonLatToTile({ lat: 43.35, lon: 42.44 }, 15);
    expect(t).toEqual({ x: 20246, y: 11996 });
  });

  it('slippy-конверсия: углы карты z0 → единственный тайл', () => {
    expect(lonLatToTile({ lat: 0, lon: 0 }, 0)).toEqual({ x: 0, y: 0 });
    expect(lonLatToTile({ lat: 85, lon: 179.9 }, 1)).toEqual({ x: 1, y: 0 });
    expect(lonLatToTile({ lat: -85, lon: -179.9 }, 1)).toEqual({ x: 0, y: 1 });
  });

  it('декодирование: h = R·256 + G + B/256 − 32768', () => {
    // 5642 м: 5642 + 32768 = 38410 = 150·256 + 10 + 0/256
    expect(decodeTerrarium(150, 10, 0)).toBeCloseTo(5642, 6);
    // Дробная часть: 0.5 м = 128/256
    expect(decodeTerrarium(150, 10, 128)).toBeCloseTo(5642.5, 6);
    // Мёртвое море −430 м: −430 + 32768 = 32338 = 126·256 + 82
    expect(decodeTerrarium(126, 82, 2)).toBeCloseTo(-430 + 2 / 256, 6);
  });

  it('выбор зума по дальности', () => {
    expect(zoomForDistance(1_000)).toBe(12);
    expect(zoomForDistance(5_000)).toBe(11);
    expect(zoomForDistance(30_000)).toBe(10);
    expect(zoomForDistance(150_000)).toBe(9);
  });

  it('пиксельная позиция в пределах тайла', () => {
    const { px, py } = lonLatToPixel({ lat: 43.35, lon: 42.44 }, 15);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThan(256);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(py).toBeLessThan(256);
  });

  it('офлайновый 503 не роняет загрузку тайла', async () => {
    // Service Worker без сети отвечает 503 на всё, чего нет в кеше:
    // это «сейчас нет данных», а не повод прервать расчёт панорамы
    const fetchFn = (async () =>
      new Response('Offline', { status: 503 })) as unknown as typeof fetch;
    const sampler = new TerrariumSampler({ fetchFn });

    await expect(sampler.loadTile(12, 100, 100)).resolves.toBeNull();
  });

  it('обрыв соединения не залипает в pending навсегда', async () => {
    // Отклонённый промис оставался в карте параллельных запросов, и каждый
    // следующий расчёт панорамы падал на нём же — даже когда сеть вернулась
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const sampler = new TerrariumSampler({ fetchFn });

    await expect(sampler.loadTile(12, 100, 100)).resolves.toBeNull();
    // Второй запрос уходит в сеть заново, а не получает старый отказ
    await expect(sampler.loadTile(12, 100, 100)).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it('интерполяция продолжается в соседний тайл, а не упирается в край', () => {
    // Раньше индексы зажимались внутрь своего тайла: на каждом стыке
    // дублировался краевой пиксель — шов шириной до ячейки (38–150 м)
    const zoom = 12;
    const pos = { lat: 43.35, lon: 42.44 };
    const { x, y } = lonLatToTile(pos, zoom);

    // Свой тайл — ровное плато 1000 м, восточный сосед — 2000 м
    const flat = (h: number): Int16Array => {
      const t = new Int16Array(256 * 256);
      t.fill(h);
      return t;
    };
    const sampler = new TerrariumSampler();
    const tiles = (sampler as unknown as { tiles: Map<string, Int16Array> }).tiles;
    tiles.set(`${zoom}/${x}/${y}`, flat(1000));
    tiles.set(`${zoom}/${x + 1}/${y}`, flat(2000));

    // Точка на последнем пикселе своего тайла: половина веса приходится на
    // соседний, значит высота обязана уехать вверх от 1000
    const edge = {
      ...pos,
      lon: ((x + 1) / 2 ** zoom) * 360 - 180 - 0.5 * (360 / (2 ** zoom * 256)),
    };
    const h = sampler.sample(edge, zoom);
    expect(h).toBeGreaterThan(1000);
    expect(h).toBeLessThanOrEqual(2000);

    // Без соседа поведение прежнее: край повторяется, а не даёт NaN
    tiles.delete(`${zoom}/${x + 1}/${y}`);
    expect(sampler.sample(edge, zoom)).toBeCloseTo(1000, 6);
  });

  it('тайл за антимеридианом заворачивается, а не зажимается в край', () => {
    // `destination` от Врангеля уходит за 180° сразу; раньше индекс тайла
    // зажимался в нулевой — с другого края планеты, — и рельефа не было ни
    // из Terrarium, ни из пирамиды: половина панорамы оставалась пустой
    const zoom = 12;
    const n = 2 ** zoom;
    const raw = lonLatToTile({ lat: 71.2, lon: -180.837 }, zoom);
    const same = lonLatToTile({ lat: 71.2, lon: 179.163 }, zoom);
    expect(raw).toEqual(same);
    expect(raw.x).toBe(n - 10);

    // Пиксель внутри тайла обязан остаться положительным: отрицательный
    // уводил интерполяцию в незагруженный тайл на другом краю мира
    const { px } = lonLatToPixel({ lat: 71.2, lon: -180.837 }, zoom);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThan(256);
    expect(px).toBeCloseTo(lonLatToPixel({ lat: 71.2, lon: 179.163 }, zoom).px, 6);
  });

  it('prefetchAround берёт окрестность 3×3 и заворачивает её по долготе', async () => {
    // Веер лучей ближнюю зону не покрывает: на первых километрах все 3600
    // лучей лежат в одном-двух тайлах, а сетка предзагрузки (5°, 8 км) туда
    // не попадает — до двух третей ближних выборок шли мимо загруженного
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(String(url).split('/terrarium/')[1]);
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const sampler = new TerrariumSampler({ fetchFn });

    await sampler.prefetchAround({ lat: 71.2, lon: -179.99 }, 4);
    expect(asked).toHaveLength(9);
    // Западный сосед лежит за антимеридианом — это последний тайл мира
    expect(asked).toContain('4/15/3.png');
    expect(asked).toContain('4/0/3.png');
  });

  it('heightAt на шве ±180° подгружает тайл 0 как правого соседа', async () => {
    // Правый сосед последнего тайла мира (x = n−1) лежит за антимеридианом.
    // Раньше условие `x + 1 < n` его не грузило, и интерполяция на шве молча
    // откатывалась на краевой пиксель вместо честного соседа из тайла 0
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(String(url).split('/terrarium/')[1]);
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const sampler = new TerrariumSampler({ fetchFn });

    // z12: ширина тайла 360/4096 ≈ 0.088°; lon 179.9999 — последние сотые
    // долей градуса тайла x=4095, пиксель px > 254.5 → нужен правый сосед.
    // 404 → loadTile отдаёт null → heightAt бросает «вне покрытия» — это
    // ожидаемо, проверяем именно набор запрошенных тайлов
    const pos = { lat: 43.35, lon: 179.9999 };
    await expect(sampler.heightAt(pos)).rejects.toThrow();
    const y = lonLatToTile(pos, 12).y;
    expect(asked).toContain(`12/4095/${y}.png`);
    expect(asked).toContain(`12/0/${y}.png`);
  });

  it('prefetchAround не выходит за полюс', async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(String(url));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const sampler = new TerrariumSampler({ fetchFn });

    // Верхний ряд тайлов: соседей выше нет, по широте мир не замкнут
    await sampler.prefetchAround({ lat: 85, lon: 0 }, 4);
    expect(asked).toHaveLength(6);
  });

  it('saveTileOffline отличает отказ от законной дыры покрытия', async () => {
    // `loadTile` любой отказ превращает в null — это верно для расчёта
    // панорамы, но загрузка региона считала успехом и 503 офлайнового
    // Service Worker'а: регион помечался скачанным, а в горах был пуст
    const answer = (status: number) =>
      (async () => new Response('x', { status })) as unknown as typeof fetch;

    // Без IndexedDB сохранять некуда — это отказ, а не успех
    expect(
      await new TerrariumSampler({ fetchFn: answer(200) }).saveTileOffline(12, 1, 1),
    ).toBe('failed');
    expect(
      await new TerrariumSampler({ fetchFn: answer(503) }).saveTileOffline(12, 1, 1),
    ).toBe('failed');
    expect(
      await new TerrariumSampler({ fetchFn: answer(404) }).saveTileOffline(12, 1, 1),
    ).toBe('missing');
  });
});
