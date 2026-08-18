/**
 * Дедупликация офлайн-скачивания: базовый LOD 0 не качается в ячейках 1°,
 * полностью покрытых hi-слоем (keepBaseTileKey в ui/download.ts).
 */

import { describe, it, expect } from "vitest";
import type { DemSampler } from "../src/core/dem";
import { keepBaseTileKey } from "../src/ui/download";

/** Заглушка hi-сэмплера: покрытие задаётся списком тайлов LOD 0 */
function hiWith(tiles: Array<[number, number]>): DemSampler {
  const set = new Set(tiles.map(([tx, ty]) => `${tx}/${ty}`));
  return {
    hasTile: (lod: number, tx: number, ty: number) =>
      lod === 0 && set.has(`${tx}/${ty}`),
  } as unknown as DemSampler;
}

/** Полный квадрат 5×5 hi-тайлов ячейки (cx, cy) плюс опционально минус один */
function fullCell(
  cx: number,
  cy: number,
  skip?: [number, number],
): Array<[number, number]> {
  const tiles: Array<[number, number]> = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const t: [number, number] = [cx * 5 + i, cy * 5 + j];
      if (skip && t[0] === skip[0] && t[1] === skip[1]) continue;
      tiles.push(t);
    }
  }
  return tiles;
}

describe("keepBaseTileKey: дедупликация базового LOD 0 против hi-слоя", () => {
  it("отбрасывает базовые тайлы в полностью покрытой ячейке", () => {
    // Ячейка (222, 46) = 42…43° в.д., 43…44° с.ш. (Приэльбрусье)
    const keep = keepBaseTileKey(hiWith(fullCell(222, 46)));
    // Тайл 0.5° (444, 92) и его сосед по ячейке (445, 93) — избыточны
    expect(keep("0/444/92")).toBe(false);
    expect(keep("0/445/93")).toBe(false);
  });

  it("сохраняет базовый тайл, если в ячейке hi не хватает хотя бы одного тайла", () => {
    const keep = keepBaseTileKey(hiWith(fullCell(222, 46, [1113, 233])));
    expect(keep("0/444/92")).toBe(true);
  });

  it("не трогает прочие LOD и непокрытые ячейки", () => {
    const keep = keepBaseTileKey(hiWith(fullCell(222, 46)));
    expect(keep("1/222/46")).toBe(true); // LOD 1 — не дубль
    expect(keep("2/55/11")).toBe(true); // LOD 2 — вся суша
    expect(keep("0/446/92")).toBe(true); // соседняя ячейка без hi
  });
});
