/**
 * Полнота скачанного региона: повторное нажатие «Скачать» не должно
 * запускать полный прогон, когда все тайлы уже на устройстве
 * (isRegionIncomplete в ui/download.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatLon } from "../src/core/geo";

// --- Хранилища-заглушки -----------------------------------------------

const demStore = new Map<string, Uint8Array>();
const terrariumStore = new Map<string, Uint8Array>();

vi.mock("../src/core/db", () => ({
  getDemTile: async (key: string) => demStore.get(key),
  getTerrariumTile: async (key: string) => terrariumStore.get(key),
  markRegionDownloaded: async () => {},
  savePeaks: async () => {},
}));

// --- Мок DemSampler: мини-пирамиды с фиксированным набором тайлов ----

vi.mock("../src/core/dem", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/dem")>();
  return {
    ...orig,
    DemSampler: class MockDemSampler {
      readonly baseUrl: string;
      constructor(options: { baseUrl: string }) {
        this.baseUrl = options.baseUrl;
      }
      async loadIndex(): Promise<Record<string, never>> {
        return {};
      }
      storeKey(key: string): string {
        return this.baseUrl.includes("hi") ? `hi/${key}` : key;
      }
      tileKeysInBBox(): string[] {
        return this.baseUrl.includes("hi") ? ["0/0/0"] : ["0/0/0"];
      }
      hasTile(lod: number, tx: number, ty: number): boolean {
        // Для keepBaseTileKey: LOD 0, тайл (0,0) — есть, остальное нет
        return lod === 0 && tx === 0 && ty === 0;
      }
      get version(): string {
        return "v1";
      }
    },
  };
});

const ORIGIN: LatLon = { lat: 43, lon: 42 };

describe("isRegionIncomplete: проверка полноты офлайн-региона", () => {
  beforeEach(() => {
    demStore.clear();
    terrariumStore.clear();
    // Пирамиды внутри download.ts кешируются между вызовами: без сброса
    // модулей тесты видят сэмплеры друг друга и неверно вычисляют полноту
    vi.resetModules();
  });

  async function incomplete(bbox: [number, number, number, number]) {
    const mod = await import("../src/ui/download");
    return mod.isRegionIncomplete({ bbox }, ORIGIN);
  }

  it("неполный, если не хватает базового тайла", async () => {
    await expect(incomplete([-180, -90, 180, 90])).resolves.toBe(true);
  });

  it("неполный, если не хватает hi-тайла", async () => {
    demStore.set("0/0/0", new Uint8Array([1]));
    // hi/0/0/0 нет
    await expect(incomplete([-180, -90, 180, 90])).resolves.toBe(true);
  });

  it("неполный, если не хватает Terrarium-тайла детальной зоны", async () => {
    demStore.set("0/0/0", new Uint8Array([1]));
    demStore.set("hi/0/0/0", new Uint8Array([1]));
    // terrarium 12/x/y нет
    await expect(incomplete([-180, -90, 180, 90])).resolves.toBe(true);
  });

  it("полный, когда все слои на месте", async () => {
    demStore.set("0/0/0", new Uint8Array([1]));
    demStore.set("hi/0/0/0", new Uint8Array([1]));
    // Детальная зона вокруг (43, 42) на 30 км: z12 + z11.
    const EARTH = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const normLon = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
    function dest(o: LatLon, az: number, dist: number): LatLon {
      const d = dist / EARTH,
        lat1 = rad(o.lat),
        lon1 = rad(o.lon);
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
          Math.cos(lat1) * Math.sin(d) * Math.cos(az),
      );
      const lon2 =
        lon1 +
        Math.atan2(
          Math.sin(az) * Math.sin(d) * Math.cos(lat1),
          Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
        );
      return {
        lat: (lat2 * 180) / Math.PI,
        lon: normLon((lon2 * 180) / Math.PI),
      };
    }
    for (const z of [12, 11]) {
      const n = 2 ** z;
      const north = dest(ORIGIN, 0, 30_000).lat;
      const south = dest(ORIGIN, Math.PI, 30_000).lat;
      const east = dest(ORIGIN, Math.PI / 2, 30_000).lon;
      const west = dest(ORIGIN, -Math.PI / 2, 30_000).lon;
      const tileY = (lat: number) => {
        const r = rad(Math.max(-85.05, Math.min(85.05, lat)));
        return (
          ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
        );
      };
      const y0 = Math.floor(tileY(north)),
        y1 = Math.ceil(tileY(south));
      const x0 = Math.floor(((west + 180) / 360) * n);
      let x1 = Math.ceil(((east + 180) / 360) * n);
      if (x1 <= x0) x1 += n;
      for (let x = x0; x < x1; x++)
        for (let y = y0; y < y1; y++) {
          if (y < 0 || y >= n) continue;
          terrariumStore.set(
            `${z}/${((x % n) + n) % n}/${y}`,
            new Uint8Array([1]),
          );
        }
    }
    await expect(incomplete([-180, -90, 180, 90])).resolves.toBe(false);
  });
});
