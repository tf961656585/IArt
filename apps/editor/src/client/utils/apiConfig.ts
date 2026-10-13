// API 配置工具模块
// 负责加载/保存用户 API 偏好（base URL 和 key），构建请求头，并解析端点 URL 以适配配置的 base。
import { getRuntimeBackendBaseUrl } from '@/client/store/runtimeStore';
import { EDITOR_BACKEND_RUNTIME_BOUNDARY } from '@iart/contracts/editor-backend-contract';

export interface ApiPrefs {
  apiBase: string;
  apiKey: string;
}

/** @deprecated wyhj 默认网关已移除，仅历史数据容错保留，阶段6 删除 */
export const DEFAULT_API_BASE = 'https://example.invalid';
export const API_KEY_PREFIX = 'sk-';
const PREFS_STORAGE_KEY = 'iarts_prefs';
const SYSTEM_TOKEN_STORAGE_KEY = 'iarts_system_token';
const LOCAL_API_BASE_STORAGE_KEY = 'iarts_local_api_base';
const REMOTE_API_BASE_STORAGE_KEY = 'iarts_remote_api_base';

declare global {
  interface Window {
    __IART_LOCAL_API_BASE__: string | undefined;
  }
}

const memoryPrefs: ApiPrefs = { apiBase: DEFAULT_API_BASE, apiKey: '' };
let memorySystemToken = '';
let lastResolvedLocalApiBase: string | null = null;

export const EDITOR_BACKEND_BOOTSTRAP_BOUNDARY = EDITOR_BACKEND_RUNTIME_BOUNDARY.bootstrap;

type PrefsStoragePayload = {
  apiKey: string | undefined;
  apiBase: string | undefined;
  username: string | undefined;
  autoSaveHistory: boolean | undefined;
};

const getSafeStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isDesktopRendererRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean((window as Window & { electron: unknown | undefined }).electron);
};

const normalizeLocalApiBase = (value: string | null | undefined): string | null => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }
    if (host !== 'localhost' && host !== '127.0.0.1') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const normalizeRemoteApiBase = (value: string | null | undefined): string | null => {      
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const isLocalhostOrigin = (value: string | null | undefined): boolean => {
  if (!value || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

const readLocalApiBaseOverride = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  if (isDesktopRendererRuntime()) {
    return null;
  }
  const fromWindow = normalizeLocalApiBase(window.__IART_LOCAL_API_BASE__);
  if (fromWindow) {
    return fromWindow;
  }
  const storage = getSafeStorage();
  if (!storage) {
    return null;
  }
  try {
    const stored = storage.getItem(LOCAL_API_BASE_STORAGE_KEY);
    return normalizeLocalApiBase(stored);
  } catch {
    return null;
  }
};

export const readHubBaseFromUrl = (): string | null => normalizeLocalApiBase(getRuntimeBackendBaseUrl());

export const hasLocalHubBaseHint = (): boolean => {
  if (isDesktopRendererRuntime()) {
    return Boolean(readHubBaseFromUrl());
  }
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean(readHubBaseFromUrl()) || Boolean(lastResolvedLocalApiBase) || Boolean(readLocalApiBaseOverride());
};

export const resolvePreferredLocalApiBase = async (options: {
  persist: boolean | undefined;
  allowStoredFallback: boolean | undefined;
} | undefined): Promise<string | null> => {
  const persist = (options !== null && options !== undefined ? options.persist : undefined) !== false;
  const hubBase = readHubBaseFromUrl();
  if (hubBase) {
    lastResolvedLocalApiBase = hubBase;
    if (persist) {
      setLocalApiBase(hubBase);
    }
    return hubBase;
  }

  if (isDesktopRendererRuntime()) {
    return null;
  }

  if ((options !== null && options !== undefined ? options.allowStoredFallback : undefined) === false) {
    return null;
  }

  const stored = readLocalApiBaseOverride();
  lastResolvedLocalApiBase = stored;
  return stored;
};

const joinApiBaseAndEndpoint = (base: string, endpoint: string): string => {
  const trimmedBase = base.trim().replace(/\/$/, '');
  if (!trimmedBase) {
    return endpoint;
  }
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${trimmedBase}${normalizedEndpoint}`;
};

export const resolveLocalApiRequestTarget = async (
  endpoint: string,
  options: {
    allowRelativeFallback: boolean | undefined;
    allowStoredFallback: boolean | undefined;
  } | undefined
): Promise<{
  endpoint: string;
  resolveEndpoint: boolean | undefined;
}> => {
  const allowStoredFallback = options !== null && options !== undefined ? options.allowStoredFallback : undefined;
  const localApiBase = await resolvePreferredLocalApiBase(
    allowStoredFallback === undefined
      ? undefined
      : { persist: undefined, allowStoredFallback }
  );
  if (localApiBase) {
    return {
      endpoint: joinApiBaseAndEndpoint(localApiBase, endpoint),
      resolveEndpoint: false,
    };
  }
  if (hasLocalHubBaseHint()) {
    throw new Error('本地服务暂时不可用，请重新打开项目后重试。');
  }
  if ((options !== null && options !== undefined ? options.allowRelativeFallback : undefined)) {
    return { endpoint, resolveEndpoint: undefined };
  }
  throw new Error('本地服务暂时不可用，请重新打开项目后重试。');
};

export const getRemoteApiBase = (): string => {
  if (typeof window === 'undefined') {
    return DEFAULT_API_BASE;
  }
  const storage = getSafeStorage();
  if (storage) {
    try {
      const stored = storage.getItem(REMOTE_API_BASE_STORAGE_KEY);
      const normalized = normalizeRemoteApiBase(stored);
      if (normalized) {
        return normalized;
      }
    } catch {
      // ignore
    }
  }
  try {
    if (storage) {
      const raw = storage.getItem(PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PrefsStoragePayload;
        const normalized = normalizeRemoteApiBase(parsed.apiBase as string | undefined);
        if (normalized && !isLocalhostOrigin(normalized)) {
          return normalized;
        }
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_API_BASE;
};

const getEffectiveApiBase = (): string => {
  if (isDesktopRendererRuntime()) {
    return readHubBaseFromUrl() ?? DEFAULT_API_BASE;
  }
  const localOverride = readHubBaseFromUrl() ?? lastResolvedLocalApiBase ?? readLocalApiBaseOverride();
  return localOverride ?? DEFAULT_API_BASE;
};

export const getLocalApiBase = (): string | null => {
  if (isDesktopRendererRuntime()) {
    return readHubBaseFromUrl();
  }
  return readHubBaseFromUrl() ?? lastResolvedLocalApiBase ?? readLocalApiBaseOverride();
};

export const isLocalApiBaseActive = (): boolean =>
  isDesktopRendererRuntime() ? Boolean(readHubBaseFromUrl()) : Boolean(readLocalApiBaseOverride());


export const stripApiKeyPrefix = (apiKey: string): string => {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) {
    return '';
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(API_KEY_PREFIX)) {
    return trimmed;
  }
  return trimmed.slice(API_KEY_PREFIX.length);
};

export const ensureApiKeyPrefix = (apiKey: string): string => {
  const base = stripApiKeyPrefix(apiKey);
  if (!base) {
    return '';
  }
  return `${API_KEY_PREFIX}${base}`;
};

export const getStoredSystemToken = (): string => {
  if (memorySystemToken) {
    return memorySystemToken;
  }
  const storage = getSafeStorage();
  if (!storage) {
    return memorySystemToken;
  }
  try {
    const raw = storage.getItem(SYSTEM_TOKEN_STORAGE_KEY);
    if (typeof raw === 'string') {
      memorySystemToken = stripApiKeyPrefix(raw);
    } else {
      memorySystemToken = '';
    }
  } catch (error) {
    console.warn('getStoredSystemToken: fail to read', error);
    memorySystemToken = '';
  }
  return memorySystemToken;
};

export const setStoredSystemToken = (token: string): void => {
  const normalized = stripApiKeyPrefix(typeof token === 'string' ? token : '');
  memorySystemToken = normalized;
  const storage = getSafeStorage();
  if (!storage) {
    return;
  }
  try {
    if (normalized) {
      storage.setItem(SYSTEM_TOKEN_STORAGE_KEY, normalized);
    } else {
      storage.removeItem(SYSTEM_TOKEN_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('setStoredSystemToken: failed to persist system token', error);
  }
};

export const clearStoredSystemToken = (): void => {
  setStoredSystemToken('');
};

export const handleInvalidToken = (): boolean => {
  try {
    clearStoredSystemToken();
  } catch (error) {
    console.warn('handleInvalidToken: failed to clear system token', error);
  }

  try {
    setStoredApiKey('');
  } catch (error) {
    console.warn('handleInvalidToken: failed to clear api key', error);
  }

  return true;
};

export const loadApiPrefs = (): ApiPrefs => {
  const effectiveBase = getEffectiveApiBase();
  const storage = getSafeStorage();
  if (!storage) {
    return { ...memoryPrefs, apiBase: effectiveBase };
  }
  try {
    const raw = storage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PrefsStoragePayload;
      const storedKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : ''; 
      const apiKey = stripApiKeyPrefix(storedKey);
      memoryPrefs.apiBase = effectiveBase;
      memoryPrefs.apiKey = apiKey;
      return { apiBase: effectiveBase, apiKey };
    }
  } catch (error) {
    console.warn('loadApiPrefs: fail to parse prefs', error);
  }
  memoryPrefs.apiBase = effectiveBase;
  memoryPrefs.apiKey = '';
  return { apiBase: effectiveBase, apiKey: '' };
};

/**
 * 判断 API 配置是否完整（base URL 和 key 均非空且已修剪空白）
 * @returns {boolean} true 表示已配置，否则 false
 */
export const isApiConfigured = (): boolean => {
  const prefs = loadApiPrefs();
  return !!(prefs.apiBase.trim() && prefs.apiKey.trim());
};

export const resolveApiEndpoint = (endpoint: string): string => {
  if (!endpoint) return endpoint;
  const trimmed = endpoint.trim();
  const runtimeBase = readHubBaseFromUrl();
  const desktopRuntime = isDesktopRendererRuntime();
  const prefs = loadApiPrefs();
  const base = desktopRuntime
    ? (runtimeBase !== null && runtimeBase !== undefined ? runtimeBase.trim().replace(/\/$/, '') : '')
    : prefs.apiBase
    ? prefs.apiBase.trim().replace(/\/$/, '')
    : '';
  const baseIsLocalhost = isLocalhostOrigin(base);

  // If endpoint is an absolute URL that points to an internal /fal-ai/... route,
  // convert it to use the configured apiBase + pathname so we don't call external queue hosts.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.pathname && u.pathname.startsWith('/fal-ai/')) {
        const pathWithQuery = u.pathname + u.search + u.hash;
        return base ? base + pathWithQuery : pathWithQuery;
      }

      // Hub 模式：兼容历史数据里固化的 localhost:PORT 内部绝对地址。
      // 关键：backend 端口可能变化，直接使用旧端口会导致媒体/接口请求失败。
      if (baseIsLocalhost && u.pathname) {
        const host = u.hostname.toLowerCase();
        const isLoopback = host === 'localhost' || host === '127.0.0.1';
        const isHubPath = u.pathname.startsWith('/files/') || u.pathname.startsWith('/project-media/') || u.pathname.startsWith('/api/');
        if (isLoopback && isHubPath) {
          const pathWithQuery = u.pathname + u.search + u.hash;
          return base ? base + pathWithQuery : pathWithQuery;
        }
      }
    } catch (error) {
      console.warn('resolveApiEndpoint: invalid URL detected', error);
    }
    return trimmed;
  }

  if (trimmed.startsWith('/')) {
    if (desktopRuntime && !base) {
      throw new Error(`desktop runtime backend base unavailable for endpoint: ${trimmed}`);
    }
    return base ? base + trimmed : trimmed;
  }
  // relative without leading slash
  if (desktopRuntime && !base) {
    throw new Error(`desktop runtime backend base unavailable for endpoint: ${trimmed}`);
  }
  return base ? `${base}/${trimmed.replace(/^\//, '')}` : trimmed;
};

export const buildHeaders = (extra: Record<string, string> | undefined = undefined): Record<string, string> => {
  const prefs = loadApiPrefs();
  const skipAuthInHub = isLocalApiBaseActive();
  const normalizedToken = !skipAuthInHub ? ensureApiKeyPrefix(prefs.apiKey) : '';
  const hasAuthorization = Object.keys(extra || {}).some((key) => key.toLowerCase() === 'authorization');
  const authEntry = !hasAuthorization && normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : {};
  return { ...(extra || {}), ...authEntry };
};

const persistPrefs = (prefs: PrefsStoragePayload): void => {
  const storage = getSafeStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch (error) {
    console.warn('persistPrefs: failed to persist api prefs', error);
  }
};

const loadRawPrefs = (): PrefsStoragePayload => {
  const storage = getSafeStorage();
  if (!storage) {
    return {
      apiKey: memoryPrefs.apiKey,
      apiBase: memoryPrefs.apiBase,
      username: undefined,
      autoSaveHistory: undefined,
    };
  }
  try {
    const raw = storage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PrefsStoragePayload;
      return parsed && typeof parsed === 'object'
        ? {
            apiKey: parsed.apiKey,
            apiBase: parsed.apiBase,
            username: parsed.username,
            autoSaveHistory: parsed.autoSaveHistory,
          }
        : {
            apiKey: undefined,
            apiBase: undefined,
            username: undefined,
            autoSaveHistory: undefined,
          };
    }
  } catch (error) {
    console.warn('loadRawPrefs: fail to parse prefs', error);
  }
  return {
    apiKey: undefined,
    apiBase: undefined,
    username: undefined,
    autoSaveHistory: undefined,
  };
};

export const setStoredApiKey = (apiKey: string): void => {
  const normalized = stripApiKeyPrefix(apiKey);
  const effectiveBase = getEffectiveApiBase();
  memoryPrefs.apiBase = effectiveBase;
  memoryPrefs.apiKey = normalized;
  const rawPrefs = loadRawPrefs();
  const nextPrefs: PrefsStoragePayload = {
    ...rawPrefs,
    apiBase: effectiveBase,
    apiKey: ensureApiKeyPrefix(normalized),
  };
  persistPrefs(nextPrefs);
};

export const setLocalApiBase = (apiBase: string | null | undefined): void => {
  if (isDesktopRendererRuntime()) {
    lastResolvedLocalApiBase = readHubBaseFromUrl();
    return;
  }
  const normalized = normalizeLocalApiBase(apiBase);
  lastResolvedLocalApiBase = normalized;
  const storage = getSafeStorage();
  if (storage) {
    try {
      if (normalized) {
        try {
          const rawPrefs = loadRawPrefs();
          const previousBase =
            typeof rawPrefs.apiBase === 'string' ? rawPrefs.apiBase : '';       
          const remoteBase = normalizeRemoteApiBase(previousBase);
          const localBase = normalizeLocalApiBase(previousBase);
          if (remoteBase && !localBase) {
            storage.setItem(REMOTE_API_BASE_STORAGE_KEY, remoteBase);
          } else if (!storage.getItem(REMOTE_API_BASE_STORAGE_KEY)) {
            storage.setItem(REMOTE_API_BASE_STORAGE_KEY, DEFAULT_API_BASE);
          }
        } catch {
          // ignore
        }
        storage.setItem(LOCAL_API_BASE_STORAGE_KEY, normalized);
      } else {
        storage.removeItem(LOCAL_API_BASE_STORAGE_KEY);
      }
    } catch (error) {
      console.warn('setLocalApiBase: failed to persist local api base', error);
    }
  }
  memoryPrefs.apiBase = normalized ?? DEFAULT_API_BASE;
  const rawPrefs = loadRawPrefs();
  const nextPrefs: PrefsStoragePayload = {
    ...rawPrefs,
    apiBase: memoryPrefs.apiBase,
  };
  persistPrefs(nextPrefs);
};
