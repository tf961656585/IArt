/**
 * Parse a data-URL string into its constituent parts.
 *
 * Returns null if the input is not a valid data URL.
 * The extracted data portion is trimmed; returns null if trimmed data is empty.
 */
import { normalizeString } from '../utils/type-helpers';

type DataUrlParseResult = {
  kind: 'inline_data';
  data: string;
  mimeType: string;
};

export const parseDataUrlSource = (
  raw: unknown,
): DataUrlParseResult | null => {
  const trimmed = normalizeString(raw);
  const commaIndex = trimmed.indexOf(',');
  if (
    !trimmed ||
    !trimmed.toLowerCase().startsWith('data:') ||
    commaIndex < 0
  ) {
    return null;
  }
  const meta = trimmed.slice(5, commaIndex);
  const data = trimmed.slice(commaIndex + 1).trim();
  if (!data) return null;
  const mimeType =
    normalizeString(meta.split(';')[0]) || 'application/octet-stream';
  return { kind: 'inline_data', data, mimeType };
};
