// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAr } from "../src/ui/ar";

function createStream(readyState: "live" | "ended" = "live"): MediaStream {
  const track = {
    readyState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
    getSettings: vi.fn(() => ({})),
  } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

/**
 * `<video>` для теста: jsdom не реализует play()/pause()/currentTime, поэтому
 * все нужные поля управляются вручную. `frozen` решает, идёт ли currentTime
 * до первого переприсоединения — это и есть сигнал «кадр идёт» для
 * waitForFrame (requestVideoFrameCallback в jsdom нет, код падает на
 * currentTime-фолбэк). После первого pause() (реальное переприсоединение)
 * currentTime всегда начинает идти — так же, как в жизни чинит сам фикс.
 */
function createVideoEl(options: { frozen: boolean }): {
  videoEl: HTMLVideoElement;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  const videoEl = document.createElement("video");
  let time = 0;
  const pause = vi.fn();
  Object.defineProperty(videoEl, "srcObject", {
    configurable: true,
    writable: true,
    value: null,
  });
  Object.defineProperty(videoEl, "playsInline", {
    configurable: true,
    writable: true,
    value: false,
  });
  Object.defineProperty(videoEl, "readyState", {
    configurable: true,
    get: () => 2,
  });
  Object.defineProperty(videoEl, "videoWidth", {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(videoEl, "videoHeight", {
    configurable: true,
    get: () => 480,
  });
  Object.defineProperty(videoEl, "paused", {
    configurable: true,
    get: () => false,
  });
  Object.defineProperty(videoEl, "currentTime", {
    configurable: true,
    // pause.mock.calls.length > 1: было переприсоединение сверх начального
    // attachStream в startAr — считаем, что оно «вылечило» заморозку
    get: () => (options.frozen && pause.mock.calls.length <= 1 ? 0 : ++time),
  });
  const play = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(videoEl, "play", { configurable: true, value: play });
  Object.defineProperty(videoEl, "pause", { configurable: true, value: pause });
  return { videoEl, play, pause };
}

describe("AR camera resume", () => {
  beforeEach(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        return {
          canvas: this,
          drawImage: vi.fn(),
          fillRect: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
        } as unknown as CanvasRenderingContext2D;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("не трогает живой поток, если кадр приходит вовремя", async () => {
    const stream = createStream("live");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const { videoEl, play } = createVideoEl({ frozen: false });

    const canvas = document.createElement("canvas");
    const session = await startAr(videoEl, canvas, {} as never, {} as never);
    expect(play).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Кадр «шёл» всё это время — переприсоединения (второй play/pause) не было
    expect(play).toHaveBeenCalledTimes(1);

    session.stop();
  });

  it("жёстко переприсоединяет поток, если кадр застыл", async () => {
    const stream = createStream("live");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const { videoEl, play, pause } = createVideoEl({ frozen: true });

    const canvas = document.createElement("canvas");
    const session = await startAr(videoEl, canvas, {} as never, {} as never);
    expect(play).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // currentTime не менялся — детектор счёл кадр застывшим и переподключил
    // поток. pause() дважды: один раз при первом attachStream (в startAr),
    // второй — при переприсоединении после resume()
    expect(pause).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledTimes(2);
    expect(videoEl.srcObject).toBe(stream);

    session.stop();
  });

  it("не переприсоединяет поток дважды при одновременных visibilitychange/focus/pageshow", async () => {
    const stream = createStream("live");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const { videoEl, play } = createVideoEl({ frozen: true });

    const canvas = document.createElement("canvas");
    const session = await startAr(videoEl, canvas, {} as never, {} as never);
    expect(play).toHaveBeenCalledTimes(1);

    // Три сигнала одной и той же разблокировки почти одновременно
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Без защиты от гонок было бы три переприсоединения — с ней ровно одно
    expect(play).toHaveBeenCalledTimes(2);

    session.stop();
  });

  it("видео-слой накладывается на холст, а не течёт под ним в потоке", async () => {
    const stream = createStream("live");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const { videoEl } = createVideoEl({ frozen: false });

    // Холст лежит в #app как статичный блок. Видео-слой в нормальном потоке
    // занял бы верхние 100% высоты и сдвинул холст с контурами за кадр —
    // поэтому он обязан быть absolute поверх той же области, ниже холста
    const app = document.createElement("div");
    const canvas = document.createElement("canvas");
    app.appendChild(canvas);
    document.body.appendChild(app);

    const session = await startAr(videoEl, canvas, {} as never, {} as never);
    const layer = canvas.previousElementSibling as HTMLCanvasElement | null;
    expect(layer).not.toBeNull();
    expect(layer!.style.position).toBe("absolute");
    expect(layer!.style.zIndex).toBe("-1");
    expect(app.children.length).toBe(2); // слой и холст, ничего лишнего

    session.stop();
    expect(app.children.length).toBe(1); // stop() убирает видео-слой
    app.remove();
  });
});
