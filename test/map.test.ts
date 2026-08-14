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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../src/core/i18n";
import { openMap, type MapOptions } from "../src/ui/map";
import { resetOverlayHistory } from "../src/ui/overlay-history";

/** jsdom не умеет захват указателя и не грузит тайлы — нам хватит заглушек */
beforeEach(() => {
  document.body.innerHTML = "";
  setLocale("ru"); // подписи кнопок ищем по названию
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // Карта открывает слои в истории; счётчик подавленных popstate должен
  // обнуляться между тестами — иначе «назад» из соседнего теста глотался бы
  resetOverlayHistory();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

function open(extra: Partial<MapOptions> = {}): {
  close: () => void;
  onClose: () => void;
  onHeading: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onHeading = vi.fn();
  const close = openMap({
    origin: { lat: 43.3, lon: 42.4 },
    headingRad: 0,
    onPick: vi.fn(),
    search: async () => [],
    onPickPeak: vi.fn(),
    regionTitle: (r) => r,
    onClose,
    onHeading,
    ...extra,
  });
  return { close, onClose, onHeading };
}

/** Перетаскивание ручки направления: нажали и повели в точку экрана */
function dragHeading(x: number, y: number): void {
  const handle = document.querySelector('[data-role="heading"]') as HTMLElement;
  handle.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: -78 }),
  );
  handle.dispatchEvent(
    new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }),
  );
  handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

/** Нажатие пальцем: как в браузере — pointerdown по иконке, затем click */
function tap(button: HTMLElement): void {
  const icon = button.querySelector("svg, path") ?? button;
  icon.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 30 }),
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const byTitle = (key: string): HTMLButtonElement | null =>
  document.querySelector(`button[title="${t(key as never)}"]`);

describe("кнопки карты", () => {
  it("нажатие по иконке не начинает перетаскивание", () => {
    open();
    const closeBtn = byTitle("close")!;
    const icon = closeBtn.querySelector("path")!;

    icon.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 30,
        clientY: 30,
      }),
    );
    expect(Element.prototype.setPointerCapture).not.toHaveBeenCalled();
  });

  it("«Закрыть» убирает карту и сообщает об этом наружу", () => {
    const { onClose } = open();
    expect(byTitle("close")).not.toBeNull();

    tap(byTitle("close")!);

    expect(byTitle("close")).toBeNull();
    // Без этого кнопка карты считала бы её открытой, и следующее нажатие
    // уходило бы на «закрытие» уже закрытой карты
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("«Закрыть» не переносит наблюдателя: это отказ, а не «Применить»", () => {
    // `onclick = close` передавал обработчику MouseEvent, а тот попадал в
    // первый параметр `commit` — истинный. Крестик работал как «Применить»
    // и уносил человека в центр перекрестия
    const onPick = vi.fn();
    open({ onPick });

    tap(byTitle("close")!);

    expect(onPick).not.toHaveBeenCalled();
  });

  it("Escape тоже отменяет, а не применяет", () => {
    const onPick = vi.fn();
    open({ onPick });

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(byTitle("close")).toBeNull(); // карта закрылась
    expect(onPick).not.toHaveBeenCalled();
  });

  it("«Применить» переносит в центр карты", () => {
    const onPick = vi.fn();
    open({ onPick });

    tap(
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === t("mapApply"),
      )!,
    );

    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("перетаскивание по самой карте по-прежнему работает", () => {
    open();
    const root = document.body.lastElementChild as HTMLElement;

    root.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 100,
        clientY: 100,
      }),
    );
    expect(Element.prototype.setPointerCapture).toHaveBeenCalled();
  });

  it("Escape в поиске сворачивает поиск, но не закрывает карту", () => {
    // Событие всплывало до document-слушателя, тот видел уже скрытую панель
    // и закрывал карту следом: одно нажатие сворачивало два уровня, а
    // вернуться к карте было нельзя — она уничтожена
    const { onClose } = open();
    tap(byTitle("searchPeak")!);
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(byTitle("close")).not.toBeNull(); // карта на месте
    expect(onClose).not.toHaveBeenCalled();

    // Второй Escape — уже мимо поля — закрывает саму карту
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(byTitle("close")).toBeNull();
  });

  it("«назад» закрывает карту, а не приложение", async () => {
    // На телефоне жест «назад» — основной способ выйти откуда угодно. Пока
    // история не знала об открытой карте, он уводил со страницы целиком
    const { onClose } = open();
    expect(byTitle("close")).not.toBeNull();

    window.dispatchEvent(
      new PopStateEvent("popstate", { state: history.state }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(byTitle("close")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("«назад» при открытом поиске убирает сначала поиск", async () => {
    // Два слоя — два нажатия: иначе поиск утаскивал бы за собой карту
    const { onClose } = open();
    tap(byTitle("searchPeak")!);
    expect(document.querySelector("input")).not.toBeNull();

    window.dispatchEvent(
      new PopStateEvent("popstate", { state: history.state }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(byTitle("close")).not.toBeNull(); // карта на месте
    expect(onClose).not.toHaveBeenCalled();

    window.dispatchEvent(
      new PopStateEvent("popstate", { state: history.state }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(byTitle("close")).toBeNull(); // теперь ушла и карта
  });

  it("ResizeObserver отключается при закрытии карты", () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect = disconnect;
      },
    );
    open();
    tap(byTitle("close")!);
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("выбор вершины из поиска", () => {
  const HIT = {
    peak: { name: "Ушба Южная", lat: 43.1, lon: 42.6, ele: 4710 },
    region: "elbrus",
    exact: true,
    typos: 0,
  };

  /** Открыть поиск, найти и выбрать первый результат */
  async function pickFirst(
    onPickPeak: MapOptions["onPickPeak"],
  ): Promise<void> {
    open({ search: async () => [HIT], onPickPeak });
    tap(byTitle("searchPeak")!);
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "Ушба";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const row = Array.from(document.querySelectorAll("button")).find((b) =>
      /Ушба/.test(b.textContent ?? ""),
    )!;
    row.click();
    await new Promise((r) => setTimeout(r, 0));
  }

  it("карта не закрывается: точку обзора можно поправить", async () => {
    // Раньше карта захлопывалась мгновенно, и поправить подобранную точку
    // можно было только вернувшись в неё заново — уже без вершины на виду
    await pickFirst(async () => ({
      origin: { lat: 43.05, lon: 42.55 },
      headingRad: 1,
    }));

    expect(byTitle("close")).not.toBeNull();
    expect(document.body.textContent).toContain("Точка обзора подобрана");
    // Сама вершина подписана на карте: понятно, что именно правишь
    expect(document.body.textContent).toContain("Ушба Южная");
  });

  it("направление и точка приходят из подобранного вида", async () => {
    await pickFirst(async () => ({
      origin: { lat: 43.05, lon: 42.55 },
      headingRad: Math.PI / 2,
    }));

    const cone = document.querySelector('[data-role="heading"]')!.parentElement!
      .firstElementChild as HTMLElement;
    expect(cone.style.transform).toBe("rotate(90deg)");
    // Карта переехала на точку обзора: «Перенестись сюда» берёт центр
    expect(document.body.textContent).toContain("43.0500, 42.5500");
  });

  it("не подобралась — карта остаётся с объяснением", async () => {
    await pickFirst(async () => null);

    expect(byTitle("close")).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Не удалось подобрать точку обзора",
    );
  });
});

describe("направление взгляда на карте", () => {
  it("поворот ручки задаёт азимут: вправо от точки — восток", () => {
    // Экранные оси: x вправо, y вниз, север на карте вверху. jsdom не считает
    // раскладку, поэтому маркер стоит в начале координат
    const { onHeading } = open();
    dragHeading(100, 0);

    expect(onHeading).toHaveBeenCalled();
    expect(onHeading.mock.lastCall![0]).toBeCloseTo(Math.PI / 2, 3);
  });

  it("вверх — север, вниз — юг", () => {
    const { onHeading } = open();
    dragHeading(0, -100);
    expect(onHeading.mock.lastCall![0]).toBeCloseTo(0, 3);

    dragHeading(0, 100);
    expect(onHeading.mock.lastCall![0]).toBeCloseTo(Math.PI, 3);
  });

  it("азимут отдаётся в [0, 2π): запад — это 3π/2, а не −π/2", () => {
    // Отрицательный азимут на панораме считался бы не тем сектором
    const { onHeading } = open();
    dragHeading(-100, 0);
    expect(onHeading.mock.lastCall![0]).toBeCloseTo((3 * Math.PI) / 2, 3);
  });

  it("у самой точки наблюдателя направление не дёргается", () => {
    // Проход пальца через центр иначе крутил бы сектор на 180° рывком
    const { onHeading } = open();
    dragHeading(2, -3);
    expect(onHeading).not.toHaveBeenCalled();
  });

  it("поворот ручки не двигает карту", () => {
    // Ручка лежит на слое тайлов, и событие всплывает до корня карты: без
    // остановки та приняла бы нажатие за начало перетаскивания и уехала
    // вбок вместе с точкой наблюдателя
    open();
    dragHeading(100, 0);
    expect(document.body.textContent ?? "").toContain("43.3000, 42.4000");
  });
});
