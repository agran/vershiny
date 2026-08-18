/**
 * Поиск вершин: транслитерация запроса, несколько вариантов с регионами,
 * глобальный индекс для регионов, которые пользователь не открывал.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeName,
  searchPeaks,
  searchIndex,
  searchFuzzy,
  editDistance,
  typoBudget,
  mergeHits,
  loadSearchIndex,
  resetSearchIndexCache,
  type IndexEntry,
} from "../src/core/search";
import type { Peak } from "../src/core/peaks";

const REGION_PEAKS: Peak[] = [
  { name: "Ушба Южная", lat: 43.1, lon: 42.6, ele: 4710 },
  { name: "Ушба Северная", lat: 43.11, lon: 42.61, ele: 4697 },
  {
    name: "Эльбрус Западный",
    lat: 43.35,
    lon: 42.44,
    ele: 5642,
    name_en: "Mount Elbrus",
  },
  { name: "Донгузорун", lat: 43.2, lon: 42.5, ele: 4454 },
];

const INDEX: IndexEntry[] = [
  ["Казбек", 42.7, 44.52, 5054, "caucasus-east", "Mount Kazbek"],
  ["Ушба Южная", 43.1, 42.6, 4710, "caucasus-central"],
  ["Белуха", 49.8, 86.59, 4509, "altai"],
  ["Uhuru Peak", -3.07, 37.35, 5895, "east-africa"],
];

describe("поиск вершин", () => {
  it("нормализует имена через латиницу", () => {
    expect(normalizeName("Ушба Южная")).toBe(normalizeName("Ushba Yuzhnaya"));
    expect(normalizeName("Эльбрус")).toBe("elbrus");
    expect(normalizeName("  Mont-Blanc!  ")).toBe("montblanc");
  });

  it("находит по кириллице латинское имя и наоборот", () => {
    // Запрос латиницей → вершина названа кириллицей
    const byLatin = searchPeaks("Elbrus", REGION_PEAKS, "elbrus");
    expect(byLatin.map((h) => h.peak.name)).toContain("Эльбрус Западный");

    // Запрос кириллицей → английское написание в name_en
    const byCyrillic = searchPeaks(
      "Казбек",
      INDEX.map((e) => ({ name: e[0], lat: e[1], lon: e[2] })),
      "x",
    );
    expect(byCyrillic).toHaveLength(1);
  });

  it("возвращает все совпадения, а не первое", () => {
    const hits = searchPeaks("Ушба", REGION_PEAKS, "elbrus");
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => !h.exact)).toBe(true);
  });

  it("точное совпадение весит больше, но высота решает", () => {
    const hits = mergeHits([searchPeaks("Ушба Южная", REGION_PEAKS, "elbrus")]);
    expect(hits[0].peak.name).toBe("Ушба Южная");
    expect(hits[0].exact).toBe(true);

    const partial = mergeHits([searchPeaks("Ушба", REGION_PEAKS, "elbrus")]);
    expect(partial[0].peak.ele).toBe(4710); // из двух «Ушб» — высокая

    // Одноимённая сопка 1060 м совпадает точно, настоящий Казбек (5054 м)
    // назван «მყინვარწვერი - Казбек» — первым всё равно должен быть он
    const kazbek = mergeHits([
      searchIndex("Казбек", [
        ["Казбек", 61.0, 152.0, 1060, "magadan"],
        ["მყინვარწვერი - Казбек", 42.7, 44.52, 5054, "caucasus-east"],
      ]),
    ]);
    expect(kazbek[0].peak.ele).toBe(5054);
    expect(kazbek[0].region).toBe("caucasus-east");
  });

  it("при равной высоте ближняя вершина выше в списке", () => {
    const far: IndexEntry = ["Пик", 60.0, 100.0, 4000, "siberia"];
    const near: IndexEntry = ["Пик", 43.3, 42.5, 4000, "elbrus"];
    const hits = mergeHits([searchIndex("Пик", [far, near])], {
      lat: 43.318,
      lon: 42.458,
    });
    expect(hits[0].region).toBe("elbrus");
  });

  it("индекс покрывает регионы, которых нет у пользователя", () => {
    const hits = searchIndex("Казбек", INDEX);
    expect(hits).toHaveLength(1);
    expect(hits[0].region).toBe("caucasus-east");
    expect(hits[0].peak.ele).toBe(5054);
    expect(hits[0].peak.name_en).toBe("Mount Kazbek");
  });

  it("дубли из перекрывающихся регионов схлопываются, свой источник в приоритете", () => {
    const hits = mergeHits([
      searchPeaks("Ушба Южная", REGION_PEAKS, "elbrus"),
      searchIndex("Ушба Южная", INDEX),
    ]);
    // Одна вершина, регион — свой (пришёл первым), а не из индекса
    expect(hits).toHaveLength(1);
    expect(hits[0].region).toBe("elbrus");
  });

  it("офлайн без индекса не ломает поиск", async () => {
    resetSearchIndexCache();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(loadSearchIndex("/vershiny/", failing)).resolves.toEqual([]);
  });

  it("офлайн не ходит в сеть на каждую букву запроса", async () => {
    // Без сети Service Worker отвечает 503; повторять этот поход на каждый
    // символ — значит ждать по кругу там, где ответ заведомо известен
    resetSearchIndexCache();
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch;

    await loadSearchIndex("/vershiny/", failing);
    await loadSearchIndex("/vershiny/", failing);
    await loadSearchIndex("/vershiny/", failing);
    expect(calls).toBe(1);

    // Сброс кеша (сеть вернулась) снова пускает запрос
    resetSearchIndexCache();
    await loadSearchIndex("/vershiny/", failing);
    expect(calls).toBe(2);
  });

  it("соседние вершины одного гребня не схлопываются в одну", () => {
    // Ключ дедупликации округлялся до 3 знаков (~110 м): жандармы
    // Безенгийской стены стоят и ближе — оставалась одна вершина из двух
    const a: IndexEntry = [
      "Джангитау Главная",
      43.03,
      43.03,
      5085,
      "caucasus-west",
    ];
    const b: IndexEntry = [
      "Джангитау Западная",
      43.0303,
      43.0303,
      5058,
      "caucasus-west",
    ];
    const hits = mergeHits([searchIndex("Джангитау", [a, b])]);
    expect(hits).toHaveLength(2);
  });
});

describe("поиск с опечатками", () => {
  it("считает перестановку соседних букв одной правкой", () => {
    // Самая частая опечатка — «Эльбурс» вместо «Эльбруса»
    expect(editDistance("elburs", "elbrus", 2)).toBe(1);
    expect(editDistance("elbrus", "elbrus", 2)).toBe(0);
    expect(editDistance("kazbek", "kazbec", 2)).toBe(1);
  });

  it("обрывается на пороге, а не считает до конца", () => {
    expect(editDistance("elbrus", "everest", 1)).toBeGreaterThan(1);
    expect(editDistance("abc", "abcdefgh", 2)).toBeGreaterThan(2);
  });

  it("на коротких запросах опечатки не прощает", () => {
    // «Ушба» и «Ушма» — разные горы, одна правка их не различает
    expect(typoBudget(4)).toBe(0);
    expect(searchFuzzy("Ушма", REGION_PEAKS, "elbrus")).toHaveLength(0);
    expect(typoBudget(6)).toBe(1);
    expect(typoBudget(12)).toBe(2);
  });

  it("находит вершину, набранную с опечаткой", () => {
    const hits = searchFuzzy("Эльбурс", REGION_PEAKS, "elbrus");
    expect(hits.map((h) => h.peak.name)).toContain("Эльбрус Западный");
    expect(hits[0].typos).toBe(1);
  });

  it("ищет опечатку в самом названии, а не в приставке", () => {
    const hits = searchFuzzy("Донгузарун", REGION_PEAKS, "elbrus");
    expect(hits.map((h) => h.peak.name)).toContain("Донгузорун");
  });

  it("работает и по записям глобального индекса", () => {
    const hits = searchFuzzy("Казбег", INDEX, null);
    expect(hits[0].peak.name).toBe("Казбек");
    expect(hits[0].region).toBe("caucasus-east");
  });

  it("исправленные варианты ранжируются ниже точных", () => {
    const exact = searchPeaks("Донгузорун", REGION_PEAKS, "elbrus");
    const fuzzy = searchFuzzy("Эльбурс", REGION_PEAKS, "elbrus");
    const hits = mergeHits([exact, fuzzy]);
    expect(hits[0].peak.name).toBe("Донгузорун"); // 4454 м точно
    expect(hits[1].typos).toBe(1); // Эльбрус 5642 м, но с правкой
  });
});
