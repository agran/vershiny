import { describe, expect, it } from "vitest";
import { isInRussia } from "../src/core/russia";

describe("isInRussia", () => {
  it("российские города — внутри", () => {
    expect(isInRussia(37.6, 55.75)).toBe(true); // Москва
    expect(isInRussia(30.3, 59.9)).toBe(true); // Санкт-Петербург
    expect(isInRussia(49.1, 55.8)).toBe(true); // Казань
    expect(isInRussia(60.6, 56.8)).toBe(true); // Екатеринбург
    expect(isInRussia(82.9, 55.0)).toBe(true); // Новосибирск
    expect(isInRussia(104.3, 52.3)).toBe(true); // Иркутск
    expect(isInRussia(131.9, 43.1)).toBe(true); // Владивосток
    expect(isInRussia(158.7, 53.0)).toBe(true); // Петропавловск-Камчатский
    expect(isInRussia(42.44, 43.35)).toBe(true); // Эльбрус
    expect(isInRussia(39.7, 43.6)).toBe(true); // Сочи
    expect(isInRussia(20.5, 54.7)).toBe(true); // Калининград
  });

  it("соседние страны — снаружи", () => {
    expect(isInRussia(44.8, 41.7)).toBe(false); // Тбилиси
    expect(isInRussia(44.5, 40.2)).toBe(false); // Ереван
    expect(isInRussia(49.9, 40.4)).toBe(false); // Баку
    expect(isInRussia(71.4, 51.2)).toBe(false); // Астана
    expect(isInRussia(76.9, 43.3)).toBe(false); // Алматы
    expect(isInRussia(106.9, 47.9)).toBe(false); // Улан-Батор
    expect(isInRussia(116.4, 39.9)).toBe(false); // Пекин
    expect(isInRussia(126.6, 45.8)).toBe(false); // Харбин
    expect(isInRussia(24.9, 60.2)).toBe(false); // Хельсинки
    expect(isInRussia(30.5, 50.4)).toBe(false); // Киев
    expect(isInRussia(27.5, 53.9)).toBe(false); // Минск
    expect(isInRussia(21.0, 52.2)).toBe(false); // Варшава
  });
});
