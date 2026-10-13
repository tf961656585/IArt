import { i18nResources } from "./resources";

import type { DynamicRecord } from '@/client/utils/typeGuards';
import { DEFAULT_LOCALE, normalizeLocale } from "./locales";

const resolveNamespaceAndKey = (fullKey: string): { namespace: string; keyPath: string[] } | null => {
  const [namespace, rest] = fullKey.split(":");
  if (!namespace || !rest) {
    return null;
  }
  return { namespace, keyPath: rest.split(".") };
};

const isRecord = (value: unknown): value is DynamicRecord => {
  return typeof value === "object" && value !== null;
};

const getValueFromResource = (resource: unknown, path: string[]): unknown => {
  let current: unknown = resource;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

export const getTranslation = <T = unknown>(locale: string, key: string): T | undefined => {
  const resolved = resolveNamespaceAndKey(key);
  if (!resolved) {
    return undefined;
  }
  const normalized = normalizeLocale(locale);
  const localeResources = i18nResources[normalized];
  if (!localeResources) {
    return undefined;
  }
  const resource = (localeResources as DynamicRecord)[resolved.namespace];
  if (!resource) {
    return undefined;
  }
  return getValueFromResource(resource, resolved.keyPath) as T | undefined;
};

export const getTranslationWithFallback = <T = unknown>(locale: string, key: string): T | undefined => {
  const value = getTranslation<T>(locale, key);
  if (value !== undefined) {
    return value;
  }
  if (locale !== DEFAULT_LOCALE) {
    return getTranslation<T>(DEFAULT_LOCALE, key);
  }
  return undefined;
};
