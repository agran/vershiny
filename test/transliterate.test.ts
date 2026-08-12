import { describe, expect, it } from 'vitest';
import { detectScript, translitToLatin } from '../src/core/transliterate';

describe('transliterate', () => {
  it('определение письменности', () => {
    expect(detectScript('Эльбрус')).toBe('cyrillic');
    expect(detectScript('გვანდრა')).toBe('georgian');
    expect(detectScript('Արարատ')).toBe('armenian');
    expect(detectScript('Όλυμπος')).toBe('greek');
    expect(detectScript('توبقال')).toBe('arabic');
    expect(detectScript('珠穆朗玛')).toBe('chinese');
    expect(detectScript('フジ')).toBe('japanese');
    expect(detectScript('백두산')).toBe('korean');
    expect(detectScript('Elbrus')).toBe('latin');
  });

  it('грузинский → латиница (Кавказ)', () => {
    expect(translitToLatin('გვანდრა')).toBe('Gvandra');
    expect(translitToLatin('მირდი')).toBe('Mirdi');
  });

  it('армянский → латиница (Арарат)', () => {
    expect(translitToLatin('Արարատ')).toBe('Ararat');
  });

  it('греческий → латиница (Олимп)', () => {
    // υ = 'i' по карте (современный греческий), 'y' — классический вариант
    expect(translitToLatin('Όλυμπος')).toBe('Olimpos');
  });

  it('арабский → латиница (Атлас)', () => {
    expect(translitToLatin('توبقال')).toBe('Twbqal');
  });

  it('японская катакана → латиница', () => {
    expect(translitToLatin('フジ')).toBe('Fuji');
  });

  it('корейский → латиница (Пэктусан)', () => {
    expect(translitToLatin('백두산')).toBe('Baekdusan');
  });

  it('смешанные строки: грузинский + кириллица', () => {
    expect(translitToLatin('გვანდრა - Гвандра')).toBe('Gvandra - Gvandra');
  });

  it('китайский → пиньинь (Эверест, горные термины)', () => {
    expect(translitToLatin('珠穆朗玛峰')).toBe('Zhu Mu Lang Ma Feng');
    expect(translitToLatin('天山')).toBe('Tian Shan');
    expect(translitToLatin('黄山')).toBe('Huang Shan');
    expect(translitToLatin('昆仑山')).toBe('Kun Lun Shan');
    expect(translitToLatin('喜马拉雅山')).toBe('Xi Ma La Ya Shan');
  });

  it('латиница остаётся как есть', () => {
    expect(translitToLatin('Elbrus')).toBe('Elbrus');
    expect(translitToLatin('Mont Blanc')).toBe('Mont Blanc');
  });
});
