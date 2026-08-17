// @vitest-environment jsdom
/**
 * Принудительная ориентация экрана (core/screen-orientation.ts): выбор
 * запоминается, lock вызывается только когда API доступен, отказы глотаются.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Модуль читает localStorage/screen при вызове, так что окружение можно
// настраивать до импорта на каждый тест через vi.resetModules.

async function fresh() {
  vi.resetModules();
  return import('../src/core/screen-orientation');
}

describe('screen-orientation', () => {
  beforeEach(() => {
    localStorage.clear();
    // В jsdom screen.orientation read-only getter — подменяем через defineProperty
    Object.defineProperty(screen, 'orientation', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('по умолчанию — авто, без localStorage — авто', async () => {
    const m = await fresh();
    expect(m.storedOrientation()).toBe('auto');
  });

  it('запоминает выбор', async () => {
    const m = await fresh();
    m.rememberOrientation('landscape');
    expect(m.storedOrientation()).toBe('landscape');
    m.rememberOrientation('portrait');
    expect(m.storedOrientation()).toBe('portrait');
    m.rememberOrientation('auto');
    expect(m.storedOrientation()).toBe('auto');
  });

  it('мусор в хранилище читается как авто', async () => {
    localStorage.setItem('vershiny-orientation', 'diagonal');
    const m = await fresh();
    expect(m.storedOrientation()).toBe('auto');
  });

  it('canLockOrientation ложно без Fullscreen API', async () => {
    const m = await fresh();
    // jsdom: requestFullscreen у элементов нет
    expect(m.canLockOrientation()).toBe(false);
  });

  /** Подменить screen.orientation (read-only в jsdom) */
  function setOrientation(value: unknown): void {
    Object.defineProperty(screen, 'orientation', {
      value,
      writable: true,
      configurable: true,
    });
  }

  it('canLockOrientation истинно при обоих API', async () => {
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    setOrientation({ type: 'landscape-primary', lock: vi.fn(), unlock: vi.fn() });
    const m = await fresh();
    expect(m.canLockOrientation()).toBe(true);
  });

  it('applyOrientation(auto) снимает запрет и не просит fullscreen', async () => {
    const unlock = vi.fn();
    const lock = vi.fn();
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    setOrientation({ type: 'landscape-primary', lock, unlock });
    const m = await fresh();
    await m.applyOrientation('auto');
    expect(unlock).toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('applyOrientation(landscape) просит fullscreen и запирает', async () => {
    const lock = vi.fn().mockResolvedValue(undefined);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    setOrientation({ type: 'portrait-primary', lock, unlock: vi.fn() });
    const m = await fresh();
    await m.applyOrientation('landscape');
    expect(requestFullscreen).toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('отказ fullscreen/lock глотается: экран остаётся как есть', async () => {
    document.documentElement.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    setOrientation({ type: 'portrait-primary', lock: vi.fn(), unlock: vi.fn() });
    const m = await fresh();
    await expect(m.applyOrientation('landscape')).resolves.toBeUndefined();
  });

  it('effectiveOrientation читает type, без type — форму окна', async () => {
    const m = await fresh();
    setOrientation({ type: 'landscape-secondary' });
    expect(m.effectiveOrientation()).toBe('landscape');
    setOrientation({ type: 'portrait-primary' });
    expect(m.effectiveOrientation()).toBe('portrait');
  });
});
