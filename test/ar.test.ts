// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAr } from '../src/ui/ar';

function createStream(readyState: 'live' | 'ended' = 'live'): MediaStream {
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

describe('AR camera resume', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return {
        canvas: this,
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('перепривязывает поток к <video> после возвращения в приложение', async () => {
    const stream = createStream('live');
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    const videoEl = document.createElement('video');
    Object.defineProperty(videoEl, 'srcObject', {
      configurable: true,
      writable: true,
      value: null,
    });
    Object.defineProperty(videoEl, 'playsInline', {
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(videoEl, 'readyState', {
      configurable: true,
      get: () => 2,
    });
    Object.defineProperty(videoEl, 'videoWidth', {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(videoEl, 'videoHeight', {
      configurable: true,
      get: () => 480,
    });
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(videoEl, 'play', {
      configurable: true,
      value: play,
    });
    const pause = vi.fn();
    Object.defineProperty(videoEl, 'pause', {
      configurable: true,
      value: pause,
    });

    const canvas = document.createElement('canvas');
    const session = await startAr(videoEl, canvas, {} as never, {} as never);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(videoEl.srcObject).toBe(stream);

    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(play).toHaveBeenCalledTimes(2);
    expect(videoEl.srcObject).toBe(stream);

    session.stop();
  });
});
