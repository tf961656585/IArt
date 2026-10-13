import { cloneJsonValue } from "@iart/contracts";

import {
  type ErrorPayload,
  normalizeString,
  isPlainObject,
  readInlineDataPayload,
} from "./common.cts";

const BASE64_PREFIX_LEN = 32;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_STRING_LENGTH = 2000;
const SENSITIVE_MAX_STRING_LENGTH = 800;

const isBase64DataUrl = (value: unknown): boolean =>
  typeof value === "string" &&
  value.startsWith("data:") &&
  value.includes("base64,");

const isProbablyBase64 = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isBase64DataUrl(trimmed)) return true;
  if (trimmed.length < 80) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;

  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length < 80) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
};

const truncateLongString = (value: unknown, maxLen: unknown): unknown => {
  if (typeof value !== "string") return value;
  const limit =
    typeof maxLen === "number" && Number.isFinite(maxLen) && maxLen > 0
      ? Math.floor(maxLen)
      : DEFAULT_MAX_STRING_LENGTH;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
};

const isSensitiveKey = (key: unknown): boolean => {
  const normalized = typeof key === "string" ? key.trim().toLowerCase() : "";
  if (!normalized) return false;
  return (
    normalized.includes("prompt") ||
    normalized.includes("lyrics") ||
    normalized.includes("lyric") ||
    normalized === "text" ||
    normalized.includes("content") ||
    normalized.includes("message")
  );
};

const truncateBase64String = (value: unknown): unknown => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return value;

  if (isBase64DataUrl(trimmed)) {
    const base64Index = trimmed.indexOf("base64,");
    if (base64Index === -1) return value;
    const prefix = trimmed.slice(0, base64Index + "base64,".length);
    const base64 = trimmed
      .slice(base64Index + "base64,".length)
      .replace(/\s+/g, "");
    return `${prefix}${base64.slice(0, BASE64_PREFIX_LEN)}`;
  }

  const compact = trimmed.replace(/\s+/g, "");
  return compact.slice(0, BASE64_PREFIX_LEN);
};

export const sanitizeHeaders = (headers: unknown): unknown => {
  if (!isPlainObject(headers)) return headers;
  const result: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey);
    const lower = key.toLowerCase();
    if (rawValue === undefined || rawValue === null) continue;

    if (
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower.includes("api-key") ||
      lower.includes("apikey") ||
      lower.includes("token")
    ) {
      const str = typeof rawValue === "string" ? rawValue : String(rawValue);
      result[key] =
        str.length <= 16 ? "[redacted]" : `${str.slice(0, 8)}...[redacted]`;
      continue;
    }

    result[key] = typeof rawValue === "string" ? rawValue : String(rawValue);
  }

  return result;
};

const sanitizeValue = (
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (isProbablyBase64(value)) return truncateBase64String(value);
    return truncateLongString(value, DEFAULT_MAX_STRING_LENGTH);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol";
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? value.toString()
      : value.toISOString();
  }
  if (depth >= DEFAULT_MAX_DEPTH) return "[MaxDepth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";

  seen.add(value);

  if (value instanceof Error) {
    const baseErrorPayload = {
      name: normalizeString(value.name) || "Error",
      message: normalizeString(value.message) || String(value),
      stack: typeof value.stack === "string" ? value.stack : null,
      cause: undefined,
    } as ErrorPayload;
    const errorPayload =
      value.cause === undefined
        ? baseErrorPayload
        : {
            ...baseErrorPayload,
            cause: sanitizeValue(value.cause, seen, depth + 1),
          };
    const extraEntries = Object.entries(value)
      .filter(
        ([key]) =>
          key && !Object.prototype.hasOwnProperty.call(errorPayload, key),
      )
      .map(
        ([key, child]) => [key, sanitizeValue(child, seen, depth + 1)] as const,
      );
    return Object.fromEntries([
      ...Object.entries(errorPayload),
      ...extraEntries,
    ]);
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const limit = Math.min(value.length, 100);
    for (let i = 0; i < limit; i += 1) {
      out.push(sanitizeValue(value[i], seen, depth + 1));
    }
    if (limit < value.length) out.push(`[+${value.length - limit} more]`);
    return out;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([key]) => Boolean(key))
      .map(([key, child]) => {
        if (key.toLowerCase().includes("base64") && typeof child === "string") {
          return [key, truncateBase64String(child)] as const;
        }
        if (typeof child === "string" && isSensitiveKey(key)) {
          return [
            key,
            truncateLongString(child, SENSITIVE_MAX_STRING_LENGTH),
          ] as const;
        }
        if (
          (key.toLowerCase() === "authorization" ||
            key.toLowerCase() === "cookie") &&
          (typeof child === "string" || typeof child === "number")
        ) {
          const str = String(child);
          return [
            key,
            str.length <= 16 ? "[redacted]" : `${str.slice(0, 8)}...[redacted]`,
          ] as const;
        }
        return [key, sanitizeValue(child, seen, depth + 1)] as const;
      });
    return Object.fromEntries(entries);
  }

  try {
    return sanitizeValue(cloneJsonValue(value), seen, depth + 1);
  } catch {
    return String(value);
  }
};

export const sanitizePayload = (payload: unknown): unknown =>
  sanitizeValue(payload, new WeakSet<object>(), 0);

const estimateBase64Bytes = (base64: unknown): number => {
  if (typeof base64 !== "string") return 0;
  const trimmed = base64.trim();
  if (!trimmed) return 0;

  const len = trimmed.length;
  let padding = 0;
  if (trimmed.endsWith("==")) padding = 2;
  else if (trimmed.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
};

type InlineDataItem = {
  mimeType: string | null;
  base64Chars: number;
  approxBytes: number;
};

export const extractInlineDataSummary = (payload: unknown): unknown => {
  const items: InlineDataItem[] = [];
  const counts: Record<string, number> = {};
  let totalBase64Chars = 0;
  let totalApproxBytes = 0;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): void => {
    if (items.length >= 50) return;
    if (value === null || value === undefined) return;
    if (depth > DEFAULT_MAX_DEPTH) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
        if (items.length >= 50) return;
      }
      return;
    }

    if (!isPlainObject(value)) return;
    const payloadRecord = readInlineDataPayload(value);
    const inline = readInlineDataPayload((payloadRecord !== null && payloadRecord !== undefined ? payloadRecord.inline_data : undefined));
    if (inline) {
      const mimeType = normalizeString(inline.mime_type) || null;
      const data = typeof inline.data === "string" ? inline.data : null;
      if (data) {
        const base64Chars = data.length;
        const approxBytes = estimateBase64Bytes(data);
        totalBase64Chars += base64Chars;
        totalApproxBytes += approxBytes;
        const mimeKey = mimeType || "application/octet-stream";
        counts[mimeKey] = (counts[mimeKey] ?? 0) + 1;
        items.push({ mimeType, base64Chars, approxBytes });
      }
    }

    for (const child of Object.values(value)) {
      walk(child, depth + 1);
      if (items.length >= 50) return;
    }
  };

  walk(payload, 0);
  if (items.length === 0) return null;

  return {
    count: items.length,
    mimeTypes: Object.keys(counts),
    mimeTypeCounts: counts,
    base64CharsTotal: totalBase64Chars,
    approxBytesTotal: totalApproxBytes,
    items: items.slice(0, 10),
  };
};
