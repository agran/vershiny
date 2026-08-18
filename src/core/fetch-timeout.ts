/**
 * fetch с таймаутом (AbortSignal.timeout — Chrome 103+, Safari 16+).
 *
 * Зачем нужен: при «мёртвой» сети (мобильный интернет, где DNS и TCP SYN
 * проходят, но ответ не приходит — типично для блокированного GitHub Pages)
 * браузерный fetch без таймаута ждёт до TCP-таймаута ОС — 30–60 секунд и
 * дольше. Приложение в это время висит на «Загрузка региона…», хотя в
 * IndexedDB лежат и реестр, и пирамида, и тайлы — надо быстрее уходить
 * в офлайн-режим.
 *
 * AbortSignal.timeout доступен во всех поддерживаемых браузерах (наш минимум
 * — Safari 16.4 из-за DecompressionStream), поэтому без полифилла.
 */

import { root } from "./globals";

/** Таймаут по умолчанию: данные либо приехали за 8 с, либо сеть мёртвая */
export const FETCH_TIMEOUT_MS = 8_000;

/**
 * Таймаут проб наличия (index.json и подобные «есть ли тут» запросы).
 * Отдельно от данных: проба должна быстро отличить «нет файла» (быстрый 404)
 * от «сеть не отвечает» — иначе последовательные цепочки проб умножают
 * 8-секундный таймаут на число кандидатов, и при мёртвой сети старт
 * растягивается на десятки секунд, хотя всё лежит в IndexedDB
 */
export const PROBE_TIMEOUT_MS = 2_500;

export function fetchWithTimeout(
  input: URL | RequestInfo,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  return root.fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
