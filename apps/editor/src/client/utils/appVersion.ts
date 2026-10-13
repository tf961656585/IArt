const APP_VERSION_STORAGE_KEY = 'iarts_app_version';

declare global {
  interface Window {
    __IART_APP_VERSION__: string | undefined;
  }
}

const normalizeVersion = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const getSafeStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

let cachedAppVersion: string | null = null;

export const setRuntimeAppVersion = (value: unknown): string | null => {
  const normalized = normalizeVersion(value);
  cachedAppVersion = normalized;

  if (typeof window !== 'undefined') {
    if (normalized) {
      window.__IART_APP_VERSION__ = normalized;
    } else {
      Reflect.deleteProperty(window, '__IART_APP_VERSION__');
    }
  }

  const storage = getSafeStorage();
  if (storage) {
    try {
      if (normalized) {
        storage.setItem(APP_VERSION_STORAGE_KEY, normalized);
      } else {
        storage.removeItem(APP_VERSION_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }

  return normalized;
};

export const getRuntimeAppVersion = (): string | null => {
  if (cachedAppVersion) return cachedAppVersion;
  if (typeof window === 'undefined') return null;

  const fromWindow = normalizeVersion(window.__IART_APP_VERSION__);
  if (fromWindow) {
    cachedAppVersion = fromWindow;
    return fromWindow;
  }

  const storage = getSafeStorage();
  if (!storage) return null;
  try {
    const stored = normalizeVersion(storage.getItem(APP_VERSION_STORAGE_KEY));
    if (stored) {
      cachedAppVersion = stored;
      return stored;
    }
  } catch {
    // ignore
  }
  return null;
};
