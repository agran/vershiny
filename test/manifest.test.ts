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

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf-8");

const manifest = JSON.parse(read("../public/manifest.webmanifest")) as {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Куда манифест разложится на боевом адресе */
const MANIFEST_URL = "https://agran.github.io/vershiny/manifest.webmanifest";
const APP_URL = "https://agran.github.io/vershiny/";
const INSTALL_URL = "https://agran.github.io/vershiny/install.html";

describe("манифест PWA", () => {
  it("ярлык открывает панораму, а не страницу установки", () => {
    const start = new URL(manifest.start_url, MANIFEST_URL).href;

    expect(start).toBe(APP_URL);
    expect(start).not.toBe(INSTALL_URL);
  });

  it("область охватывает обе страницы сайта", () => {
    // Иначе переход на инструкцию из установленного приложения выкинул бы
    // человека в браузер
    const scope = new URL(manifest.scope, MANIFEST_URL).href;

    expect(APP_URL.startsWith(scope)).toBe(true);
    expect(INSTALL_URL.startsWith(scope)).toBe(true);
  });

  it("обе страницы ссылаются на один и тот же манифест", () => {
    // Разные манифесты означали бы два разных «приложения» с одинаковой
    // иконкой: установленное со страницы инструкции вело бы не туда
    const link = (html: string): string =>
      /<link[^>]+rel="manifest"[^>]+href="([^"]+)"/.exec(html)?.[1] ?? "";

    expect(link(read("../index.html"))).toBe("./manifest.webmanifest");
    expect(link(read("../install.html"))).toBe("./manifest.webmanifest");
  });

  it("запускается в своём окне и подписан по-человечески", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.short_name.length).toBeGreaterThan(0);
    // Длинное имя iOS обрезает под иконкой — короткое обязано быть коротким
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it("ориентацию манифест НЕ фиксирует: ландшафт даёт программный поворот", () => {
    // `orientation: landscape` убивал установленное приложение на Xiaomi
    // HyperOS при запуске с рабочего стола (из уведомления запускалось,
    // но с жёстко ландшафтным окном). Окно следует за системным
    // автоповоротом, а ландшафт по хвату делает CSS-поворот
    // (core/screen-orientation.ts) — как во вкладке браузера.
    const m = manifest as { orientation?: string };
    expect(m.orientation).toBeUndefined();
  });

  it("все иконки манифеста лежат на месте", () => {
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
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("страница установки ведёт в приложение, а не в никуда", () => {
    const html = read("../install.html");
    expect(html).toContain('href="./"');
  });

  it("для тупиковых сред страница даёт обходы, не пряча рабочие шаги", () => {
    // WebView (Telegram, VK, мессенджеры) и старая iOS в чужом браузере —
    // единственные места, где установка действительно недоступна. Панели с
    // обходами (Открыть в Safari / Открыть в Chrome, копия адреса) должны
    // лежать ВНЕ #install-steps: UA-детекция неточна, и ложное срабатывание
    // не должно прятать рабочие инструкции
    const html = read("../install.html");
    expect(html).toContain('id="ios-copy"');
    expect(html).toContain('id="ios-open-safari"');
    expect(html).toContain('id="android-open-browser"');
    const stepsOpen = html.indexOf('id="install-steps"');
    const stepsEnd = html.indexOf("</ul>\n      </div>", stepsOpen);
    expect(stepsOpen).toBeGreaterThan(0);
    expect(stepsEnd).toBeGreaterThan(stepsOpen);
    const outside = (marker: string): boolean => {
      const at = html.indexOf(marker);
      return at < stepsOpen || at > stepsEnd;
    };
    expect(outside('id="ios-other"')).toBe(true);
    expect(outside('id="android-webview"')).toBe(true);
  });

  it("в Яндекс Браузере на iOS показывается свой путь через меню", () => {
    // У Яндекса установка идёт через меню ⋮ → «Добавить ярлык на рабочий
    // стол» → «На экран “Домой”», а не через «Поделиться» — общая
    // инструкция там путает. Блок с шагами обязан существовать, а шаги
    // должны быть на месте (детекция YaBrowser в UA надёжна)
    const html = read("../install.html");
    expect(html).toContain('id="ios-yandex"');
    expect(html).toContain("Добавить ярлык на рабочий стол");
    expect(html).toContain("На экран «Домой»");
  });

  it("имя и описание манифеста двуязычны (политика проекта)", () => {
    // short_name остаётся брендом: двуязычное имя iOS обрезает под иконкой
    // (тест «подписан по-человечески» выше)
    expect(manifest.name).toContain("Вершины");
    expect(manifest.name).toContain("Vershiny");
    expect(/[а-яё]/i.test(manifest.description)).toBe(true);
    expect(/[a-z]/i.test(manifest.description)).toBe(true);
  });

  it("страница установки двуязычна: словарь ru/en и переключатель", () => {
    const html = read("../install.html");
    expect(html).toContain('id="lang-toggle"');
    // Тот же ключ локали, что у приложения: страница и приложение не спорят
    expect(html).toContain("vershiny-locale");
    for (const text of [
      "Открыть приложение",
      "Open the app",
      "Установить на телефон",
      "Install on this phone",
      "Скопировать адрес для Safari",
      "Copy the address for Safari",
    ]) {
      expect(html).toContain(text);
    }
  });
});
