/**
 * Выбор источника рельефа среди кандидатов.
 *
 * Проверка «есть ли index.json» была чисто сетевой: без связи не проходил ни
 * один кандидат, приложение оставалось на голом Terrarium и падало с
 * «HTTP 503» — при том что пирамида и её тайлы лежали в IndexedDB.
 */

import { describe, it, expect } from 'vitest';
import { demCandidates, pickDemBase, GLOBAL_DEM_URL } from '../src/core/dem-config';

const CANDIDATES = demCandidates('/vershiny/', 'elbrus');

function probes(online: string[], cached: string[]) {
  return {
    online: async (url: string) => online.includes(url),
    cached: async (url: string) => cached.includes(url),
  };
}

describe('выбор источника рельефа', () => {
  it('онлайн берёт самый детальный доступный', async () => {
    expect(await pickDemBase(CANDIDATES, probes([GLOBAL_DEM_URL], []))).toBe(
      GLOBAL_DEM_URL,
    );
    expect(
      await pickDemBase(CANDIDATES, probes(['/vershiny/tiles/global', GLOBAL_DEM_URL], [])),
    ).toBe('/vershiny/tiles/global');
  });

  it('офлайн берёт тот, чей индекс сохранён', async () => {
    expect(await pickDemBase(CANDIDATES, probes([], [GLOBAL_DEM_URL]))).toBe(
      GLOBAL_DEM_URL,
    );
  });

  it('детальный патч из кеша важнее грубой пирамиды из сети', async () => {
    const picked = await pickDemBase(
      CANDIDATES,
      probes([GLOBAL_DEM_URL], ['/vershiny/tiles/elbrus']),
    );
    expect(picked).toBe('/vershiny/tiles/elbrus');
  });

  it('нет ни сети, ни кеша — источника нет', async () => {
    expect(await pickDemBase(CANDIDATES, probes([], []))).toBeUndefined();
  });
});
