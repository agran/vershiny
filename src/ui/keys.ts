/**
 * Мелочи клавиатуры, общие для всего интерфейса.
 */

/**
 * Идёт ли сейчас ввод текста (или подстройка ползунка) в поле формы.
 *
 * Глобальные горячие клавиши панорамы (WASD, стрелки) висят на `window` и
 * гасят событие через preventDefault. Пока проверки не было, в поиске по карте
 * не набирались слова с буквами w/a/s/d («Washington», «Ushba»), а наблюдатель
 * за спиной у пользователя шагал по 500 м на каждое нажатие; стрелки на
 * ползунках настроек (поле зрения, поправка азимута) не работали по той же
 * причине.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
