// @vitest-environment jsdom
/**
 * `shareUrl`: сначала Web Share, иначе копирование в буфер.
 *
 * Кнопка «Поделиться ссылкой на установку» в настройках должна работать и на
 * телефоне (системный лист), и на десктопе (копирование в буфер обмена).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { shareUrl } from "../src/ui/share";

const URL = "https://agran.github.io/vershiny/install.html";

function stubShare(fn: (data: unknown) => Promise<void>): void {
  Object.defineProperty(navigator, "share", {
    value: fn,
    configurable: true,
  });
}

function stubClipboard(writeText?: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

afterEach(() => {
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { clipboard?: unknown }).clipboard;
  document.body.innerHTML = "";
});

describe("shareUrl", () => {
  it("с Web Share возвращает shared", async () => {
    stubShare(vi.fn().mockResolvedValue(undefined));
    await expect(shareUrl({ title: "Вершины", url: URL })).resolves.toBe(
      "shared",
    );
  });

  it("закрытие системного листа — failed, без копирования", async () => {
    stubShare(
      vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")),
    );
    await expect(shareUrl({ title: "Вершины", url: URL })).resolves.toBe(
      "failed",
    );
  });

  it("сбой Web Share не по вине пользователя — копирует в буфер", async () => {
    stubShare(vi.fn().mockRejectedValue(new Error("share failed")));
    const write = vi.fn().mockResolvedValue(undefined);
    stubClipboard(write);

    await expect(shareUrl({ title: "Вершины", url: URL })).resolves.toBe(
      "copied",
    );
    expect(write).toHaveBeenCalledWith(URL);
  });

  it("без Web Share копирует в буфер", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    stubClipboard(write);

    await expect(shareUrl({ title: "Вершины", url: URL })).resolves.toBe(
      "copied",
    );
    expect(write).toHaveBeenCalledWith(URL);
  });

  it("без Web Share и Clipboard копирует через execCommand", async () => {
    stubClipboard(undefined);
    document.execCommand = vi
      .fn()
      .mockReturnValue(true) as typeof document.execCommand;

    await expect(shareUrl({ title: "Вершины", url: URL })).resolves.toBe(
      "copied",
    );
  });

  it("ничего недоступно — failed", async () => {
    stubClipboard(undefined);
    document.execCommand = vi
      .fn()
      .mockReturnValue(false) as typeof document.execCommand;

    await expect(shareUrl({ title: "Вершины", url: URL })).resolves.toBe(
      "failed",
    );
  });
});
