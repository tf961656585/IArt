import type { UnknownRecord } from "@/client/utils/typeGuards";

export type TaskOutputMediaCandidate = {
  url: string;
  priority: number;
  sourceKey: string;
};

export type TaskOutputMediaRecordResolution = {
  candidates: TaskOutputMediaCandidate[];
  consumedKeys: string[];
};

export type TaskOutputMediaRecordResolver = {
  id: string;
  resolve: (record: TaskOutputMediaRecordMap) => TaskOutputMediaRecordResolution | null;
};

type TaskOutputMediaRecordMap = UnknownRecord;

type InlineDataPayloadFields = {
  data: unknown | undefined;
  mime_type: unknown | undefined;
  mimeType: unknown | undefined;
};

type InlineDataPayloadRecord = TaskOutputMediaRecordMap & InlineDataPayloadFields;

type TaskOutputMediaInlineDataRecord = TaskOutputMediaRecordMap & {
  inline_data: unknown | undefined;
  inlineData: unknown | undefined;
};

type TaskOutputMediaB64JsonRecord = TaskOutputMediaRecordMap & {
  b64_json: unknown | undefined;
  b64Json: unknown | undefined;
};

const resolverRegistry: TaskOutputMediaRecordResolver[] = [];

export const registerTaskOutputMediaRecordResolver = (resolver: TaskOutputMediaRecordResolver): void => {
  if (!(resolver !== null && resolver !== undefined ? resolver.id : undefined)) return;
  if (resolverRegistry.some((existing) => existing.id === resolver.id)) return;
  resolverRegistry.push(resolver);
};

export const getTaskOutputMediaRecordResolvers = (): TaskOutputMediaRecordResolver[] => {
  return resolverRegistry.slice();
};

export const resolveTaskOutputMediaCandidatesFromRecord = (
  record: TaskOutputMediaRecordMap
): TaskOutputMediaRecordResolution | null => {
  const candidates: TaskOutputMediaCandidate[] = [];
  const consumedKeys = new Set<string>();

  for (const resolver of resolverRegistry) {
    const resolved = resolver.resolve(record);
    if (!resolved) continue;
    for (const candidate of resolved.candidates ?? []) {
      const url = typeof (candidate !== null && candidate !== undefined ? candidate.url : undefined) === 'string' ? candidate.url.trim() : '';
      if (!url) continue;
      candidates.push({ ...candidate, url });
    }
    for (const key of resolved.consumedKeys ?? []) {
      const normalizedKey = typeof key === 'string' ? key.trim() : '';
      if (!normalizedKey) continue;
      consumedKeys.add(normalizedKey);
    }
  }

  if (candidates.length === 0 && consumedKeys.size === 0) return null;
  return { candidates, consumedKeys: [...consumedKeys] };
};

const isRecord = (value: unknown): value is TaskOutputMediaRecordMap => {
  return typeof value === 'object' && value !== null;
};

const toInlineDataPayloadRecord = (value: TaskOutputMediaRecordMap): InlineDataPayloadRecord => {
  return value as InlineDataPayloadRecord;
};

const normalizeMimeType = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const firstPart = trimmed.split(';')[0];
  return firstPart !== undefined ? firstPart.trim() : '';
};

const normalizeBase64Payload = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const sanitized = value.trim().replace(/\s+/g, '');
  if (!sanitized) return null;

  // allow URL-safe base64 and normalize it
  let normalized = sanitized.replace(/-/g, '+').replace(/_/g, '/');

  // base64 should only contain base64 charset + optional padding
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;

  // pad to multiple of 4 (atob requires this)
  const mod = normalized.length % 4;
  if (mod === 1) return null;
  if (mod === 2) normalized += '==';
  if (mod === 3) normalized += '=';

  // padding can only be at the end and at most two chars
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;

  return normalized;
};

const makeInlineDataUrl = (inlineData: unknown): string | null => {
  if (!isRecord(inlineData)) return null;
  const typed = toInlineDataPayloadRecord(inlineData);
  const payload = normalizeBase64Payload(typed.data);
  if (!payload) return null;
  const mimeType =
    normalizeMimeType(typed.mime_type) || normalizeMimeType(typed.mimeType) || 'image/png';
  return `data:${mimeType};base64,${payload}`;
};

const makeB64JsonDataUrl = (b64json: unknown): string | null => {
  const payload = normalizeBase64Payload(b64json);
  if (!payload) return null;
  return `data:image/png;base64,${payload}`;
};

registerTaskOutputMediaRecordResolver({
  id: 'task-output-media.inline-data',
  resolve: (record) => {
    const typedRecord = record as TaskOutputMediaInlineDataRecord;
    const keys: string[] = [];
    const candidates: TaskOutputMediaCandidate[] = [];

    const rawInlineData = typedRecord.inline_data;
    const rawInlineDataCamel = typedRecord.inlineData;
    const inlineData =
      (isRecord(rawInlineData) && rawInlineData) || (isRecord(rawInlineDataCamel) && rawInlineDataCamel);
    if (!inlineData) return null;

    if (rawInlineData) keys.push('inline_data');
    if (rawInlineDataCamel) keys.push('inlineData');

    const url = makeInlineDataUrl(inlineData);
    if (url) {
      candidates.push({ url, priority: 0, sourceKey: keys[0] ?? 'inline_data' });
    }

    return { candidates, consumedKeys: keys };
  },
});

registerTaskOutputMediaRecordResolver({
  id: 'task-output-media.b64-json',
  resolve: (record) => {
    const typedRecord = record as TaskOutputMediaB64JsonRecord;
    const keys: string[] = [];
    const candidates: TaskOutputMediaCandidate[] = [];

    const rawB64Json = typedRecord.b64_json;
    const rawB64JsonCamel = typedRecord.b64Json;
    if (typeof rawB64Json === 'string') keys.push('b64_json');
    if (typeof rawB64JsonCamel === 'string') keys.push('b64Json');
    if (keys.length === 0) return null;

    const url = makeB64JsonDataUrl(rawB64Json ?? rawB64JsonCamel);
    if (url) {
      candidates.push({ url, priority: 0, sourceKey: keys[0] ?? 'b64_json' });
    }

    return { candidates, consumedKeys: keys };
  },
});

registerTaskOutputMediaRecordResolver({
  id: 'task-output-media.url-fields',
  resolve: (record) => {
    const urlKeys = ['url', 'image_url', 'imageUrl', 'src', 'uri'] as const;

    const candidates: TaskOutputMediaCandidate[] = [];
    const consumedKeys: string[] = [];

    for (const key of urlKeys) {
      const raw = record[key];
      if (typeof raw !== 'string') continue;
      const url = raw.trim();
      if (!url) continue;

      consumedKeys.push(key);
      candidates.push({ url, priority: url.startsWith('data:') ? 0 : 1, sourceKey: key });
    }

    if (consumedKeys.length === 0) return null;
    return { candidates, consumedKeys };
  },
});
