/**
 * Поиск вершины по названию.
 *
 * Три источника, от дешёвого к дорогому:
 *   1. текущий регион — он уже в памяти;
 *   2. скачанные регионы — IndexedDB, работает офлайн;
 *   3. глобальный индекс `peaks/_index.json` — по 250 самых значимых вершин
 *      каждого региона (tools/peaks-index). Без него Казбек или Монблан из
 *      Приэльбрусья не находились вовсе, а качать ради поиска все 115
 *      регионов (58 МБ) нельзя.
 *
 * Сравнение — по нормализованным именам: обе строки приводятся к латинице
 * (src/core/transliterate.ts), поэтому «Казбек» находит «Kazbek», а «Ushba» —
 * «Ушба». Экзонимы («Монблан» ≠ «Mont Blanc») так не берутся: это уже вопрос
 * полноты name:ru в OSM, а не поиска.
 *
 * Возвращается список: одинаковые названия встречаются сплошь и рядом (в одних
 * Альпах несколько «Ostspitze»), да и регионы реестра перекрываются — выбор
 * оставляем человеку, показывая регион каждого варианта.
 */

import type { Peak } from './peaks';
import { translitToLatin } from './transliterate';

/** Запись индекса: [имя, lat, lon, ele, регион, имя_en?, имя_ru?] */
export type IndexEntry = [
  string,
  number,
  number,
  number | null,
  string,
  string?,
  string?,
];

export interface IndexFile {
  generated: string;
  peaks: IndexEntry[];
}

export interface SearchHit {
  peak: Peak;
  region: string;
  /** Полное совпадение названия (а не вхождение подстроки) */
  exact: boolean;
}

/** Сколько вариантов показывать при неоднозначном запросе */
export const SEARCH_RESULT_LIMIT = 12;

/** Имя → сравнимая форма: латиница, нижний регистр, только буквы и цифры */
export function normalizeName(name: string): string {
  return translitToLatin(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Качество совпадения: true — точное, false — вхождение, null — мимо.
 */
function matchQuality(names: (string | undefined)[], q: string): boolean | null {
  let partial = false;
  for (const name of names) {
    if (!name) continue;
    const normalized = normalizeName(name);
    if (normalized === q) return true;
    if (normalized.includes(q)) partial = true;
  }
  return partial ? false : null;
}

/** Поиск в списке вершин одного региона */
export function searchPeaks(query: string, peaks: Peak[], region: string): SearchHit[] {
  const q = normalizeName(query);
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const peak of peaks) {
    const exact = matchQuality([peak.name, peak.name_ru, peak.name_en], q);
    if (exact !== null) hits.push({ peak, region, exact });
  }
  return hits;
}

/** Запись индекса → Peak */
function entryToPeak(entry: IndexEntry): Peak {
  const [name, lat, lon, ele, , nameEn, nameRu] = entry;
  return {
    name,
    lat,
    lon,
    ...(ele !== null && ele !== undefined ? { ele } : {}),
    ...(nameEn ? { name_en: nameEn } : {}),
    ...(nameRu ? { name_ru: nameRu } : {}),
  };
}

/** Поиск в глобальном индексе */
export function searchIndex(query: string, entries: IndexEntry[]): SearchHit[] {
  const q = normalizeName(query);
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const exact = matchQuality([entry[0], entry[5], entry[6]], q);
    if (exact !== null) hits.push({ peak: entryToPeak(entry), region: entry[4], exact });
  }
  return hits;
}

/** Ключ дедупликации: регионы реестра перекрываются, вершины в них дублируются */
function hitKey(hit: SearchHit): string {
  return `${hit.peak.lat.toFixed(3)},${hit.peak.lon.toFixed(3)}`;
}

/** Насколько «тот самый» результат: высота, точность совпадения, близость */
function hitScore(hit: SearchHit, origin?: { lat: number; lon: number }): number {
  const ele = hit.peak.ele ?? 0;
  let score = ele * (hit.exact ? 2 : 1);
  if (origin) {
    // Мягкий бонус за близость: ищут обычно то, что рядом. Масштаб большой
    // (500 км), иначе он перевесил бы высоту внутри одного горного узла.
    const dLat = (hit.peak.lat - origin.lat) * 111.32;
    const dLon = (hit.peak.lon - origin.lon) * 111.32 * Math.cos((origin.lat * Math.PI) / 180);
    score *= 1 + 0.5 * Math.exp(-Math.hypot(dLat, dLon) / 500);
  }
  return score;
}

/**
 * Слияние результатов и ранжирование.
 *
 * Точное совпадение удваивает вес, но не решает исход: на запрос «Казбек»
 * одноимённая сопка 1060 м на Колыме совпадает точно, а настоящий Казбек
 * (5054 м) назван «მყინვარწვერი - Казбек» и совпадает лишь частично —
 * первым должен идти всё-таки настоящий.
 *
 * Дубли одной вершины из перекрывающихся регионов схлопываются; побеждает
 * источник, пришедший раньше (текущий регион приоритетнее индекса).
 */
export function mergeHits(
  groups: SearchHit[][],
  origin?: { lat: number; lon: number },
  limit = SEARCH_RESULT_LIMIT,
): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const group of groups) {
    for (const hit of group) {
      const key = hitKey(hit);
      const kept = seen.get(key);
      // Уже найденную вершину заменяем, только если новая совпала точнее
      if (!kept || (!kept.exact && hit.exact)) seen.set(key, hit);
    }
  }
  return [...seen.values()]
    .sort((a, b) => hitScore(b, origin) - hitScore(a, origin))
    .slice(0, limit);
}

let indexCache: IndexEntry[] | null = null;

/** Загрузка глобального индекса (один раз за сессию; дальше — кеш SW) */
export async function loadSearchIndex(
  base: string,
  fetchFn: typeof fetch = fetch.bind(globalThis),
): Promise<IndexEntry[]> {
  if (indexCache) return indexCache;
  try {
    const res = await fetchFn(`${base}peaks/_index.json`);
    // Vite на 404 отдаёт index.html с HTTP 200 — проверяем тип
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
      return [];
    }
    indexCache = ((await res.json()) as IndexFile).peaks ?? [];
    return indexCache;
  } catch {
    return []; // офлайн и индекс не в кеше — ищем только по своим регионам
  }
}
