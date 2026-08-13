/**
 * IndexedDB-хранилище для офлайн-регионов (DATA-PIPELINE: dem-tiles, peaks).
 * Простой KV-интерфейс поверх нативного IndexedDB (без зависимостей).
 */

const DB_NAME = 'vershiny';
const DB_VERSION = 4;
const STORE_TILES = 'dem-tiles';
const STORE_PEAKS = 'peaks';
const STORE_TERRARIUM = 'terrarium';
const STORE_META = 'meta';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // v4: Terrarium-тайлы хранились распакованными во Float32 (256 КБ на
      // тайл) — вчетверо больше исходного PNG. Формат сменился на Int16,
      // старые записи несовместимы, поэтому хранилище пересоздаётся.
      if (ev.oldVersion < 4 && db.objectStoreNames.contains(STORE_TERRARIUM)) {
        db.deleteObjectStore(STORE_TERRARIUM);
      }
      if (!db.objectStoreNames.contains(STORE_TILES)) {
        db.createObjectStore(STORE_TILES);
      }
      if (!db.objectStoreNames.contains(STORE_PEAKS)) {
        db.createObjectStore(STORE_PEAKS);
      }
      if (!db.objectStoreNames.contains(STORE_TERRARIUM)) {
        db.createObjectStore(STORE_TERRARIUM);
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function set(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function keys(store: string): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

// --- Публичный API ---

export interface RegionData {
  name: string;
  downloadedAt: string;
  tileCount: number;
  peakCount: number;
}

/**
 * Сохранить тайл пирамиды как есть — сжатыми байтами (ключ: lod/x/y).
 * Хранить распакованным было бы вчетверо дороже: 128 КБ Int16 против
 * ~34 КБ gzip, а распаковка одного тайла занимает доли миллисекунды.
 */
export async function saveDemTile(key: string, data: Uint8Array): Promise<void> {
  await set(STORE_TILES, key, data);
}

/** Получить сжатый тайл пирамиды из офлайн-хранилища */
export async function getDemTile(key: string): Promise<Uint8Array | undefined> {
  return get<Uint8Array>(STORE_TILES, key);
}

/** Сохранить пики региона */
export async function savePeaks(region: string, peaks: unknown[]): Promise<void> {
  await set(STORE_PEAKS, region, peaks);
}

/** Получить пики региона */
export async function getPeaks(region: string): Promise<unknown[] | undefined> {
  return get<unknown[]>(STORE_PEAKS, region);
}

/** Отметить регион как скачанный */
export async function markRegionDownloaded(region: string): Promise<void> {
  await set(STORE_META, `region:${region}`, {
    downloadedAt: new Date().toISOString(),
  });
}

/** Список скачанных регионов (из метаданных) */
export async function getDownloadedRegions(): Promise<string[]> {
  const metaKeys = await keys(STORE_META);
  return metaKeys
    .filter((k) => k.startsWith('region:'))
    .map((k) => k.replace('region:', ''));
}

/** Оценка места на диске (примерно) */
export async function estimateStorage(): Promise<{ usedMB: number; quotaMB: number }> {
  if (!navigator.storage?.estimate) {
    return { usedMB: 0, quotaMB: 0 };
  }
  const est = await navigator.storage.estimate();
  return {
    usedMB: Math.round((est.usage ?? 0) / 1e6),
    quotaMB: Math.round((est.quota ?? 0) / 1e6),
  };
}

// --- Terrarium (офлайн-кеш глобального слоя) ---

/**
 * Сохранить Terrarium-тайл как есть — байтами PNG (ключ: z/x/y).
 * Распакованная сетка заняла бы 131 КБ (Int16) или 262 КБ (Float32) против
 * ~60 КБ PNG, а декодирование всё равно происходит при каждом сетевом чтении.
 */
export async function saveTerrariumTile(key: string, data: Uint8Array): Promise<void> {
  await set(STORE_TERRARIUM, key, data);
}

/** Получить PNG-байты Terrarium-тайла из офлайн-кеша */
export async function getTerrariumTile(key: string): Promise<Uint8Array | undefined> {
  return get<Uint8Array>(STORE_TERRARIUM, key);
}

/** Ключи Terrarium-тайлов, уже лежащих офлайн (для прогресса загрузки) */
export async function getTerrariumKeys(): Promise<Set<string>> {
  return new Set(await keys(STORE_TERRARIUM));
}

/** Ключи тайлов пирамиды, уже лежащих офлайн */
export async function getDemTileKeys(): Promise<Set<string>> {
  return new Set(await keys(STORE_TILES));
}

/** Кеш index.json пирамиды: без него офлайн-старт невозможен */
export async function saveDemIndex(baseUrl: string, index: unknown): Promise<void> {
  await set(STORE_META, `dem-index:${baseUrl}`, index);
}

export async function getDemIndex(baseUrl: string): Promise<unknown | undefined> {
  return get(STORE_META, `dem-index:${baseUrl}`);
}

/** Удалить регион: пики и отметку о загрузке.
 *  Тайлы пирамиды общие для всех регионов и остаются в кеше. */
export async function deleteRegion(region: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_PEAKS, STORE_META], 'readwrite');
    tx.objectStore(STORE_PEAKS).delete(region);
    tx.objectStore(STORE_META).delete(`region:${region}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
