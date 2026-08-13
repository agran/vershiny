/**
 * Выбор региона под текущую точку.
 *
 * Регион задаёт список вершин: уйдя за его границы, человек получил бы
 * подписи за сотни километров отсюда. Но и дёргать предложением на каждом
 * шагу нельзя — регионы реестра перекрываются буфером в 200 км.
 */

import { describe, it, expect } from 'vitest';
import {
  suggestRegionForPosition,
  findRegionForPosition,
  type RegionInfo,
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
