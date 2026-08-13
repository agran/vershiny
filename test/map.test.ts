// @vitest-environment jsdom
/**
 * Карта: нажатия на кнопки не должны утекать в перетаскивание.
 *
 * Регресс, ради которого написан тест: кнопки получили SVG-иконки вместо
 * эмодзи, и целью `pointerdown` стал <path> внутри <svg>, а не сама <button>.
 * Карта принимала это за начало перетаскивания, захватывала указатель
 * (setPointerCapture) — и click уходил ей, а не кнопке. «Закрыть», «Моё
 * положение» и «Поиск» переставали работать, а текстовые «＋» и «−» работали:
 * отсюда и ощущение «срабатывает через раз».
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openMap, type MapOptions } from '../src/ui/map';
import { setLocale, t } from '../src/core/i18n';

/** jsdom не умеет захват указателя и не грузит тайлы — нам хватит заглушек */
beforeEach(() => {
  document.body.innerHTML = '';
  setLocale('ru'); // подписи кнопок ищем по названию
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

function open(extra: Partial<MapOptions> = {}): { close: () => void; onClose: () => void } {
  const onClose = vi.fn();
  const close = openMap({
    origin: { lat: 43.3, lon: 42.4 },
    headingRad: 0,
    onPick: vi.fn(),
    search: async () => [],
    onPickPeak: vi.fn(),
    regionTitle: (r) => r,
    onClose,
    ...extra,
  });
  return { close, onClose };
}

/** Нажатие пальцем: как в браузере — pointerdown по иконке, затем click */
function tap(button: HTMLElement): void {
  const icon = button.querySelector('svg, path') ?? button;
  icon.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 30 }),
  );
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const byTitle = (key: string): HTMLButtonElement | null =>
  document.querySelector(`button[title="${t(key as never)}"]`);

describe('кнопки карты', () => {
  it('нажатие по иконке не начинает перетаскивание', () => {
    open();
    const closeBtn = byTitle('close')!;
    const icon = closeBtn.querySelector('path')!;

    icon.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 30 }),
    );
    expect(Element.prototype.setPointerCapture).not.toHaveBeenCalled();
  });

  it('«Закрыть» убирает карту и сообщает об этом наружу', () => {
    const { onClose } = open();
    expect(byTitle('close')).not.toBeNull();

    tap(byTitle('close')!);

    expect(byTitle('close')).toBeNull();
    // Без этого кнопка карты считала бы её открытой, и следующее нажатие
    // уходило бы на «закрытие» уже закрытой карты
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('перетаскивание по самой карте по-прежнему работает', () => {
    open();
    const root = document.body.lastElementChild as HTMLElement;

    root.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }),
    );
    expect(Element.prototype.setPointerCapture).toHaveBeenCalled();
  });

  it('Escape в поиске сворачивает поиск, но не закрывает карту', () => {
    // Событие всплывало до document-слушателя, тот видел уже скрытую панель
    // и закрывал карту следом: одно нажатие сворачивало два уровня, а
    // вернуться к карте было нельзя — она уничтожена
    const { onClose } = open();
    tap(byTitle('searchPeak')!);
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(byTitle('close')).not.toBeNull(); // карта на месте
    expect(onClose).not.toHaveBeenCalled();

    // Второй Escape — уже мимо поля — закрывает саму карту
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byTitle('close')).toBeNull();
  });

  it('ResizeObserver отключается при закрытии карты', () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect = disconnect;
      },
    );
    open();
    tap(byTitle('close')!);
    expect(disconnect).toHaveBeenCalled();
  });
});
