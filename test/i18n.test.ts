// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { peakName, setLocale, translitToEn, translitToRu } from '../src/core/i18n';

describe('i18n', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('транслитерация кириллицы → латиница', () => {
    expect(translitToEn('Эльбрус')).toBe('Elbrus');
    expect(translitToEn('Гвандра')).toBe('Gvandra');
    expect(translitToEn('Мырды')).toBe('Myrdy');
    expect(translitToEn('Шхара')).toBe('Shkhara');
    expect(translitToEn('Донгузорун')).toBe('Donguzorun');
    expect(translitToEn('Чегет')).toBe('Cheget');
  });

  it('транслитерация латиницы → кириллица', () => {
    expect(translitToRu('Elbrus')).toBe('Елбрус');
    expect(translitToRu('Shkhara')).toBe('Шхара');
    expect(translitToRu('Cheget')).toBe('Чегет');
  });

  it('peakName: ru-локаль предпочитает name_ru', () => {
    setLocale('ru');
    const peak = { name: 'გვანდრა - Гвандра', name_ru: 'Гвандра', name_en: 'Gvandra' };
    expect(peakName(peak)).toBe('Гвандра');
  });

  it('peakName: en-локаль предпочитает name_en', () => {
    setLocale('en');
    const peak = { name: 'გვანდრა - Гвандра', name_ru: 'Гвандра', name_en: 'Gvandra' };
    expect(peakName(peak)).toBe('Gvandra');
  });

  it('peakName: fallback на транслитерацию при отсутствии нужного языка', () => {
    setLocale('en');
    expect(peakName({ name: 'Псырс' })).toBe('Psyrs');
    setLocale('ru');
    expect(peakName({ name: 'Gvandra' })).toBe('Гвандра');
  });

  it('peakName: mixed name (груз + рус) транслитерирует обе части в латиницу', () => {
    setLocale('en');
    expect(peakName({ name: 'გვანდრა - Гвандра' })).toBe('Gvandra - Gvandra');
  });

  it('peakName: en-локаль не оставляет мхедрули и арабицу как есть', () => {
    // Проверялась только кириллица, поэтому чисто грузинское или арабское
    // название англоязычный пользователь видел в исходном письме
    setLocale('en');
    expect(peakName({ name: 'გვანდრა' })).toBe('Gvandra');
    expect(peakName({ name: 'توبقال' })).toBe('Twbqal');
  });

  it('peakName: ru-локаль доводит нелатинское имя до кириллицы', () => {
    setLocale('ru');
    expect(peakName({ name: 'გვანდრა' })).toBe('Гвандра');
  });
});
