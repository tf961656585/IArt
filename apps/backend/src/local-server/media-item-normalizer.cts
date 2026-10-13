/**
 * 媒体项归一化 schema 与 parse 函数。
 *
 * 从 request-assembler-runtime.cts 拆出，负责解析媒体相关松散 record。
 */
import { z } from "zod";
import * as loggingModule from "./logging.cts";
import { normalizeString } from "./request-assembler-shared.cts";

const MediaItemRecordSchema = z.object({
  kind: z.unknown(),
  data: z.unknown(),
  mimeType: z.unknown(),
  mime_type: z.unknown(),
  asset_url: z.unknown(),
  assetUrl: z.unknown(),
  url: z.unknown(),
  src: z.unknown(),
}).passthrough();

const LocalMediaSourceRecordSchema = z.object({
  path: z.unknown(),
  local_path: z.unknown(),
  localPath: z.unknown(),
  file_path: z.unknown(),
  filePath: z.unknown(),
}).passthrough();

const RuleConfigRecordSchema = z.object({
  options: z.unknown(),
}).passthrough();

const RuleOptionsRecordSchema = z.object({
  fallback: z.unknown().optional(),
  allowed_values: z.unknown().optional(),
  message: z.unknown().optional(),
  source: z.unknown().optional(),
  max_items: z.unknown().optional(),
  prepend: z.unknown().optional(),
  append: z.unknown().optional(),
  item: z.unknown().optional(),
  skip_if_empty: z.unknown().optional(),
  parts: z.unknown().optional(),
  role: z.unknown().optional(),
  output_shape: z.unknown().optional(),
}).passthrough();

const ContentPartRecordSchema = z.object({
  part_kind: z.unknown(),
  partKind: z.unknown(),
  value: z.unknown(),
  multiple: z.unknown(),
}).passthrough();

const parseMediaItemRecord = (value: unknown) => {
  const result = MediaItemRecordSchema.safeParse(value);
  return result.success ? result.data : null;
};

const parseLocalMediaSourceRecord = (value: unknown) => {
  const result = LocalMediaSourceRecordSchema.safeParse(value);
  return result.success ? result.data : null;
};

const parseRuleConfigRecord = (value: unknown) => {
  const result = RuleConfigRecordSchema.safeParse(value);
  return result.success ? result.data : null;
};

const parseRuleOptionsRecord = (value: unknown) => {
  const result = RuleOptionsRecordSchema.safeParse(value);
  return result.success ? result.data : null;
};

const parseContentPartRecord = (value: unknown) => {
  const result = ContentPartRecordSchema.safeParse(value);
  return result.success ? result.data : null;
};

export type MediaItem =
  | { kind: "string"; value: string }
  | { kind: "inline_data"; data: string; mimeType: string };

const normalizeMediaItems = (
  value: unknown,
  bucket: MediaItem[] = [],
): MediaItem[] => {
  if (value === null || value === undefined) return bucket;
  if (Array.isArray(value)) {
    value.forEach((item) => normalizeMediaItems(item, bucket));
    return bucket;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) bucket.push({ kind: "string", value: trimmed });
    return bucket;
  }
  const mediaItem = parseMediaItemRecord(value);
  if (mediaItem === null) {
    loggingModule.logDebug("[request-assembler-runtime] normalizeMediaItems: unrecognized object discarded", { keys: Object.keys(value as object) });
    return bucket;
  }
  const kind = normalizeString(mediaItem.kind).toLowerCase();
  const data = normalizeString(mediaItem.data);
  const mimeType =
    normalizeString(mediaItem.mimeType) ||
    normalizeString(mediaItem.mime_type);
  if (kind === "inline_data" || (data && mimeType)) {
    bucket.push({
      kind: "inline_data",
      data,
      mimeType: mimeType || "application/octet-stream",
    });
    return bucket;
  }
  const rawUrl = normalizeString(
    mediaItem.asset_url ||
      mediaItem.assetUrl ||
      mediaItem.url ||
      mediaItem.src,
  );
  if (rawUrl) bucket.push({ kind: "string", value: rawUrl });
  return bucket;
};

export {
  MediaItemRecordSchema,
  LocalMediaSourceRecordSchema,
  RuleConfigRecordSchema,
  RuleOptionsRecordSchema,
  ContentPartRecordSchema,
  parseMediaItemRecord,
  parseLocalMediaSourceRecord,
  parseRuleConfigRecord,
  parseRuleOptionsRecord,
  parseContentPartRecord,
  normalizeMediaItems,
};
