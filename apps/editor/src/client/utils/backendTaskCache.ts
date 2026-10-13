export interface BackendTaskCacheEntry {
  taskId: string;
  model: string | undefined;
  prompt: string | undefined;
  createdAt: number;
  updatedAt: number;
  status: string | undefined;
  resolvedAt: number | undefined;
}

const CACHE_STORAGE_KEY = 'iarts_backend_tasks_cache';

const getSafeStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const retireLegacyBackendTaskCache = (): void => {
  const storage = getSafeStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(CACHE_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const upsertBackendTaskCache = (_entry: BackendTaskCacheEntry): void => {
  retireLegacyBackendTaskCache();
};

export const updateBackendTaskCache = (
  _taskId: string,
  _patch: Partial<BackendTaskCacheEntry>
): void => {
  retireLegacyBackendTaskCache();
};
