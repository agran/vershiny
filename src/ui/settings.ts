/**
 * Панель настроек (ROADMAP: выбор региона до выхода, язык, сброс оффсета).
 * Открывается кнопкой ⚙, поверх панорамы.
 */

import { t, getLocale, setLocale, type Locale } from '../core/i18n';
import { loadRegions, regionLabel, type RegionInfo } from './download';
import { getDownloadedRegions } from '../core/db';
import { orientationTracker } from '../core/orientation';
import type { LatLon } from '../core/geo';

export interface SettingsCallbacks {
  onRegionChange: (region: string) => void;
  onLocaleChange: () => void;
  onClose: () => void;
}

/** Открыть панель настроек. Возвращает функцию закрытия. */
export function openSettings(
  currentRegion: string,
  origin: LatLon,
  callbacks: SettingsCallbacks,
): () => void {
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(13,27,42,0.92);z-index:100;' +
    'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px)';

  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#1a1a2e;border-radius:16px;padding:24px;max-width:420px;' +
    'width:90%;max-height:80vh;overflow-y:auto;color:#f1faee;' +
    'font:14px/1.6 system-ui,sans-serif;position:relative';
  overlay.appendChild(panel);

  // Заголовок
  const title = document.createElement('h2');
  title.textContent = t('settings');
  title.style.cssText = 'margin:0 0 16px;font-size:20px;font-weight:600';
  panel.appendChild(title);

  // --- Язык ---
  const langRow = row(t('language'));
  const langSelect = document.createElement('select');
  langSelect.style.cssText = selectStyle();
  for (const loc of ['ru', 'en'] as Locale[]) {
    const opt = document.createElement('option');
    opt.value = loc;
    opt.textContent = loc === 'ru' ? 'Русский' : 'English';
    if (loc === getLocale()) opt.selected = true;
    langSelect.appendChild(opt);
  }
  langSelect.onchange = () => {
    setLocale(langSelect.value as Locale);
    callbacks.onLocaleChange();
  };
  langRow.appendChild(langSelect);
  panel.appendChild(langRow);

  // --- Регион ---
  const regionRow = row(t('region'));
  const regionSelect = document.createElement('select');
  regionSelect.style.cssText = selectStyle();
  regionRow.appendChild(regionSelect);
  panel.appendChild(regionRow);

  // --- Точность компаса ---
  const accRow = row(t('compassAccuracy'));
  const accValue = document.createElement('span');
  const acc = orientationTracker.current.accuracyDeg;
  accValue.textContent =
    acc >= 0 ? `±${acc.toFixed(0)}°` : t('compassUnknown');
  accRow.appendChild(accValue);
  panel.appendChild(accRow);

  // --- Сброс оффсета ---
  const resetBtn = document.createElement('button');
  resetBtn.textContent = t('resetOffset');
  resetBtn.style.cssText = btnStyle();
  resetBtn.onclick = () => {
    orientationTracker.resetOffset();
    resetBtn.textContent = '✓';
    setTimeout(() => (resetBtn.textContent = t('resetOffset')), 1500);
  };
  panel.appendChild(resetBtn);

  // --- Регионы: выбор + скачивание ---
  const dlTitle = document.createElement('h3');
  dlTitle.textContent = t('regions');
  dlTitle.style.cssText = 'margin:20px 0 8px;font-size:16px;font-weight:600';
  panel.appendChild(dlTitle);

  const dlList = document.createElement('div');
  dlList.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  panel.appendChild(dlList);

  // Загрузка реестра + скачанных
  Promise.all([loadRegions(), getDownloadedRegions()]).then(
    ([regions, downloaded]) => {
      const downloadedSet = new Set(downloaded);

      // Сортировка: приоритет 1 → 2 → 3 → 4, затем по алфавиту
      const entries = Object.entries(regions)
        .filter(([k, v]) => k.startsWith('$') === false && typeof v === 'object')
        .sort(([, a], [, b]) => {
          const pa = (a as RegionInfo & { priority?: number }).priority ?? 9;
          const pb = (b as RegionInfo & { priority?: number }).priority ?? 9;
          if (pa !== pb) return pa - pb;
          return regionLabel(a as RegionInfo).localeCompare(
            regionLabel(b as RegionInfo),
          );
        });

      for (const [key, info] of entries) {
        const regionInfo = info as RegionInfo;
        const isCurrent = key === currentRegion;
        const isDownloaded = downloadedSet.has(key);

        const rowEl = document.createElement('div');
        rowEl.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:6px 8px;' +
          `border-radius:8px;background:${isCurrent ? '#2b4a6f' : '#1f2833'};` +
          'border:1px solid #415a77';

        // Название + размер
        const nameWrap = document.createElement('div');
        nameWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px';
        const name = document.createElement('span');
        name.textContent = regionLabel(regionInfo);
        name.style.cssText = 'font-size:13px';
        nameWrap.appendChild(name);
        const size = estimateRegionSizeMB(regionInfo.bbox);
        const sizeEl = document.createElement('span');
        sizeEl.textContent = `~${size} МБ`;
        sizeEl.style.cssText = 'font-size:11px;color:#a8dadc';
        nameWrap.appendChild(sizeEl);
        rowEl.appendChild(nameWrap);

        // Статус / кнопка скачивания
        const btn = document.createElement('button');
        btn.style.cssText =
          'border:none;border-radius:6px;padding:4px 10px;font-size:12px;' +
          'cursor:pointer;flex-shrink:0';
        if (isDownloaded) {
          btn.textContent = t('downloaded');
          btn.style.background = '#2d6a4f';
          btn.style.color = '#d8f3dc';
          btn.disabled = true;
        } else {
          btn.textContent = t('download');
          btn.style.background = '#415a77';
          btn.style.color = '#f1faee';
          btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = '…';
            try {
              const { downloadRegion } = await import('./download');
              await downloadRegion(key, origin, (p) => {
                if (p.phase === 'tiles') {
                  btn.textContent = `${p.done}/${p.total}`;
                }
              });
              btn.textContent = t('downloaded');
              btn.style.background = '#2d6a4f';
              btn.style.color = '#d8f3dc';
            } catch {
              btn.textContent = '✗';
              btn.style.background = '#e63946';
              setTimeout(() => {
                btn.textContent = t('download');
                btn.style.background = '#415a77';
                btn.disabled = false;
              }, 2000);
            }
          };
        }
        rowEl.appendChild(btn);

        // Пометка текущего региона
        if (isCurrent) {
          const badge = document.createElement('span');
          badge.textContent = '●';
          badge.style.cssText = 'color:#4cc9f0;font-size:10px';
          rowEl.appendChild(badge);
        }

        dlList.appendChild(rowEl);
      }

      // Обновление выпадающего списка
      for (const [key, info] of entries) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = regionLabel(info as RegionInfo);
        if (key === currentRegion) opt.selected = true;
        regionSelect.appendChild(opt);
      }
    },
  );

  regionSelect.onchange = () => {
    callbacks.onRegionChange(regionSelect.value);
  };

  // Кнопка закрытия (✕) — явная, в углу
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = t('close');
  closeBtn.style.cssText =
    'position:absolute;top:12px;right:12px;width:32px;height:32px;' +
    'border:none;border-radius:50%;background:#415a77;color:#f1faee;' +
    'font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center';
  closeBtn.onclick = close;
  panel.appendChild(closeBtn);

  // Закрытие по клику на оверлей
  overlay.onclick = (ev) => {
    if (ev.target === overlay) close();
  };
  document.body.appendChild(overlay);

  function close(): void {
    overlay.remove();
    callbacks.onClose();
  }
  return close;
}

function row(label: string): HTMLElement {
  const div = document.createElement('div');
  div.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;' +
    'margin-bottom:12px;gap:12px';
  const span = document.createElement('span');
  span.textContent = label;
  span.style.cssText = 'color:#a8dadc;flex-shrink:0';
  div.appendChild(span);
  return div;
}

function selectStyle(): string {
  return (
    'background:#2b2d42;color:#f1faee;border:1px solid #415a77;' +
    'border-radius:8px;padding:6px 10px;font-size:14px;flex:1;min-width:0'
  );
}

function btnStyle(): string {
  return (
    'background:#415a77;color:#f1faee;border:none;border-radius:8px;' +
    'padding:8px 16px;font-size:14px;cursor:pointer;margin-top:8px'
  );
}

/** Оценка размера региона для скачивания (пики + DEM-патч).
 *  По DATA-PIPELINE: регион ~400×400 км ≈ 5–15 МБ int16 + brotli.
 *  Считаем по площади bbox с поправкой на широту (меридианы сходятся). */
function estimateRegionSizeMB(bbox: [number, number, number, number]): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latMid = (minLat + maxLat) / 2;
  const lonSpanKm = (maxLon - minLon) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  const latSpanKm = (maxLat - minLat) * 111.32;
  const areaKm2 = lonSpanKm * latSpanKm;
  // База: 400×400 км = 160 000 км² ≈ 10 МБ → 0.0625 МБ на 1000 км²
  const demMB = Math.max(3, Math.round((areaKm2 / 1000) * 0.0625));
  const peaksMB = 0.3; // peaks/{region}.json ≈ 200–500 КБ
  return Math.round((demMB + peaksMB) * 10) / 10;
}
