/**
 * Секторные верхние границы высот для обрыва лучей (CODE-REVIEW P4).
 * Граница обязана быть консервативной: занижение = потеря видимого рельефа.
 */

import { describe, expect, it } from "vitest";
import { azimuthRad, normalizeAz } from "../src/core/geo";
import {
    SECTOR_CULL_START_M,
    sectorBoundsForTiles,
    type SectorTile,
} from "../src/core/sector-bounds";

const SECTORS = 72;

describe("sectorBoundsForTiles", () => {
  it("дальний тайл приписывается секторам своего азимута с окаймлением", () => {
    const origin = { lat: 43, lon: 42 };
    // Тайл ~110 км к северу, размером ~1 км
    const tile: SectorTile = {
      minLon: 41.995,
      minLat: 43.995,
      maxLon: 42.005,
      maxLat: 44.005,
      h: 3000,
    };
    const b = sectorBoundsForTiles(origin, [tile], SECTORS);
    // Север + один сектор окаймления в обе стороны (−2…1 → 70, 71, 0, 1)
    expect(b[0]).toBe(3000);
    expect(b[71]).toBe(3000);
    expect(b[70]).toBe(3000);
    expect(b[1]).toBe(3000);
    // Дальше окаймления — не тронуты
    expect(b[2]).toBe(0);
    expect(b[18]).toBe(0);
    expect(b[36]).toBe(0);
  });

  it("ближний тайл (целиком до порога) в границы не входит", () => {
    const origin = { lat: 43, lon: 42 };
    // Гора прямо под ногами: её высоты луч дальше порога не читает
    const tile: SectorTile = {
      minLon: 41.9,
      minLat: 42.9,
      maxLon: 42.1,
      maxLat: 43.1,
      h: 5600,
    };
    const b = sectorBoundsForTiles(origin, [tile], SECTORS);
    expect(Array.from(b).every((v) => v === 0)).toBe(true);
  });

  it("тайл, содержащий наблюдателя, покрывает все сектора", () => {
    const origin = { lat: 43, lon: 42 };
    const tile: SectorTile = {
      minLon: -180,
      minLat: -90,
      maxLon: 180,
      maxLat: 90,
      h: 4000,
    };
    const b = sectorBoundsForTiles(origin, [tile], SECTORS);
    expect(Array.from(b).every((v) => v === 4000)).toBe(true);
  });

  it("антимеридиан: тайл за 180° приписывается своему сектору", () => {
    const origin = { lat: 66, lon: 179.5 };
    // Тайл к западу за антимеридианом, ~470 км
    const tile: SectorTile = {
      minLon: -170.1,
      minLat: 65.9,
      maxLon: -170,
      maxLat: 66.1,
      h: 2000,
    };
    const b = sectorBoundsForTiles(origin, [tile], SECTORS);
    const azC = normalizeAz(azimuthRad(origin, { lat: 66, lon: -170 }));
    const sector = Math.floor(azC / ((2 * Math.PI) / SECTORS));
    expect(b[sector]).toBe(2000);
    // Противоположный сектор пуст
    expect(b[(sector + SECTORS / 2) % SECTORS]).toBe(0);
  });

  it("пустые сектора получают 0 — обрыв работает над равниной и морем", () => {
    const origin = { lat: 43, lon: 42 };
    const b = sectorBoundsForTiles(origin, [], SECTORS);
    expect(Array.from(b).every((v) => v === 0)).toBe(true);
    expect(SECTOR_CULL_START_M).toBe(60_000);
  });
});
