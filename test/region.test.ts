/**
 * Выбор региона под текущую точку.
 *
 * Регион задаёт список вершин: уйдя за его границы, человек получил бы
 * подписи за сотни километров отсюда. Но и дёргать предложением на каждом
 * шагу нельзя — регионы реестра перекрываются буфером в 200 км.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  suggestRegionForPosition,
  findRegionForPosition,
  loadRegions,
  resetRegionsCache,
  bboxCenter,
  inBBox,
  type RegionInfo,
  type RegionsStore,
} from '../src/ui/download';

const REGIONS: Record<string, RegionInfo> = {
  elbrus: { title_ru: 'Приэльбрусье', bbox: [41, 42, 44.5, 44.3], priority: 1 },
  'caucasus-west': { title_ru: 'Западный Кавказ', bbox: [38.5, 42.5, 42.5, 44.5], priority: 2 },
  altai: { title_ru: 'Алтай', bbox: [84, 48, 90, 52], priority: 2 },
  // Врангель: bbox через антимеридиан
  wrangel: { title_ru: 'Врангеля', bbox: [177.5, 70.5, -177.5, 72], priority: 4 },
};

const ELBRUS = { lat: 43.35, lon: 42.44 }; // в обоих кавказских регионах
const FISHT = { lat: 43.95, lon: 39.9 }; // только в Западном Кавказе
const BELUKHA = { lat: 49.8, lon: 86.59 }; // Алтай
const SEA = { lat: 10, lon: -30 }; // Атлантика: регионов нет

describe('предложение сменить регион', () => {
  it('молчит, пока активный регион содержит точку', () => {
    // Эльбрус попадает и в «Западный Кавказ», у которого приоритет ниже,
    // но менять работающий регион незачем
    expect(suggestRegionForPosition(ELBRUS, 'elbrus', REGIONS)).toBeNull();
    expect(suggestRegionForPosition(ELBRUS, 'caucasus-west', REGIONS)).toBeNull();
  });

  it('предлагает регион, когда точка ушла за границы активного', () => {
    // Фишт западнее Приэльбрусья: подписи оттуда к нему отношения не имеют
    expect(suggestRegionForPosition(FISHT, 'elbrus', REGIONS)).toBe('caucasus-west');
    expect(suggestRegionForPosition(BELUKHA, 'elbrus', REGIONS)).toBe('altai');
  });

  it('не предлагает то, что уже выбрано', () => {
    expect(suggestRegionForPosition(FISHT, 'caucasus-west', REGIONS)).toBeNull();
  });

  it('молчит там, где реестр ничего не покрывает', () => {
    // Посреди океана предлагать нечего — рельеф есть везде, вершин нет
    expect(suggestRegionForPosition(SEA, 'elbrus', REGIONS)).toBeNull();
  });

  it('работает для региона через антимеридиан', () => {
    const onWrangel = { lat: 71.2, lon: 179.5 };
    const westOfLine = { lat: 71.2, lon: -178 };
    expect(findRegionForPosition(onWrangel, REGIONS)).toBe('wrangel');
    expect(findRegionForPosition(westOfLine, REGIONS)).toBe('wrangel');
    expect(suggestRegionForPosition(onWrangel, 'elbrus', REGIONS)).toBe('wrangel');
    expect(suggestRegionForPosition(onWrangel, 'wrangel', REGIONS)).toBeNull();
  });

  it('переживает регион, которого нет в реестре', () => {
    // Ключ мог остаться от старой версии реестра в сохранённых настройках
    expect(suggestRegionForPosition(FISHT, 'нет-такого', REGIONS)).toBe('caucasus-west');
  });
});

describe('центр региона', () => {
  it('обычный bbox — середина по обеим осям', () => {
    expect(bboxCenter([41, 42, 44.5, 44.3])).toEqual({ lat: 43.15, lon: 42.75 });
  });

  it('bbox через антимеридиан не уезжает на нулевой меридиан', () => {
    // Для Врангеля (177.5…−177.5) наивная формула давала долготу 0: детальные
    // тайлы качались вокруг Гвинейского залива вместо острова
    const center = bboxCenter([177.5, 70.5, -177.5, 72]);
    expect(Math.abs(center.lon)).toBeCloseTo(180, 6);
    expect(center.lat).toBeCloseTo(71.25, 6);
    expect(inBBox(center, [177.5, 70.5, -177.5, 72])).toBe(true);
  });

  it('несимметричный переход тоже попадает внутрь', () => {
    const bbox: [number, number, number, number] = [170, 50, -170, 60];
    const center = bboxCenter(bbox);
    expect(Math.abs(center.lon)).toBeCloseTo(180, 6);
    expect(inBBox(center, bbox)).toBe(true);
  });
});

/** Хранилище реестра в памяти — вместо IndexedDB */
function memoryStore(initial?: Record<string, RegionInfo>): RegionsStore & {
  saved: () => Record<string, RegionInfo> | undefined;
} {
  let value = initial;
  return {
    save: async (regions) => {
      value = regions;
    },
    load: async () => value,
    saved: () => value,
  };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

describe('реестр регионов офлайн', () => {
  beforeEach(() => {
    resetRegionsCache();
  });

  it('складывает удачную загрузку в офлайн-хранилище', async () => {
    const store = memoryStore();
    const regions = await loadRegions({
      fetchFn: (async () => jsonResponse(REGIONS)) as unknown as typeof fetch,
      store,
    });

    expect(Object.keys(regions)).toContain('elbrus');
    expect(store.saved()).toEqual(REGIONS);
  });

  it('без сети отдаёт сохранённый реестр', async () => {
    // Иначе список регионов офлайн пуст и активный регион не сменить —
    // даже на тот, что уже лежит в хранилище целиком
    const regions = await loadRegions({
      fetchFn: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      store: memoryStore(REGIONS),
    });

    expect(Object.keys(regions).sort()).toEqual(Object.keys(REGIONS).sort());
  });

  it('без сети и без запаса отдаёт пустой реестр, а не падает', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const regions = await loadRegions({
      fetchFn: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      store: memoryStore(),
    });

    expect(regions).toEqual({});
    warn.mockRestore();
  });

  it('SPA-фолбэк с index.html вместо JSON считает за отказ', async () => {
    // Vite и Pages на 404 отдают HTML со статусом 200: разбор дал бы мусор
    const regions = await loadRegions({
      fetchFn: (async () =>
        new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
      store: memoryStore(REGIONS),
    });

    expect(regions.elbrus).toBeDefined();
  });

  it('читает реестр один раз на страницу', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(REGIONS));
    const store = memoryStore();
    const [a, b] = await Promise.all([
      loadRegions({ fetchFn: fetchFn as unknown as typeof fetch, store }),
      loadRegions({ fetchFn: fetchFn as unknown as typeof fetch, store }),
    ]);
    await loadRegions({ fetchFn: fetchFn as unknown as typeof fetch, store });

    expect(a).toBe(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
