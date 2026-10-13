/**
 * Shared type helper utilities.
 *
 * Single source of truth for normalizeString, isPlainObject, and looksLikeBase64.
 * All consumers must import from here instead of defining local copies.
 */

/** Coerce an unknown value to a trimmed string; return empty string for non-strings. */
export const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/** Check whether a value is a plain object (not null, not array). */
export const isPlainObject = (value: unknown): value is object =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Heuristic: does the value look like bare base64 (no data: prefix)? Strips whitespace before matching. */
export const looksLikeBase64 = (raw: unknown): boolean => {
  const normalized = normalizeString(raw).replace(/\s+/g, '');
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized) && normalized.length >= 16;
};
