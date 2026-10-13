import type { DynamicRecord } from '@/client/utils/typeGuards';

const FILES_REF_REGEX = /\/files\/([^?#\s"'\\)]+)/g;
const FILES_PATH_PREFIX = '/files/';

const isPlainObject = (value: unknown): value is DynamicRecord => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
};

const tryParseAbsoluteUrl = (value: string): URL | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.startsWith('/')) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
};

export const normalizeLoopbackFilesUrl = (value: string): string | null => {
  const url = tryParseAbsoluteUrl(value);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;

  const pathname = url.pathname || '';
  if (!pathname.startsWith(FILES_PATH_PREFIX)) return null;
  return `${pathname}${url.search}${url.hash}`;
};

const rewriteLoopbackFilesUrlWithMapping = (
  value: string,
  mapping: Record<string, string>
): string | null => {
  const url = tryParseAbsoluteUrl(value);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;

  const pathname = url.pathname || '';
  if (!pathname.startsWith(FILES_PATH_PREFIX)) return null;
  const fileKey = pathname.slice(FILES_PATH_PREFIX.length);
  if (!fileKey) return null;
  const replacement = mapping[fileKey];
  if (!replacement) return null;
  return `${replacement}${url.search}${url.hash}`;
};

export type FilesRefScanResult = {
  fileKeys: string[];
  byFileKey: Record<string, { originalUrls: string[] }>;
};

export const extractFilesKeysFromString = (value: string): string[] => {
  const keys = new Set<string>();
  FILES_REF_REGEX.lastIndex = 0;
  for (let m = FILES_REF_REGEX.exec(value); m; m = FILES_REF_REGEX.exec(value)) {
    const key = (m[1] ?? '').trim();
    if (!key) continue;
    keys.add(key);
  }
  return [...keys];
};

export const scanFilesReferences = (value: unknown): FilesRefScanResult => {
  const byKey = new Map<string, Set<string>>();

  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      for (const key of extractFilesKeysFromString(node)) {
        const set = byKey.get(key) ?? new Set<string>();
        set.add(node);
        byKey.set(key, set);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (isPlainObject(node)) {
      for (const item of Object.values(node)) {
        visit(item);
      }
    }
  };

  visit(value);

  const fileKeys = [...byKey.keys()];
  const byFileKey: Record<string, { originalUrls: string[] }> = {};
  for (const [key, urls] of byKey) {
    byFileKey[key] = { originalUrls: [...urls] };
  }

  return { fileKeys, byFileKey };
};

export const normalizeLoopbackFilesUrls = <T>(value: T): T => {
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return normalizeLoopbackFilesUrl(node) ?? node;
    }

    if (Array.isArray(node)) {
      return node.map((item) => visit(item));
    }

    if (isPlainObject(node)) {
      const next: DynamicRecord = {};
      for (const [key, val] of Object.entries(node)) {
        next[key] = visit(val);
      }
      return next;
    }

    return node;
  };

  return visit(value) as T;
};

export const rewriteFilesReferencesInString = (
  value: string,
  mapping: Record<string, string>
): string => {
  if (!value || !mapping || Object.keys(mapping).length === 0) return value;

  const rewrittenLoopback = rewriteLoopbackFilesUrlWithMapping(value, mapping);
  if (rewrittenLoopback) {
    return rewrittenLoopback;
  }

  FILES_REF_REGEX.lastIndex = 0;
  return value.replace(FILES_REF_REGEX, (full, key: string) => {
    const replacement = mapping[key];
    return replacement ? replacement : full;
  });
};

export const rewriteFilesReferences = <T>(
  value: T,
  mapping: Record<string, string>
): T => {
  if (!mapping || Object.keys(mapping).length === 0) return value;

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return rewriteFilesReferencesInString(node, mapping);
    }

    if (Array.isArray(node)) {
      return node.map((item) => visit(item));
    }

    if (isPlainObject(node)) {
      const next: DynamicRecord = {};
      for (const [key, val] of Object.entries(node)) {
        next[key] = visit(val);
      }
      return next;
    }

    return node;
  };

  return visit(value) as T;
};

export const extractPathnameFromUrl = (value: string): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  if (trimmed.startsWith('/')) {
    const [pathname] = trimmed.split(/[?#]/);
    return pathname || null;
  }

  try {
    return new URL(trimmed).pathname;
  } catch {
    return null;
  }
};
