import { isBase64DataUrl } from './contentCacheService';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import {
  resolveTaskOutputMediaCandidatesFromRecord,
  type TaskOutputMediaCandidate,
} from './taskOutputMediaResolvers';

export type TaskOutputMediaType = 'image' | 'video' | 'audio';

export type TaskOutputMedia = {
  mediaType: TaskOutputMediaType;
  url: string;
  candidates: string[];
};

const VIDEO_EXT_REGEX = /\.(mp4|mov|webm|mkv)(\?|#|$)/i;
const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i;
const AUDIO_EXT_REGEX = /\.(mp3|wav|m4a|aac|flac|ogg)(\?|#|$)/i;
const URL_REGEX = /https?:\/\/[^\s"')]+/gi;

const isRecord = (value: unknown): value is DynamicRecord => typeof value === 'object' && value !== null;

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const toInlineDataCandidateSource = (value: DynamicRecord): InlineDataCandidateSource => {
  return value as InlineDataCandidateSource;
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const tryParseJsonString = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  // 避免对超大文本做 JSON.parse（对 UI 线程不友好）
  if (trimmed.length > 5_000_000) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const normalizePayload = (raw: unknown): unknown => {
  if (typeof raw === 'string') return tryParseJsonString(raw);
  return raw;
};

type ClassifiedMediaUrl = {
  mediaType: TaskOutputMediaType;
  url: string;
};

type InlineDataCandidate = {
  data: unknown | undefined;
  mime_type: unknown | undefined;
  mimeType: unknown | undefined;
};

type InlineDataCandidateSource = {
  data: unknown;
  mime_type: unknown;
  mimeType: unknown;
};

const classifyMediaUrl = (rawUrl: string): ClassifiedMediaUrl | null => {
  const url = normalizeString(rawUrl);
  if (!url) return null;

  if (url.startsWith('data:image/')) return { mediaType: 'image', url };
  if (url.startsWith('data:video/')) return { mediaType: 'video', url };
  if (url.startsWith('data:audio/')) return { mediaType: 'audio', url };

  // 注意：/files/ 可能是图片/视频/音频，必须优先按扩展名判定，避免把 mp4 误判为 image
  if (VIDEO_EXT_REGEX.test(url)) return { mediaType: 'video', url };
  if (AUDIO_EXT_REGEX.test(url)) return { mediaType: 'audio', url };
  if (IMAGE_EXT_REGEX.test(url)) return { mediaType: 'image', url };

  // 兜底：历史上 /files/ 多为图片（且 hash 文件名可能没有扩展名）
  if (url.includes('/files/')) return { mediaType: 'image', url };

  return null;
};

const shouldSkipKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return (
    lower === 'input' ||
    lower === 'inputs' ||
    lower === 'contents' ||
    lower === 'body' ||
    lower === 'thoughtsignature' ||
      key === 'thoughtSignature'
  );
};

const hasDirectMediaCandidates = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return Boolean(classifyMediaUrl(value));
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasDirectMediaCandidates(item));
  }

  if (!isRecord(value)) return false;

  const resolution = resolveTaskOutputMediaCandidatesFromRecord(value);
  return Boolean((resolution !== null && resolution !== undefined && resolution.candidates !== null && resolution.candidates !== undefined ? resolution.candidates.length : undefined));
};

const shouldSkipRawField = (record: DynamicRecord): boolean => {
  const explicitMediaKeys = ['image_url', 'imageUrl', 'images', 'video_url', 'videoUrl', 'videos', 'audio_url', 'audioUrl', 'audios'];
  return explicitMediaKeys.some((key) => hasDirectMediaCandidates(record[key]));
};

const makeInlineDataUrl = (inlineData: unknown): string | null => {
  if (!isRecord(inlineData)) return null;
  const source = toInlineDataCandidateSource(inlineData);
  const record: InlineDataCandidate = {
    data: source.data,
    mime_type: source.mime_type,
    mimeType: source.mimeType,
  };
  const data = normalizeString(record.data);
  if (!data) return null;

  const mimeType =
    normalizeString(record.mime_type) || normalizeString(record.mimeType) || 'image/png';
  const normalized = data.replace(/\s+/g, '');
  if (!normalized) return null;
  return `data:${mimeType};base64,${normalized}`;
};

const makeB64JsonDataUrl = (b64json: unknown): string | null => {
  if (typeof b64json !== 'string') return null;
  const normalized = b64json.trim().replace(/\s+/g, '');
  if (!normalized) return null;
  return `data:image/png;base64,${normalized}`;
};

const pushSingleCandidateOutput = (candidate: string, out: TaskOutputMedia[], seen: Set<string>): void => {
  const classified = classifyMediaUrl(candidate);
  if (!classified) return;
  const key = `${classified.mediaType}:${classified.url}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ ...classified, candidates: [classified.url] });
};

const pushVariantOutput = (params: {
  mediaType: TaskOutputMediaType;
  candidates: TaskOutputMediaCandidate[];
  out: TaskOutputMedia[];
  seen: Set<string>;
}): void => {
  const sorted = params.candidates
    .slice()
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const normalizedCandidates: string[] = [];
  const localSeen = new Set<string>();

  for (const candidate of sorted) {
    const classified = classifyMediaUrl(candidate.url);
    if (!classified) continue;
    if (classified.mediaType !== params.mediaType) continue;
    if (localSeen.has(classified.url)) continue;
    localSeen.add(classified.url);
    normalizedCandidates.push(classified.url);
  }

  if (normalizedCandidates.length === 0) return;

  const [primary] = normalizedCandidates;
  if (!primary) return;
  const primaryKey = `${params.mediaType}:${primary}`;
  if (params.seen.has(primaryKey)) return;

  for (const url of normalizedCandidates) {
    params.seen.add(`${params.mediaType}:${url}`);
  }

  params.out.push({ mediaType: params.mediaType, url: primary, candidates: normalizedCandidates });
};

const collectMediaOutputs = (
  value: unknown,
  out: TaskOutputMedia[],
  depth: number,
  seenObjects: WeakSet<object>,
  seenMedia: Set<string>,
  keyHint: string | undefined
): void => {
  if (depth > 12) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;

    const extractedCandidates: string[] = [];

    if (keyHint === 'b64_json' || keyHint === 'b64Json') {
      const maybeDataUrl = makeB64JsonDataUrl(trimmed);
      if (maybeDataUrl) {
        extractedCandidates.push(maybeDataUrl);
      }
    }

    if (isBase64DataUrl(trimmed) || trimmed.startsWith('/files/') || isHttpUrl(trimmed)) {
      extractedCandidates.push(trimmed);
    }

    // 兼容 Markdown 图片语法：![alt](https://...)
    try {
      const matches = trimmed.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi);
      for (const match of matches) {
        const extracted = (match !== null && match !== undefined ? match[1] : undefined);
        if (!extracted) continue;
        extractedCandidates.push(extracted);
      }
    } catch {
      // ignore
    }

    // 兜底：从文本中抓取 URL
    const urlMatches = trimmed.match(URL_REGEX) ?? [];
    for (const match of urlMatches) {
      if (typeof match !== 'string') continue;
      extractedCandidates.push(match);
    }

    for (const candidate of extractedCandidates) {
      const normalized = normalizeString(candidate);
      if (!normalized) continue;
      pushSingleCandidateOutput(normalized, out, seenMedia);
    }

    return;
  }

  if (!value || typeof value !== 'object') return;
  if (seenObjects.has(value)) return;
  seenObjects.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaOutputs(item, out, depth + 1, seenObjects, seenMedia, keyHint);
    }
    return;
  }

  const record = value as DynamicRecord;
  const recordResolution = resolveTaskOutputMediaCandidatesFromRecord(record);
  const consumedKeys = new Set((recordResolution !== null && recordResolution !== undefined ? recordResolution.consumedKeys : undefined) ?? []);

  if (recordResolution !== null && recordResolution.candidates.length > 0) {
    const groups = new Map<TaskOutputMediaType, TaskOutputMediaCandidate[]>();
    for (const candidate of recordResolution.candidates) {
      const classified = classifyMediaUrl(candidate.url);
      if (!classified) continue;
      const list = groups.get(classified.mediaType) ?? [];
      list.push({ ...candidate, url: classified.url });
      groups.set(classified.mediaType, list);
    }

    for (const [mediaType, candidates] of groups.entries()) {
      pushVariantOutput({ mediaType, candidates, out, seen: seenMedia });
    }
  }

  // inline_data 的 value 本身是一个 record；若未被 resolver 捕获，则在这里兜底转换。
  if ((keyHint === 'inline_data' || keyHint === 'inlineData') && !consumedKeys.has(keyHint)) {
    const inlineUrl = makeInlineDataUrl(record);
    if (inlineUrl) {
      pushSingleCandidateOutput(inlineUrl, out, seenMedia);
    }
  }

  for (const key of Object.keys(record)) {
    if (shouldSkipKey(key)) continue;
    if (key === 'raw' && shouldSkipRawField(record)) continue;
    if (consumedKeys.has(key)) continue;
    collectMediaOutputs(record[key], out, depth + 1, seenObjects, seenMedia, key);
  }
};

/**
 * 从任意 result 中提取“按出现顺序排列”的媒体输出列表。
 * - 仅返回 image/video/audio 三种媒体（文本由上层单独处理）
 * - 尽量跳过 input/inputs/contents/body 等请求输入分支，减少误判
 */
export const extractOrderedMediaOutputs = (raw: unknown): TaskOutputMedia[] => {
  const payload = normalizePayload(raw);
  const results: TaskOutputMedia[] = [];
  const seen = new Set<string>();
  collectMediaOutputs(payload, results, 0, new WeakSet<object>(), seen, undefined);
  return results;
};
