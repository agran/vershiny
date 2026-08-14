/**
 * Поделиться ссылкой: Web Share API, иначе — буфер обмена.
 *
 * Web Share есть на телефонах (iOS 12.2+, Android Chrome 61+) и открывает
 * системный лист «Поделиться». На десктопе его часто нет — тогда копируем
 * ссылку в буфер; для совсем старых браузеров остаётся textarea+execCommand.
 */

export type ShareResult = "shared" | "copied" | "failed";

export async function shareUrl(opts: {
  title: string;
  url: string;
}): Promise<ShareResult> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: opts.title, url: opts.url });
      return "shared";
    } catch (err) {
      // Человек сам закрыл системный лист — это не сбой и не повод копировать
      if (isAbort(err)) return "failed";
      // Лист отказал по другой причине (не поддерживает url и т. п.) — буфер
      return copyOrFail(opts.url);
    }
  }
  return copyOrFail(opts.url);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function copyOrFail(url: string): Promise<ShareResult> {
  try {
    await copyText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Старые браузеры без Clipboard API: textarea + execCommand('copy')
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy unavailable");
}
