/**
 * Панель настроек (ROADMAP: выбор региона до выхода, язык, сброс оффсета).
 * Открывается кнопкой ⚙, поверх панорамы.
 */

import { t, getLocale, setLocale, type Locale } from '../core/i18n';
import {
  loadRegions,
  regionLabel,
  regionCore,
  estimateRegionBytes,
  type RegionInfo,
} from './download';
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

  // --- Регион (только для информации, выбор — кликом по строке ниже) ---
  const regionRow = row(t('region'));
  const regionValue = document.createElement('span');
  regionValue.textContent = currentRegion;
  regionValue.style.cssText = 'color:#f1faee;font-weight:500';
  regionRow.appendChild(regionValue);
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

  // --- Регионы: выбор + скачивание (сгруппированные) ---
  const dlTitle = document.createElement('h3');
  dlTitle.textContent = t('regions');
  dlTitle.style.cssText = 'margin:20px 0 8px;font-size:16px;font-weight:600';
  panel.appendChild(dlTitle);

  const dlList = document.createElement('div');
  dlList.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  panel.appendChild(dlList);

  // Загрузка реестра + скачанных
  Promise.all([loadRegions(), getDownloadedRegions()]).then(
    ([regions, downloaded]) => {
      const downloadedSet = new Set(downloaded);

      // Группировка по group, внутри — по priority → алфавиту
      const groups = new Map<string, [string, RegionInfo][]>();
      for (const [key, info] of Object.entries(regions)) {
        if (key.startsWith('$') || typeof info !== 'object') continue;
        const group = (info as RegionInfo).group ?? 'Прочее';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group)!.push([key, info as RegionInfo]);
      }

      // Сортировка групп: сначала те, где есть текущий регион, потом по алфавиту
      const sortedGroups = [...groups.entries()].sort(([nameA, itemsA], [nameB, itemsB]) => {
        const hasCurrentA = itemsA.some(([k]) => k === currentRegion);
        const hasCurrentB = itemsB.some(([k]) => k === currentRegion);
        if (hasCurrentA && !hasCurrentB) return -1;
        if (!hasCurrentA && hasCurrentB) return 1;
        return nameA.localeCompare(nameB);
      });

      for (const [groupName, items] of sortedGroups) {
        // Заголовок группы
        const groupHeader = document.createElement('div');
        groupHeader.textContent = groupName;
        groupHeader.style.cssText =
          'font-size:12px;font-weight:600;color:#a8dadc;margin:12px 0 4px;' +
          'text-transform:uppercase;letter-spacing:0.5px';
        dlList.appendChild(groupHeader);

        // Регионы группы
        items.sort(([, a], [, b]) => {
          const pa = a.priority ?? 9;
          const pb = b.priority ?? 9;
          if (pa !== pb) return pa - pb;
          return regionLabel(a).localeCompare(regionLabel(b));
        });

        for (const [key, regionInfo] of items) {
          const isCurrent = key === currentRegion;
          const isDownloaded = downloadedSet.has(key);

          const rowEl = document.createElement('div');
          rowEl.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:6px 8px;' +
            'border-radius:8px;background:#1f2833;' +
            'border:1px solid #415a77;margin-left:8px;cursor:pointer';
          // Клик по строке = выбор активного региона
          rowEl.onclick = () => {
            callbacks.onRegionChange(key);
            close();
          };

          // Название + ключевые вершины + размер
          const nameWrap = document.createElement('div');
          nameWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px';
          const name = document.createElement('span');
          name.textContent = regionLabel(regionInfo);
          name.style.cssText = 'font-size:13px';
          nameWrap.appendChild(name);
          const core = regionCore(regionInfo);
          if (core) {
            const coreEl = document.createElement('span');
            coreEl.textContent = core;
            coreEl.style.cssText = 'font-size:11px;color:#8a9ba8;font-style:italic';
            nameWrap.appendChild(coreEl);
          }
          const size = estimateRegionSizeMB(regionInfo.bbox);
          const sizeEl = document.createElement('span');
          sizeEl.textContent = `~${size} МБ`;
          sizeEl.style.cssText = 'font-size:11px;color:#a8dadc';
          nameWrap.appendChild(sizeEl);
          // Точный размер требует index.json пирамиды — пока он едет,
          // показываем оценку по площади, чтобы строка не прыгала пустой
          void estimateRegionBytes(regionInfo, origin)
            .then((bytes) => {
              sizeEl.textContent = formatMB(bytes);
            })
            .catch(() => {});
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
            btn.onclick = async (ev) => {
              ev.stopPropagation(); // не выбирать регион при клике на скачивание
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

          // Пометка текущего региона — рамка + точка, без заливки
          if (isCurrent) {
            rowEl.style.border = '2px solid #4cc9f0';
            const badge = document.createElement('span');
            badge.textContent = '●';
            badge.style.cssText = 'color:#4cc9f0;font-size:10px';
            rowEl.appendChild(badge);
          }

          dlList.appendChild(rowEl);
        }
      }

      // Обновление подписи текущего региона
      const currentInfo = (regions as Record<string, RegionInfo>)[currentRegion];
      if (currentInfo) {
        regionValue.textContent = regionLabel(currentInfo);
      }
    },
  );

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

/** Грубая оценка по площади bbox — заглушка на те доли секунды, пока не
 *  приедет index.json пирамиды и не посчитается точный размер. */
function estimateRegionSizeMB(bbox: [number, number, number, number]): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latMid = (minLat + maxLat) / 2;
  const lonSpanKm = (maxLon - minLon) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  const latSpanKm = (maxLat - minLat) * 111.32;
  const areaKm2 = Math.abs(lonSpanKm * latSpanKm);
  return Math.max(3, Math.round((areaKm2 / 1000) * 0.0625));
}

/** Байты → «12 МБ» / «0.8 МБ» с учётом локали */
function formatMB(bytes: number): string {
  const mb = bytes / 1e6;
  const unit = getLocale() === 'ru' ? 'МБ' : 'MB';
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} ${unit}`;
}
