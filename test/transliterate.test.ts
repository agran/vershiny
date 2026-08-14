import { describe, expect, it } from 'vitest';
import { detectScript, translitToLatin, translitToRu } from '../src/core/transliterate';

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

  it('иероглифы Эвереста без name_en транслитерируются, а не остаются сырыми', () => {
    // Вершины, видимые с Кала-Патхара: иероглифы не должны протекать в подпись
    expect(translitToLatin('尖兵峰')).toBe('Jian Bing Feng');
    expect(translitToLatin('洛林峰')).toBe('Luo Lin Feng');
    expect(translitToLatin('日东那布')).toBe('Ri Dong Na Bu');
    // Регресс целиком: ни в одном названии не должно остаться иероглифов
    for (const n of ['德生峰', '拉巴日', '桑莫多', '布丁峰']) {
      expect(translitToLatin(n)).not.toMatch(/[\u4E00-\u9FFF]/);
    }
  });

  it('латиница остаётся как есть', () => {
    expect(translitToLatin('Elbrus')).toBe('Elbrus');
    expect(translitToLatin('Mont Blanc')).toBe('Mont Blanc');
  });

  it('немецкие диграфы: sch → ш, tsch → ч', () => {
    // Без них «Schesaplana» превращалась в «Скхесаплану», а «Tschierva» —
    // в «Тсчиерву»: в Альпах таких названий полно
    expect(translitToRu('Schesaplana')).toBe('Шесаплана');
    expect(translitToRu('Tschierva')).toBe('Чиерва');
    // Русская «щ» (shch) по-прежнему длиннее и разбирается первой
    expect(translitToRu('Shchara')).toBe('Щара');
  });
});
