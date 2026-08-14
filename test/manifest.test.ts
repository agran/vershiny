/**
 * Манифест PWA: что именно откроется с домашнего экрана.
 *
 * Установку предлагает `install.html`, а открываться должно приложение.
 * Держится это на одном поле — `start_url` манифеста: и Safari, и Chrome
 * запускают ярлык именно по нему, а не по адресу страницы, с которой его
 * добавили. Стоит полю уехать (или манифесту потеряться на одной из
 * страниц) — и человек получит ярлык, открывающий инструкцию по установке.
 * Проверить это в браузере можно только с телефона в руках, поэтому здесь.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

const manifest = JSON.parse(read('../public/manifest.webmanifest')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Куда манифест разложится на боевом адресе */
const MANIFEST_URL = 'https://agran.github.io/vershiny/manifest.webmanifest';
const APP_URL = 'https://agran.github.io/vershiny/';
const INSTALL_URL = 'https://agran.github.io/vershiny/install.html';

describe('манифест PWA', () => {
  it('ярлык открывает панораму, а не страницу установки', () => {
    const start = new URL(manifest.start_url, MANIFEST_URL).href;

    expect(start).toBe(APP_URL);
    expect(start).not.toBe(INSTALL_URL);
  });

  it('область охватывает обе страницы сайта', () => {
    // Иначе переход на инструкцию из установленного приложения выкинул бы
    // человека в браузер
    const scope = new URL(manifest.scope, MANIFEST_URL).href;

    expect(APP_URL.startsWith(scope)).toBe(true);
    expect(INSTALL_URL.startsWith(scope)).toBe(true);
  });

  it('обе страницы ссылаются на один и тот же манифест', () => {
    // Разные манифесты означали бы два разных «приложения» с одинаковой
    // иконкой: установленное со страницы инструкции вело бы не туда
    const link = (html: string): string =>
      /<link[^>]+rel="manifest"[^>]+href="([^"]+)"/.exec(html)?.[1] ?? '';

    expect(link(read('../index.html'))).toBe('./manifest.webmanifest');
    expect(link(read('../install.html'))).toBe('./manifest.webmanifest');
  });

  it('запускается в своём окне и подписан по-человечески', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    // Длинное имя iOS обрезает под иконкой — короткое обязано быть коротким
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it('все иконки манифеста лежат на месте', () => {
    // Пропавшая иконка ломает саму установку, а заметно это только с телефона
    for (const icon of manifest.icons) {
      const path = `../public/${icon.src}`;
      expect(
        existsSync(fileURLToPath(new URL(path, import.meta.url))),
        `нет файла иконки ${icon.src}`,
      ).toBe(true);
    }
    // Маскируемая иконка нужна Android: без неё систему устраивает обрезка
    // квадратом, и в круглой рамке от рисунка остаётся середина
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('страница установки ведёт в приложение, а не в никуда', () => {
    const html = read('../install.html');
    expect(html).toContain('href="./"');
  });
});
