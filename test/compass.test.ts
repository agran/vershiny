// @vitest-environment jsdom
/**
 * Доступ к компасу на iOS.
 *
 * Регресс, ради которого написан тест: `requestPermission()` вызывался при
 * загрузке модуля. iOS 13+ отдаёт датчики только из обработчика жеста
 * пользователя, поэтому запрос отклонялся молча — и компас на iPhone не
 * включался вообще никогда, оставался лишь ручной свайп.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { orientationTracker, needsUserGesture, type OrientationState } from '../src/core/orientation';

/** Подмена платформы: iOS-подобный DeviceOrientationEvent с запросом доступа */
function stubIOS(result: string): ReturnType<typeof vi.fn> {
  const requestPermission = vi.fn(async () => result);
  vi.stubGlobal(
    'DeviceOrientationEvent',
    class {
      static requestPermission = requestPermission;
    },
  );
  return requestPermission;
}

afterEach(() => {
  orientationTracker.stop();
  vi.unstubAllGlobals();
});

describe('разрешение на датчики (iOS)', () => {
  it('start() не трогает разрешение сам — ждёт жеста', async () => {
    const requestPermission = stubIOS('granted');
    expect(needsUserGesture()).toBe(true);

    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));

    // Ни одного запроса до нажатия: iOS отклонил бы его молча и навсегда
    expect(requestPermission).not.toHaveBeenCalled();
    // Интерфейс по этому флагу показывает кнопку «Включить компас»
    expect(orientationTracker.needsPermission).toBe(true);
    expect(states.at(-1)?.source).toBe('manual');

    await expect(orientationTracker.requestPermission()).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(orientationTracker.needsPermission).toBe(false);
  });

  it('отказ оставляет ручную подстройку и кнопку на месте', async () => {
    stubIOS('denied');
    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));

    await expect(orientationTracker.requestPermission()).resolves.toBe(false);
    expect(states.at(-1)?.source).toBe('manual');
    // Человек мог отказать случайно — предложение остаётся доступным
    expect(orientationTracker.needsPermission).toBe(true);
  });

  it('на Android разрешение не нужно: слушаем сразу', () => {
    vi.stubGlobal('DeviceOrientationEvent', class {});
    expect(needsUserGesture()).toBe(false);

    const states: OrientationState[] = [];
    orientationTracker.start((s) => states.push({ ...s }));
    expect(orientationTracker.needsPermission).toBe(false);
  });
});
