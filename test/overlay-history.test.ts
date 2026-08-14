// @vitest-environment jsdom
/**
 * Системный «назад» и слои поверх панорамы.
 *
 * На телефоне жест «назад» — основной способ выйти откуда угодно. Пока
 * история браузера не знала об открытых настройках и карте, он уводил со
 * страницы: человек, зашедший сменить язык, вылетал из приложения целиком.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pushOverlay, resetOverlayHistory } from "../src/ui/overlay-history";

/** Системный «назад»: браузер снимает запись и сообщает об этом странице */
async function pressBack(): Promise<void> {
  history.back();
  // jsdom доставляет popstate асинхронно; событие подаём сами, чтобы
  // проверять порядок закрытия, а не расторопность окружения
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetOverlayHistory();
  history.replaceState(null, "");
});

describe("слой поверх панорамы и системный «назад»", () => {
  it("«назад» закрывает слой, а не страницу", async () => {
    const close = vi.fn();
    pushOverlay(close);

    await pressBack();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("закрытый слой на «назад» больше не отзывается", async () => {
    // Иначе следующее нажатие «назад» уводило бы со страницы через уже
    // закрытый слой
    const close = vi.fn();
    const release = pushOverlay(close);

    release();
    await pressBack();

    expect(close).not.toHaveBeenCalled();
  });

  it("закрытие крестиком не требует нажать «назад» дважды", () => {
    // Своя запись в истории должна уйти вместе со слоем, иначе первое
    // нажатие «назад» тратится впустую
    const back = vi.spyOn(history, "back");
    const release = pushOverlay(() => {});

    release();

    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it("повторное закрытие безвредно", async () => {
    const close = vi.fn();
    const release = pushOverlay(close);

    release();
    release();
    await pressBack();

    expect(close).not.toHaveBeenCalled();
  });

  it("слои закрываются по одному, сверху вниз", async () => {
    // Ровно случай «карта, а поверх неё поиск»: первый «назад» убирает
    // поиск, второй — карту, и только третий ушёл бы со страницы.
    // Слушатель на каждый слой это ломал: popstate получают все сразу,
    // и одно нажатие закрывало оба
    const order: string[] = [];
    pushOverlay(() => order.push("карта"));
    pushOverlay(() => order.push("поиск"));

    await pressBack();
    expect(order).toEqual(["поиск"]);

    await pressBack();
    expect(order).toEqual(["поиск", "карта"]);
  });

  it("программное закрытие верхнего слоя не закрывает слой под ним", async () => {
    // Ровно сценарий «карта, а поверх неё поиск»: поиск закрылся сам
    // (Escape в поле, выбор вершины), и history.back() из его release()
    // не должен снять карту — она остаётся открытой.
    const order: string[] = [];
    pushOverlay(() => order.push("карта"));
    const releaseSearch = pushOverlay(() => order.push("поиск"));

    releaseSearch(); // не системный «назад», а закрытие слоя самим слоем

    await pressBack(); // popstate, порождённый history.back() внутри releaseSearch
    expect(order).toEqual([]); // карта не закрылась

    await pressBack(); // следующий «назад» — уже карта
    expect(order).toEqual(["карта"]);
  });

  it("чужая запись в истории остаётся нетронутой", () => {
    // Если сверху оказалось что-то не наше, увести человека со страницы
    // хуже, чем оставить лишний шаг назад
    const release = pushOverlay(() => {});
    history.pushState({ "не-наше": true }, "");
    const back = vi.spyOn(history, "back");

    release();

    expect(back).not.toHaveBeenCalled();
    expect(history.state).toEqual({ "не-наше": true });
    back.mockRestore();
  });
});
