/**
 * Глобальный объект окружения с учётом старых браузеров.
 *
 * `globalThis` появился только в Chrome 71 / Safari 12.1 / Firefox 65 —
 * на более старом Android Chrome обращение к нему бросало ReferenceError,
 * и сэмплеры DEM/поиск падали на `fetch.bind(globalThis)` или
 * `globalThis.indexedDB`. `self` есть и в окне, и в воркере с незапамятных
 * времён, поэтому он — надёжный запасной вариант.
 */

export const root: typeof globalThis = (() => {
  if (typeof globalThis !== "undefined") return globalThis;
  return (typeof self !== "undefined" ? self : window) as unknown as typeof globalThis;
})();
