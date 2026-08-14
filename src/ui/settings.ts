/**
 * Панель настроек (ROADMAP: выбор региона до выхода, язык, сброс оффсета).
 * Открывается кнопкой ⚙, поверх панорамы.
 */

import { t, getLocale, setLocale, type Locale } from '../core/i18n';
import {
  getCalibration,
  setCalibration,
  resetCalibration,
  CALIBRATION_LIMITS,
  DEFAULT_CAMERA_FOV_DEG,
} from '../core/calibration';
import {
  loadRegions,
  regionLabel,
  regionCore,
  estimateRegionBytes,
  type RegionInfo,
} from './download';
import { getDownloadedRegions } from '../core/db';
import { getPhotoCaption, setPhotoCaption } from '../core/photo-caption';
import { orientationTracker } from '../core/orientation';
import type { LatLon } from '../core/geo';

export interface SettingsCallbacks {
  onRegionChange: (region: string) => void;
  onLocaleChange: () => void;
  onClose: () => void;
  /** Поправки изменены — панораму надо перерисовать */
  onCalibrationChange: () => void;
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

  panel.appendChild(buildCalibration(callbacks.onCalibrationChange));
  panel.appendChild(buildPhotoCaption());

  // --- Регионы: выбор + скачивание (сгруппированные) ---
  const dlTitle = document.createElement('h3');
  dlTitle.textContent = t('regions');
  dlTitle.style.cssText = 'margin:20px 0 8px;font-size:16px;font-weight:600';
  panel.appendChild(dlTitle);

  const dlList = document.createElement('div');
  dlList.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  panel.appendChild(dlList);

  // Загрузка реестра + скачанных. Отметки о скачанном — не повод потерять
  // список: в частном режиме IndexedDB может быть закрыт совсем
  Promise.all([loadRegions(), getDownloadedRegions().catch(() => [])]).then(
    ([regions, downloaded]) => {
      const downloadedSet = new Set(downloaded);

      // Реестр не приехал и в кеше его нет: пустой список выглядел бы так,
      // будто регионов не существует — говорим прямо, в чём дело
      if (Object.keys(regions).length === 0) {
        const note = document.createElement('div');
        note.textContent = t('regionsUnavailable');
        note.style.cssText = 'font-size:12px;color:#e0a458;padding:8px';
        dlList.appendChild(note);
        return;
      }

      // Точный размер каждого региона гоняет тайловую сетку по всем LOD
      // пирамиды. Для 115 регионов сразу это заметный фриз при открытии
      // панели на телефоне — считаем только строки возле видимой области.
      // Через getBoundingClientRect, а не IntersectionObserver: тот молчит
      // в окружениях без регулярной перерисовки, и размеры остались бы
      // навсегда грубой оценкой по площади
      const pendingRows: HTMLElement[] = [];
      const estimateVisible = (): void => {
        const view = panel.getBoundingClientRect();
        for (let i = pendingRows.length - 1; i >= 0; i--) {
          const row = pendingRows[i];
          const box = row.getBoundingClientRect();
          if (box.bottom < view.top - 200 || box.top > view.bottom + 200) continue;
          pendingRows.splice(i, 1);
          (row as HTMLElement & { estimate?: () => void }).estimate?.();
        }
      };
      panel.addEventListener('scroll', estimateVisible, { passive: true });

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
          sizeEl.textContent = `~${size} ${mbUnit()}`;
          sizeEl.style.cssText = 'font-size:11px;color:#a8dadc';
          nameWrap.appendChild(sizeEl);
          // Точный размер требует index.json пирамиды — пока он едет,
          // показываем оценку по площади, чтобы строка не прыгала пустой.
          // Запускается, когда строка появится в видимой части списка
          (rowEl as HTMLElement & { estimate?: () => void }).estimate = () => {
            void estimateRegionBytes(regionInfo, origin)
              .then((bytes) => {
                sizeEl.textContent = formatMB(bytes);
              })
              .catch(() => {});
          };
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
          pendingRows.push(rowEl);
        }
      }

      // Первый экран списка считаем сразу, остальное — по мере прокрутки
      estimateVisible();

      // Обновление подписи текущего региона
      const currentInfo = (regions as Record<string, RegionInfo>)[currentRegion];
      if (currentInfo) {
        regionValue.textContent = regionLabel(currentInfo);
      }
    },
  ).catch((err) => {
    // Единственный оставшийся источник отказа — IndexedDB (частный режим,
    // запрет хранилища): без списка регионов панель бесполезна
    console.warn('Список регионов не построен:', err);
    const note = document.createElement('div');
    note.textContent = t('regionsUnavailable');
    note.style.cssText = 'font-size:12px;color:#e0a458;padding:8px';
    dlList.appendChild(note);
  });

  panel.appendChild(buildAbout());

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

/**
 * «О проекте»: авторство и происхождение данных.
 *
 * Внизу настроек, а не отдельным экраном: заглядывают сюда редко, но
 * заглядывают — понять, чьё это и откуда рельеф с вершинами. Лицензии данных
 * указывать обязательно (ODbL у OpenStreetMap, атрибуция у Copernicus).
 */
function buildAbout(): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:24px;border-top:1px solid #2b3a4d;padding-top:12px';

  const title = document.createElement('h3');
  title.textContent = t('about');
  title.style.cssText = 'margin:0 0 8px;font-size:16px;font-weight:600';
  box.appendChild(title);

  const link = document.createElement('a');
  link.href = 'https://github.com/agran/vershiny';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'github.com/agran/vershiny';
  link.style.cssText = 'color:#4cc9f0;font-size:13px;text-decoration:none;font-weight:500';
  box.appendChild(link);

  const source = document.createElement('div');
  source.textContent = t('aboutSource');
  source.style.cssText = 'color:#8a9ba8;font-size:12px;margin-top:4px';
  box.appendChild(source);

  const data = document.createElement('div');
  data.textContent = t('aboutData');
  data.style.cssText = 'color:#8a9ba8;font-size:12px;margin-top:6px;line-height:1.5';
  box.appendChild(data);

  // Про счётчик — здесь же, рядом с происхождением данных: приложение,
  // которое по умолчанию не подписывает снимок координатами, обязано сказать
  // и о том, что само отправляет наружу
  const counter = document.createElement('div');
  counter.textContent = t('aboutCounter');
  counter.style.cssText = 'color:#8a9ba8;font-size:12px;margin-top:6px;line-height:1.5';
  box.appendChild(counter);

  return box;
}

function row(label: string): HTMLElement {  const div = document.createElement('div');
  div.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;' +
    'margin-bottom:12px;gap:12px';
  const span = document.createElement('span');
  span.textContent = label;
  span.style.cssText = 'color:#a8dadc;flex-shrink:0';
  div.appendChild(span);
  return div;
}

/**
 * Калибровка: три поправки, совмещающие нарисованный горизонт с кадром камеры.
 *
 * Поле зрения стоит первым не случайно — это самая частая причина
 * расхождения, о которой не думают: объектив у каждого телефона свой, и если
 * угол не тот, контуры сойдутся в центре кадра и разъедутся к краям, сколько
 * ни крути азимут. Азимут и наклон подстраиваются прямо свайпом по кадру,
 * здесь они показаны числом — чтобы видеть, что накрутилось, и обнулить.
 */
function buildCalibration(onChange: () => void): HTMLElement {
  const box = document.createElement('div');

  const title = document.createElement('h3');
  title.textContent = t('calibration');
  title.style.cssText = 'margin:20px 0 4px;font-size:16px;font-weight:600';
  box.appendChild(title);

  const hint = document.createElement('div');
  hint.textContent = t('calibrationHint');
  hint.style.cssText = 'color:#8a9ba8;font-size:12px;line-height:1.4;margin-bottom:12px';
  box.appendChild(hint);

  // Автосовмещение по кадру камеры — включено по умолчанию: ручная подгонка
  // ползунками нужна только там, где машине не за что зацепиться
  const autoRow = row(t('autoCalibrateOnStart'));
  const autoInput = document.createElement('input');
  autoInput.type = 'checkbox';
  autoInput.checked = getCalibration().autoCalibrate;
  autoInput.style.cssText = 'width:20px;height:20px;accent-color:#4cc9f0;cursor:pointer';
  autoInput.onchange = () => {
    setCalibration({ autoCalibrate: autoInput.checked });
  };
  autoRow.appendChild(autoInput);
  box.appendChild(autoRow);

  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    format: (v: number) => string,
    onInput: (v: number) => void,
  ): void => {
    const line = row(label);
    const valueEl = document.createElement('span');
    valueEl.textContent = format(value);
    valueEl.style.cssText = 'font-variant-numeric:tabular-nums;min-width:56px;text-align:right';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.cssText = 'flex:1;min-width:0;accent-color:#4cc9f0';
    input.oninput = () => {
      const v = Number(input.value);
      valueEl.textContent = format(v);
      onInput(v);
    };
    line.append(input, valueEl);
    box.appendChild(line);
    sliders.push({ input, valueEl, format });
  };

  const sliders: {
    input: HTMLInputElement;
    valueEl: HTMLElement;
    format: (v: number) => string;
  }[] = [];

  const cal = getCalibration();
  const defaultFov = DEFAULT_CAMERA_FOV_DEG;
  const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`;

  slider(
    t('calibrationFov'),
    CALIBRATION_LIMITS.fovMinDeg,
    CALIBRATION_LIMITS.fovMaxDeg,
    0.5,
    cal.cameraFovDeg ?? defaultFov,
    (v) => `${v.toFixed(1)}°`,
    (v) => {
      setCalibration({ cameraFovDeg: v });
      orientationTracker.applyCalibration();
      onChange();
    },
  );
  slider(
    t('calibrationAzimuth'),
    -180,
    180,
    0.5,
    cal.azimuthDeg,
    signed,
    (v) => {
      setCalibration({ azimuthDeg: v });
      orientationTracker.applyCalibration();
      onChange();
    },
  );
  slider(
    t('calibrationTilt'),
    -CALIBRATION_LIMITS.tiltDeg,
    CALIBRATION_LIMITS.tiltDeg,
    0.5,
    cal.tiltDeg,
    signed,
    (v) => {
      setCalibration({ tiltDeg: v });
      orientationTracker.applyCalibration();
      onChange();
    },
  );

  const resetBtn = document.createElement('button');
  resetBtn.textContent = t('resetOffset');
  resetBtn.style.cssText = btnStyle();
  resetBtn.onclick = () => {
    resetCalibration();
    const fresh = getCalibration();
    const values = [defaultFov, fresh.azimuthDeg, fresh.tiltDeg];
    sliders.forEach((s, i) => {
      s.input.value = String(values[i]);
      s.valueEl.textContent = s.format(values[i]);
    });
    // Сброс возвращает и автосовмещение: без этого на экране оставалась
    // старая галочка, а в хранилище лежало уже другое значение
    autoInput.checked = fresh.autoCalibrate;
    orientationTracker.applyCalibration();
    onChange();
    resetBtn.textContent = '✓';
    setTimeout(() => (resetBtn.textContent = t('resetOffset')), 1500);
  };
  box.appendChild(resetBtn);

  return box;
}

/**
 * Состав подписи на снимке.
 *
 * Обе галочки выключены по умолчанию: снимком делятся, а координаты с
 * точностью до метра и время съёмки — это данные о человеке, а не о горах.
 * Две галочки, а не одна, потому что утекают они по-разному: в отчёте о
 * восхождении дата уместна, а точка стоянки — не всегда.
 */
function buildPhotoCaption(): HTMLElement {
  const box = document.createElement('div');

  const title = document.createElement('h3');
  title.textContent = t('photoCaption');
  title.style.cssText = 'margin:20px 0 4px;font-size:16px;font-weight:600';
  box.appendChild(title);

  const hint = document.createElement('div');
  hint.textContent = t('photoCaptionHint');
  hint.style.cssText = 'color:#8a9ba8;font-size:12px;line-height:1.4;margin-bottom:12px';
  box.appendChild(hint);

  const toggle = (label: string, key: 'place' | 'time'): void => {
    const line = row(label);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = getPhotoCaption()[key];
    input.style.cssText = 'width:20px;height:20px;accent-color:#4cc9f0;cursor:pointer';
    input.onchange = () => setPhotoCaption({ [key]: input.checked });
    line.appendChild(input);
    box.appendChild(line);
  };

  toggle(t('photoCaptionPlace'), 'place');
  toggle(t('photoCaptionTime'), 'time');

  return box;
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

/** Единица объёма по локали: плейсхолдер тоже не должен быть всегда «МБ» */
function mbUnit(): string {
  return getLocale() === 'ru' ? 'МБ' : 'MB';
}

/** Байты → «12 МБ» / «0.8 МБ» с учётом локали */
function formatMB(bytes: number): string {
  const mb = bytes / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} ${mbUnit()}`;
}
