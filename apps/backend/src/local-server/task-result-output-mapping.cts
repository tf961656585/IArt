import * as taskRecordViewModule from './task-record-view.cts';
import type { ResultOutputMappingView } from './task-record-view.cts';
import { logDebug } from './logging.cts';

type PlainObject = Record<string, unknown>;

type InlineMediaObject = PlainObject & {
  b64_json: unknown | undefined;
  data: unknown | undefined;
  inlineData: unknown | undefined;
  inline_data: unknown | undefined;
  mimeType: unknown | undefined;
  mime_type: unknown | undefined;
  content_type: unknown | undefined;
  contentType: unknown | undefined;
  type: unknown | undefined;
};

type ThoughtPartObject = PlainObject & {
  thought: unknown | undefined;
};

type OutputMappingSource = {
  kind: unknown | undefined;
  path: unknown | undefined;
};

type OutputMappingRule = {
  target: unknown | undefined;
  source: unknown | undefined;
  required: unknown | undefined;
  default_value: unknown | undefined;
};

type MappedTaskOutput = {
  mediaType: 'image' | 'video' | 'audio' | 'text';
  url: string | undefined;
  textValue: string | undefined;
  sourceTarget: string;
};

type TextCollectionContext = {
  pathSegments: string[];
  nested: boolean;
  parentObject: PlainObject | null;
};

const TEXT_VALUE_FIELD_NAMES = new Set([
  'answer',
  'caption',
  'content',
  'description',
  'lyrics',
  'revisedprompt',
  'text',
]);

const SKIPPED_TEXT_FIELD_NAMES = new Set([
  'citationmetadata',
  'finishmessage',
  'finishreason',
  'groundingmetadata',
  'index',
  'inlinedata',
  'mimetype',
  'model',
  'modelversion',
  'promptfeedback',
  'responseid',
  'role',
  'safetyratings',
  'thoughtsignature',
  'usagemetadata',
]);

const MARKDOWN_IMAGE_URL_REGEX = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const isPlainObject = (value: unknown): value is PlainObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
};

const asRecord = (value: unknown): PlainObject => (isPlainObject(value) ? value : {});

const normalizePathSegments = (pathValue: unknown): string[] => {
  const raw = normalizeString(pathValue);
  if (!raw) return [];
  return raw
    .replace(/^\/+/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[\]/g, '.[]')
    .split(/[./]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const normalizeFieldName = (value: string) => value.toLowerCase().replace(/[_-]/g, '');

const readValuesByPath = (source: unknown, pathValue: unknown): unknown[] => {
  const segments = normalizePathSegments(pathValue);
  if (segments.length === 0) return [];
  let current: unknown[] = [source];
  for (const segment of segments) {
    const next: unknown[] = [];
    if (segment === '[]') {
      for (const item of current) {
        if (Array.isArray(item)) next.push(...item);
      }
      current = next;
      continue;
    }
    for (const item of current) {
      if (Array.isArray(item) && /^\d+$/.test(segment)) {
        const value: unknown = item[Number(segment)];
        if (value !== undefined) next.push(value);
        continue;
      }
      if (!isPlainObject(item)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, segment);
      const value: unknown = descriptor !== undefined ? descriptor.value : undefined;
      if (value !== undefined) next.push(value);
    }
    current = next;
  }
  return current;
};

const defaultMimeTypeForMedia = (mediaType: MappedTaskOutput['mediaType']) => {
  if (mediaType === 'image') return 'image/png';
  if (mediaType === 'video') return 'video/mp4';
  if (mediaType === 'audio') return 'audio/mpeg';
  return 'text/plain';
};

const normalizeInlineMimeType = (value: unknown, mediaType: MappedTaskOutput['mediaType']) => {
  const part = normalizeString(value).split(';')[0];
  if (part !== null && part !== undefined) {
    return part.trim() || defaultMimeTypeForMedia(mediaType);
  }
  return defaultMimeTypeForMedia(mediaType);
};

const buildDataUrl = (
  data: unknown,
  mimeType: unknown,
  mediaType: MappedTaskOutput['mediaType'],
) => {
  const normalizedData = normalizeString(data).replace(/\s+/g, '');
  if (!normalizedData) return '';
  const mime = normalizeInlineMimeType(mimeType, mediaType);
  return `data:${mime};base64,${normalizedData}`;
};

const collectMarkdownImageUrls = (value: string, bucket: string[]) => {
  MARKDOWN_IMAGE_URL_REGEX.lastIndex = 0;
  for (const match of value.matchAll(MARKDOWN_IMAGE_URL_REGEX)) {
    const url = normalizeString(match[1]);
    if (url) bucket.push(url);
  }
};

const TYPED_INLINE_MEDIA_TYPES = new Set(['image', 'video', 'audio']);

/**
 * 从内联媒体对象读取显式 mime_type。
 * 顺序：mimeType → mime_type → content_type → contentType。
 * 全部缺失时返回空串，由 buildDataUrl 按目标 mediaType 兜底。
 */
const resolveInlineMimeType = (value: InlineMediaObject): string =>
  normalizeString(value.mimeType) ||
  normalizeString(value.mime_type) ||
  normalizeString(value.content_type) ||
  normalizeString(value.contentType);

/**
 * Interactions 形状的内联媒体块判定：`{ type: "image" | "video" | "audio", data: <base64> }`。
 *
 * Interactions API 的图像产出块只带 data、不带 mime_type；用 type 字段识别它，
 * 让缺 mime_type 的合法媒体块不被当作「无产出」，也避免把任意 `{data: string}`
 * 误判为媒体。
 */
const looksLikeTypedInlineMedia = (value: InlineMediaObject): boolean => {
  if (typeof value.data !== 'string' || !value.data.trim()) return false;
  return TYPED_INLINE_MEDIA_TYPES.has(normalizeString(value.type).toLowerCase());
};

const collectMediaStrings = (
  value: unknown,
  mediaType: MappedTaskOutput['mediaType'],
  bucket: string[] = [],
): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (mediaType === 'image') collectMarkdownImageUrls(trimmed, bucket);
    if (/^https?:\/\//i.test(trimmed) || /^data:[^;,]+;base64,/i.test(trimmed)) {
      bucket.push(trimmed);
    }
    return bucket;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaStrings(item, mediaType, bucket));
    return bucket;
  }
  if (isPlainObject(value)) {
    const mediaRecord = value as InlineMediaObject;
    const explicitMimeType = resolveInlineMimeType(mediaRecord);
    // 缺 mime_type 时按可推断顺序补全：显式 mime 字段 → content_type → 目标 mediaType 默认值。
    // 无显式 mime 时只接受带 media type 字段的内联块（Interactions `{type:"image",data}`）。
    if (
      mediaRecord.data !== undefined &&
      (explicitMimeType || looksLikeTypedInlineMedia(mediaRecord))
    ) {
      const dataUrl = buildDataUrl(
        mediaRecord.data,
        explicitMimeType,
        mediaType,
      );
      if (dataUrl) {
        if (!explicitMimeType) {
          logDebug(
            '[task-result-output-mapping] collectMediaStrings: inline base64 without mime_type, using media type default',
            { mediaType, inlineType: normalizeString(mediaRecord.type) || null },
          );
        }
        bucket.push(dataUrl);
      }
    }
    const inlineData = isPlainObject(mediaRecord.inlineData)
      ? (mediaRecord.inlineData as InlineMediaObject)
      : isPlainObject(mediaRecord.inline_data)
        ? (mediaRecord.inline_data as InlineMediaObject)
        : null;
    if (inlineData) {
      const dataUrl = buildDataUrl(
        inlineData.data,
        inlineData.mimeType ?? inlineData.mime_type,
        mediaType,
      );
      if (dataUrl) bucket.push(dataUrl);
    }
    const b64Json = buildDataUrl(mediaRecord.b64_json, defaultMimeTypeForMedia(mediaType), mediaType);
    if (b64Json) bucket.push(b64Json);
    Object.values(value).forEach((item) => collectMediaStrings(item, mediaType, bucket));
  }
  return bucket;
};

const hasInlineMediaShape = (value: InlineMediaObject) =>
  value.data !== undefined &&
  (value.mimeType !== undefined ||
    value.mime_type !== undefined ||
    looksLikeTypedInlineMedia(value));

const isThoughtPart = (value: ThoughtPartObject | null) => {
  if (!value) return false;
  if (value.thought === true) return true;
  return normalizeString(value.thought).toLowerCase() === 'true';
};

const isSkippedTextField = (key: string, parentObject: PlainObject | null) => {
  const normalized = normalizeFieldName(key);
  if (normalized === 'data') return parentObject ? hasInlineMediaShape(parentObject as InlineMediaObject) : false;
  return SKIPPED_TEXT_FIELD_NAMES.has(normalized);
};

const isSemanticTextField = (key: string) =>
  TEXT_VALUE_FIELD_NAMES.has(normalizeFieldName(key));

const shouldCollectTextString = (context: TextCollectionContext) => {
  const terminal = context.pathSegments.at(-1);
  if (!terminal) return true;
  if (isSkippedTextField(terminal, context.parentObject)) return false;
  if (normalizeFieldName(terminal) === 'text' && isThoughtPart(context.parentObject as ThoughtPartObject | null)) return false;
  if (!context.nested) return true;
  return isSemanticTextField(terminal);
};

const collectTextStrings = (
  value: unknown,
  bucket: string[] = [],
  context: TextCollectionContext = { pathSegments: [], nested: false, parentObject: null },
): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && shouldCollectTextString(context)) bucket.push(trimmed);
    return bucket;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextStrings(item, bucket, { ...context, nested: true, parentObject: null }));
    return bucket;
  }
  if (isPlainObject(value)) {
    if (hasInlineMediaShape(value as InlineMediaObject)) return bucket;
    for (const [key, item] of Object.entries(value)) {
      if (isSkippedTextField(key, value)) continue;
      collectTextStrings(item, bucket, {
        pathSegments: [...context.pathSegments, key],
        nested: true,
        parentObject: value,
      });
    }
  }
  return bucket;
};

const mediaTypeFromTarget = (target: unknown): MappedTaskOutput['mediaType'] | null => {
  const normalized = normalizeString(target).toLowerCase();
  if (normalized === 'output.video_url') return 'video';
  if (normalized === 'output.image_url') return 'image';
  if (normalized === 'output.audio_url') return 'audio';
  if (normalized === 'output.text') return 'text';
  return null;
};

const { readResultOutputMapping } = taskRecordViewModule;

const hasResultOutputMapping = (record: unknown): boolean => {
  const mapping = readResultOutputMapping(record);
  if (!mapping) return false;
  return Array.isArray(mapping.output_mapping_rules) && (mapping.output_mapping_rules as unknown[]).length > 0;
};

const extractMappedTaskOutputs = (params: {
  taskRecord: unknown;
  responseBody: unknown;
}): MappedTaskOutput[] => {
  const mapping: ResultOutputMappingView | null = readResultOutputMapping(params.taskRecord);
  const rawRules = mapping ? mapping.output_mapping_rules : undefined;
  const rules: unknown[] = Array.isArray(rawRules) ? rawRules : [];
  const outputs: MappedTaskOutput[] = [];
  const resolvedTargets = new Set<string>();

  for (const rawRule of rules) {
    const rule = asRecord(rawRule) as OutputMappingRule;
    const target = normalizeString(rule.target);
    const mediaType = mediaTypeFromTarget(target);
    if (!target || !mediaType || resolvedTargets.has(target)) continue;

    const source = asRecord(rule.source) as OutputMappingSource;
    if (normalizeString(source.kind) && normalizeString(source.kind) !== 'response') continue;
    const values = readValuesByPath(params.responseBody, source.path);
    const sourcePathSegments = normalizePathSegments(source.path);
    const resolved = mediaType === 'text'
      ? values.flatMap((value) => collectTextStrings(value, [], {
          pathSegments: sourcePathSegments,
          nested: false,
          parentObject: null,
        }))
      : values.flatMap((value) => collectMediaStrings(value, mediaType));
    const unique = Array.from(new Set(resolved.map((item) => item.trim()).filter(Boolean)));
    if (unique.length === 0) continue;

    resolvedTargets.add(target);
    for (const value of unique) {
      const output: MappedTaskOutput = mediaType === 'text'
        ? { mediaType, textValue: value, url: undefined, sourceTarget: target }
        : { mediaType, url: value, textValue: undefined, sourceTarget: target };
      outputs.push(output);
    }
  }

  return outputs;
};

export {
  type MappedTaskOutput,
  extractMappedTaskOutputs,
  hasResultOutputMapping,
};
