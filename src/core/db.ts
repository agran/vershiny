/**
 * IndexedDB-хранилище для офлайн-регионов (DATA-PIPELINE: dem-tiles, peaks).
 * Простой KV-интерфейс поверх нативного IndexedDB (без зависимостей).
 */

const DB_NAME = 'vershiny';
const DB_VERSION = 1;
const STORE_TILES = 'dem-tiles';
const STORE_PEAKS = 'peaks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TILES)) {
        db.createObjectStore(STORE_TILES);
      }
      if (!db.objectStoreNames.contains(STORE_PEAKS)) {
        db.createObjectStore(STORE_PEAKS);
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

/** Сохранить тайл региона (ключ: region/lod/x/y) */
export async function saveTile(key: string, data: Int16Array): Promise<void> {
  await set(STORE_TILES, key, data);
}

/** Получить тайл из кеша */
export async function getTile(key: string): Promise<Int16Array | undefined> {
  return get<Int16Array>(STORE_TILES, key);
}

/** Сохранить пики региона */
export async function savePeaks(region: string, peaks: unknown[]): Promise<void> {
  await set(STORE_PEAKS, region, peaks);
}

/** Получить пики региона */
export async function getPeaks(region: string): Promise<unknown[] | undefined> {
  return get<unknown[]>(STORE_PEAKS, region);
}

/** Список скачанных регионов */
export async function getDownloadedRegions(): Promise<string[]> {
  const tileKeys = await keys(STORE_TILES);
  const regions = new Set<string>();
  for (const key of tileKeys) {
    const region = key.split('/')[0];
    if (region) regions.add(region);
  }
  const peakKeys = await keys(STORE_PEAKS);
  for (const key of peakKeys) {
    regions.add(key);
  }
  return [...regions];
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
