/**
 * Панель настроек (ROADMAP: выбор региона до выхода, язык, сброс оффсета).
 * Открывается кнопкой ⚙, поверх панорамы.
 */

import { t, getLocale, setLocale, type Locale } from '../core/i18n';
import { loadRegions, regionLabel, type RegionInfo } from './download';
import { getDownloadedRegions } from '../core/db';
import { orientationTracker } from '../core/orientation';

export interface SettingsCallbacks {
  onRegionChange: (region: string) => void;
  onLocaleChange: () => void;
  onClose: () => void;
}

/** Открыть панель настроек. Возвращает функцию закрытия. */
export function openSettings(
  currentRegion: string,
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
    'font:14px/1.6 system-ui,sans-serif';
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

  // --- Скачанные регионы ---
  const dlTitle = document.createElement('h3');
  dlTitle.textContent = t('downloadedRegions');
  dlTitle.style.cssText = 'margin:20px 0 8px;font-size:16px;font-weight:600';
  panel.appendChild(dlTitle);
  const dlList = document.createElement('div');
  dlList.style.cssText = 'font-size:13px;color:#a8dadc';
  panel.appendChild(dlList);

  // Загрузка реестра регионов
  loadRegions().then((regions) => {
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
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = regionLabel(info as RegionInfo);
      if (key === currentRegion) opt.selected = true;
      regionSelect.appendChild(opt);
    }
  });

  regionSelect.onchange = () => {
    callbacks.onRegionChange(regionSelect.value);
  };

  // Список скачанных
  getDownloadedRegions().then((downloaded) => {
    dlList.textContent =
      downloaded.length > 0
        ? downloaded.join(', ')
        : t('noDownloadedRegions');
  });

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
