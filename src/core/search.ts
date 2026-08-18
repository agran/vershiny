/**
 * Поиск вершины по названию.
 *
 * Три источника, от дешёвого к дорогому:
 *   1. текущий регион — он уже в памяти;
 *   2. скачанные регионы — IndexedDB, работает офлайн и знает их целиком
 *      (тысячи вершин против 400 в индексе);
 *   3. глобальный индекс `peaks/_index.json` — по 400 значимых вершин
 *      каждого региона (tools/peaks-index). Без него Казбек или Монблан из
 *      Приэльбрусья не находились вовсе, а качать ради поиска все 115
 *      регионов (58 МБ) нельзя.
 *
 * Сравнение — по нормализованным именам: обе строки приводятся к латинице
 * (src/core/transliterate.ts), поэтому «Казбек» находит «Kazbek», а «Ushba» —
 * «Ушба». Экзонимы («Монблан» ≠ «Mont Blanc») так не берутся: это уже вопрос
 * полноты name:ru в OSM, а не поиска.
 *
 * Если по точному написанию не нашлось ничего, идёт второй проход с
 * исправлением опечаток (`searchFuzzy`). Именно в таком порядке: пока есть
 * точные совпадения, приблизительные только мешают.
 *
 * Возвращается список: одинаковые названия встречаются сплошь и рядом (в одних
 * Альпах несколько «Ostspitze»), да и регионы реестра перекрываются — выбор
 * оставляем человеку, показывая регион каждого варианта.
 */

import type { Peak } from "./peaks";
import { translitToLatin } from "./transliterate";
import { root } from "./globals";

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
  /** Найдено с исправлением опечаток: число правок до имени вершины */
  typos?: number;
}

/** Сколько вариантов показывать при неоднозначном запросе */
export const SEARCH_RESULT_LIMIT = 12;

/** Имя → сравнимая форма: латиница, нижний регистр, только буквы и цифры */
export function normalizeName(name: string): string {
  return translitToLatin(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Качество совпадения: true — точное, false — вхождение, null — мимо.
 */
function matchQuality(
  names: (string | undefined)[],
  q: string,
): boolean | null {
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
export function searchPeaks(
  query: string,
  peaks: Peak[],
  region: string,
): SearchHit[] {
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
    if (exact !== null)
      hits.push({ peak: entryToPeak(entry), region: entry[4], exact });
  }
  return hits;
}

/**
 * Сколько опечаток допускаем в запросе такой длины.
 *
 * Длина считается по тому, что набрал человек, а не по латинской форме:
 * транслитерация растягивает кириллицу («Ушма» → `ushma`, «Щи» → `schi`),
 * и бюджет, посчитанный по ней, прощал бы правку там, где слово короткое.
 * До пяти букв не прощаем ничего: «Ушба» → «Ушма» — это другая гора, цена
 * ложного совпадения выше пользы.
 */
export function typoBudget(length: number): number {
  if (length < 5) return 0;
  return length <= 8 ? 1 : 2;
}

/**
 * Расстояние Дамерау—Левенштейна с обрывом на max правках.
 *
 * Транспозиция считается одной правкой, а не двумя: «Эльбурс» вместо
 * «Эльбрус» — самая частая опечатка, перестановка соседних букв.
 * Обрыв нужен ради скорости: индекс — 40 тыс. имён на каждый запрос.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;

  const width = b.length + 1;
  // Три ряда по кругу, без копирования на каждой строке: поиск по опечаткам
  // прогоняет эту функцию сотни тысяч раз за запрос
  let prev2 = new Array<number>(width).fill(max + 1);
  let prev = new Array<number>(width);
  let curr = new Array<number>(width).fill(max + 1);
  for (let j = 0; j < width; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    // Полоса шириной 2·max+1 вокруг диагонали: за её пределами расстояние
    // заведомо больше max
    const from = Math.max(1, i - max);
    const to = Math.min(b.length, i + max);
    if (from > 1) curr[from - 1] = max + 1;
    let best = max + 1;
    for (let j = from; j <= to; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      curr[j] = value;
      if (value < best) best = value;
    }
    if (to < b.length) curr[to + 1] = max + 1;
    if (best > max) return max + 1; // вся строка уже дальше порога
    const spare = prev2;
    prev2 = prev;
    prev = curr;
    curr = spare;
  }
  return prev[b.length];
}

/** Имя как набрано: нижний регистр без разделителей, без перевода в латиницу */
function plainName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Лучшее (наименьшее) расстояние от запроса до любого из написаний имени.
 *
 * Транслитерация — самая дорогая часть поиска по опечаткам (40 тыс. имён на
 * запрос), поэтому она вызывается в последнюю очередь и только для тех имён,
 * до которых вообще можно дотянуться. Отсечение по длине работает и без неё:
 * перевод в латиницу букв не убавляет, поэтому имя, которое уже в исходном
 * письме длиннее запроса больше чем на max, не подойдёт и после перевода.
 * Разобранные написания кешируются на самих записях — повторный запрос по тем
 * же данным тратится только на расстояния.
 */
function typoDistance(
  item: object,
  names: (string | undefined)[],
  ctx: TypoQuery,
): number | null {
  const { q, qPlain, max } = ctx;
  let best = max + 1;
  const consider = (candidate: string, query: string) => {
    if (!candidate) return;
    const d = editDistance(query, candidate, max);
    if (d < best) best = d;
  };

  let plain = plainCache.get(item);
  if (!plain) {
    plain = [];
    for (const name of names) {
      if (!name) continue;
      const words = name
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
      plain.push(words.join(""), ...(words.length > 1 ? words : []));
    }
    plainCache.set(item, plain);
  }

  // Дешёвый проход в исходном письме: он же ловит опечатки в диграфах
  // («Щукино» против «Шукино» — одна правка кириллицей, две латиницей)
  let reachable = false;
  for (const form of plain) {
    if (form.length > qPlain.length + max) continue;
    reachable = true;
    consider(form, qPlain);
    if (best === 0) return 0;
  }
  if (!reachable) return null;

  let latin = latinCache.get(item);
  if (!latin) {
    latin = [];
    for (const name of names) {
      if (!name) continue;
      const words = translitToLatin(name)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      latin.push(words.join(""), ...(words.length > 1 ? words : []));
    }
    latinCache.set(item, latin);
  }
  for (const form of latin) {
    consider(form, q);
    if (best === 0) return 0;
  }
  return best <= max ? best : null;
}

interface TypoQuery {
  q: string;
  qPlain: string;
  max: number;
}

/** Разобранные написания имён — переживают повторные запросы к тем же данным */
const plainCache = new WeakMap<object, string[]>();
const latinCache = new WeakMap<object, string[]>();

/**
 * Поиск с исправлением опечаток — запасной проход, когда точных совпадений нет.
 * Работает и по вершинам региона, и по записям индекса (region = null).
 */
export function searchFuzzy(
  query: string,
  items: Peak[] | IndexEntry[],
  region: string | null,
): SearchHit[] {
  const q = normalizeName(query);
  const qPlain = plainName(query);
  const max = typoBudget(qPlain.length);
  if (!q || max === 0) return [];
  const ctx: TypoQuery = { q, qPlain, max };

  const hits: SearchHit[] = [];
  for (const item of items) {
    const isEntry = Array.isArray(item);
    const names = isEntry
      ? [item[0], item[5], item[6]]
      : [item.name, item.name_ru, item.name_en];
    const typos = typoDistance(item, names, ctx);
    if (typos === null) continue;
    hits.push({
      peak: isEntry ? entryToPeak(item) : item,
      region: isEntry ? item[4] : (region ?? ""),
      exact: false,
      typos,
    });
  }
  return hits;
}

/**
 * Ключ дедупликации: регионы реестра перекрываются, вершины в них дублируются.
 *
 * Округление до 3 знаков (~110 м) схлопывало соседние вершины одного гребня в
 * одну — на Безенгийской стене жандармы стоят и ближе. Пять знаков (~1 м)
 * ловят ту же вершину из двух регионов (координаты приходят из одного OSM),
 * но не склеивают разные.
 */
function hitKey(hit: SearchHit): string {
  return `${hit.peak.lat.toFixed(5)},${hit.peak.lon.toFixed(5)}`;
}

/** Насколько «тот самый» результат: высота, точность совпадения, близость */
function hitScore(
  hit: SearchHit,
  origin?: { lat: number; lon: number },
): number {
  const ele = hit.peak.ele ?? 0;
  let score = ele * (hit.exact ? 2 : 1);
  // Каждая правка — вдвое меньше доверия: исправленное написание не должно
  // обгонять то, что человек написал точно
  if (hit.typos) score /= 2 ** hit.typos;
  if (origin) {
    // Мягкий бонус за близость: ищут обычно то, что рядом. Масштаб большой
    // (500 км), иначе он перевесил бы высоту внутри одного горного узла.
    const dLat = (hit.peak.lat - origin.lat) * 111.32;
    const dLon =
      (hit.peak.lon - origin.lon) *
      111.32 *
      Math.cos((origin.lat * Math.PI) / 180);
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
      const better =
        !kept ||
        (!kept.exact && hit.exact) ||
        (kept.typos ?? 0) > (hit.typos ?? 0);
      if (better) seen.set(key, hit);
    }
  }
  return [...seen.values()]
    .sort((a, b) => hitScore(b, origin) - hitScore(a, origin))
    .slice(0, limit);
}

let indexCache: IndexEntry[] | null = null;
/**
 * Когда индекс в последний раз не удалось получить.
 *
 * Без этой отметки каждый поисковый запрос заново ждал 503 от Service
 * Worker'а: набор из десяти букв — десять походов в сеть впустую. Но и
 * запоминать отказ навсегда нельзя: сеть в горах появляется и пропадает,
 * поэтому через минуту пробуем снова.
 */
let indexFailedAt = 0;
const INDEX_RETRY_MS = 60_000;

/** Загрузка глобального индекса (один раз за сессию; дальше — кеш SW) */
export async function loadSearchIndex(
  base: string,
  fetchFn: typeof fetch = fetch.bind(root),
): Promise<IndexEntry[]> {
  if (indexCache) return indexCache;
  if (indexFailedAt && Date.now() - indexFailedAt < INDEX_RETRY_MS) return [];
  try {
    const res = await fetchFn(`${base}peaks/_index.json`);
    // Vite на 404 отдаёт index.html с HTTP 200 — проверяем тип
    if (
      !res.ok ||
      !(res.headers.get("content-type") ?? "").includes("application/json")
    ) {
      indexFailedAt = Date.now();
      return [];
    }
    indexCache = ((await res.json()) as IndexFile).peaks ?? [];
    indexFailedAt = 0;
    return indexCache;
  } catch {
    indexFailedAt = Date.now();
    return []; // офлайн и индекс не в кеше — ищем только по своим регионам
  }
}

/** Сброс кеша индекса (тесты, принудительное обновление) */
export function resetSearchIndexCache(): void {
  indexCache = null;
  indexFailedAt = 0;
}
