import * as path from 'node:path';
import { API_KEY_PREFIX } from './constants.cjs';

const stripApiKeyPrefix = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(API_KEY_PREFIX)) return trimmed;
  return trimmed.slice(API_KEY_PREFIX.length);
};

const ensureApiKeyPrefix = (value: unknown) => {
  const base = stripApiKeyPrefix(value);
  if (!base) return '';
  return `${API_KEY_PREFIX}${base}`;
};

const normalizeApiKey = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return stripApiKeyPrefix(value);
};

const maskApiKeyLabel = (token: unknown) => {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const hasPrefix = lower.startsWith(API_KEY_PREFIX);
  const prefix = hasPrefix ? trimmed.slice(0, API_KEY_PREFIX.length) : '';
  const core = hasPrefix ? trimmed.slice(API_KEY_PREFIX.length) : trimmed;
  if (core.length <= 8) {
    return prefix ? `${prefix}${core}` : core;
  }
  const head = core.slice(0, 4);
  const tail = core.slice(-4);
  const maskedCore = `${head}...${tail}`;
  return prefix ? `${prefix}${maskedCore}` : maskedCore;
};

const parseEnvNumber = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizePort = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed === 0) return 0;
  if (parsed < 1024 || parsed > 65535) return 0;
  return parsed;
};

const normalizePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const normalizeStoragePath = (value: unknown) => {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.isAbsolute(trimmed) ? trimmed : '';
};

type UnknownRecord = Record<string, unknown>;
type DynamicValueMap = Record<string, unknown>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

type JsonObject = {
  [key: string]: JsonValue;
};

const isPlainObject = <Value,>(value: Value): value is Value & UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown) => (isPlainObject(value) ? value : undefined);
const pickString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const pickNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const pickBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const pickIdValue = (value: unknown) => pickNumber(value) ?? pickString(value);
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  isUnknownArray(value) && value.every((item) => typeof item === 'string');

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (isUnknownArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
};

const safeParseJson = (value: unknown): JsonValue | undefined => {
  if (typeof value !== 'string') return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const isJsonObject = (value: unknown): value is JsonObject =>
  isPlainObject(value) && Object.values(value).every(isJsonValue);

const safeParseJsonObject = (value: unknown): JsonObject | undefined => {
  const parsed = safeParseJson(value);
  return isJsonObject(parsed) ? parsed : undefined;
};

export type { UnknownRecord, DynamicValueMap, JsonPrimitive, JsonValue, JsonObject };

export {
  stripApiKeyPrefix,
  ensureApiKeyPrefix,
  normalizeApiKey,
  maskApiKeyLabel,
  parseEnvNumber,
  normalizePort,
  normalizePositiveInt,
  normalizeStoragePath,
  isPlainObject,
  asRecord,
  pickString,
  pickNumber,
  pickBoolean,
  pickIdValue,
  isUnknownArray,
  isStringArray,
  safeParseJson,
  safeParseJsonObject,
};
