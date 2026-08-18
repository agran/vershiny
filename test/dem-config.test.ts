/**
 * Выбор источника рельефа среди кандидатов.
 *
 * Проверка «есть ли index.json» была чисто сетевой: без связи не проходил ни
 * один кандидат, приложение оставалось на голом Terrarium и падало с
 * «HTTP 503» — при том что пирамида и её тайлы лежали в IndexedDB.
 */

import { describe, it, expect } from "vitest";
import {
  demCandidates,
  demStorePrefix,
  pickDemBase,
  GLOBAL_DEM_URL,
} from "../src/core/dem-config";

const CANDIDATES = demCandidates("/vershiny/", "elbrus");

function probes(online: string[], cached: string[]) {
  return {
    online: async (url: string) => online.includes(url),
    cached: async (url: string) => cached.includes(url),
  };
}

describe("выбор источника рельефа", () => {
  it("онлайн берёт самый детальный доступный", async () => {
    expect(await pickDemBase(CANDIDATES, probes([GLOBAL_DEM_URL], []))).toBe(
      GLOBAL_DEM_URL,
    );
    expect(
      await pickDemBase(
        CANDIDATES,
        probes(["/vershiny/tiles/global", GLOBAL_DEM_URL], []),
      ),
    ).toBe("/vershiny/tiles/global");
  });

  it("офлайн берёт тот, чей индекс сохранён", async () => {
    expect(await pickDemBase(CANDIDATES, probes([], [GLOBAL_DEM_URL]))).toBe(
      GLOBAL_DEM_URL,
    );
  });

  it("детальный патч из кеша важнее грубой пирамиды из сети", async () => {
    const picked = await pickDemBase(
      CANDIDATES,
      probes([GLOBAL_DEM_URL], ["/vershiny/tiles/elbrus"]),
    );
    expect(picked).toBe("/vershiny/tiles/elbrus");
  });

  it("нет ни сети, ни кеша — источника нет", async () => {
    expect(await pickDemBase(CANDIDATES, probes([], []))).toBeUndefined();
  });
});

describe("пространство имён тайлов в хранилище", () => {
  it("у пирамиды ключ прежний, где бы она ни лежала", () => {
    // Локальная и внешняя копии — одни и те же тайлы; смена ключа обнулила бы
    // всё, что уже скачано на устройствах
    expect(demStorePrefix(GLOBAL_DEM_URL)).toBe("");
    expect(demStorePrefix("/vershiny/tiles/global")).toBe("");
    expect(demStorePrefix("/vershiny/tiles/global/")).toBe("");
  });

  it("у детального патча региона ключ свой", () => {
    // Сетка и начало координат у патча другие: в общем пространстве имён он
    // молча читал бы тайлы пирамиды, отдавая высоты не того места
    expect(demStorePrefix("/vershiny/tiles/elbrus")).toBe("elbrus/");
    expect(demStorePrefix("/vershiny/tiles/alps-east")).toBe("alps-east/");
    expect(demStorePrefix("/vershiny/tiles/elbrus")).not.toBe(
      demStorePrefix(GLOBAL_DEM_URL),
    );
  });
});
