/**
 * fetchWithTimeout: таймаут при «мёртвой» сети.
 *
 * Регресс: AbortSignal.timeout отсутствует в Safari < 16 (iOS 15.x), а вызов
 * undefined бросает TypeError СИНХРОННО — до root.fetch, так что .catch()
 * вызывающего кода его не ловит, и загрузка региона умирала с вечным
 * «Загрузка региона…» при живой сети.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../src/core/fetch-timeout";

/** Временно убираем AbortSignal.timeout (эмуляция Safari < 16) */
function withoutAbortSignalTimeout(fn: () => void): void {
  const desc = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
  try {
    fn();
  } finally {
    if (desc) Object.defineProperty(AbortSignal, "timeout", desc);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("использует AbortSignal.timeout, когда он есть", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    await fetchWithTimeout("https://x.test/tile", {}, 1234);
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("без AbortSignal.timeout не бросает и абортит по таймеру", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenSignal = init?.signal;
        return new Response("ok");
      }),
    );
    withoutAbortSignalTimeout(() => {
      // Главное: синхронного броска нет — промис возвращается живым
      const p = fetchWithTimeout("https://x.test/tile", {}, 1000);
      expect(seenSignal).toBeDefined();
      expect(seenSignal?.aborted).toBe(false);
      vi.advanceTimersByTime(999);
      expect(seenSignal?.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(seenSignal?.aborted).toBe(true);
      void p.catch(() => {});
    });
  });

  it("пробрасывает остальные поля init (method) и ставит signal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    await fetchWithTimeout("https://x.test/tile", { method: "POST" }, 2000);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
