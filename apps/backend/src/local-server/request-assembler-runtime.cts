import fs from "node:fs";
import {
  evaluateRuntimeValueRule as evaluateSharedRuntimeValueRule,
  type ModelAssetRuntimeEvaluationOptions,
} from "@iart/model-asset-runtime";
import * as loggingModule from "./logging.cts";
import {
  isMediaRefPlaceholder,
  looksLikeBase64,
  MEDIA_REF_TRANSPORT,
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
  parseDataUrlSource,
  type MediaRefPlaceholder,
  type MediaRefTransport,
} from "@iart/contracts";
import { MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE, MODEL_ASSET_MEDIA_TARGET_SHAPE } from "@iart/contracts/model-asset-contract";
import {
  invalidArguments,
} from "./errors.cts";
import {
  asProjectionRaw,
  asProjectionRuntimeRaw,
  isPlainObject,
  normalizeString,
  readOpenField,
  type EvaluateState,
  type EvaluationOptions,
  type PlainObject,
  type PreRequestOutputsMap,
  type UploadOptions,
} from "./request-assembler-shared.cts";
import {
  parseRuleConfigRecord,
  parseRuleOptionsRecord,
  parseContentPartRecord,
} from "./media-item-normalizer.cts";
import { resolveImageProcessingSource } from "./image-processing-source-resolver.cts";
import {
  normalizeMediaInputBuckets,
} from "./media-input-bucket-normalizer.cts";

const guessFileExtension = (mimeType: unknown = "") => {
  const lower = normalizeString(mimeType).toLowerCase();
  if (lower === "image/jpeg") return "jpg";
  if (lower === "image/png") return "png";
  if (lower === "image/webp") return "webp";
  if (lower.startsWith("audio/")) return lower.split("/")[1] || "bin";
  if (lower.startsWith("video/")) return lower.split("/")[1] || "bin";
  if (lower.startsWith("image/")) return lower.split("/")[1] || "bin";
  return "bin";
};

const guessMimeTypeFromPath = (filePath: string): string => {
  const ext = filePath.split(".").pop() || "";
  const lower = ext.toLowerCase();
  if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
  if (lower === "png") return "image/png";
  if (lower === "webp") return "image/webp";
  if (lower === "gif") return "image/gif";
  if (lower === "mp3") return "audio/mpeg";
  if (lower === "wav") return "audio/wav";
  if (lower === "mp4") return "video/mp4";
  if (lower === "webm") return "video/webm";
  return "application/octet-stream";
};

const MULTIPART_FILE_UPLOAD_MODE = "multipart_file";

const resolveTransportFromUploadMode = (
  uploadMode: string | undefined,
): MediaRefTransport => {
  if (uploadMode === MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY) {
    return MEDIA_REF_TRANSPORT.PUBLIC_URL;
  }
  if (uploadMode === MULTIPART_FILE_UPLOAD_MODE) {
    return MEDIA_REF_TRANSPORT.MULTIPART_FILE;
  }
  return MEDIA_REF_TRANSPORT.INLINE_DATA;
};

/**
 * media_target 枚举 → transport 枚举。
 *
 * 只映射语义一一对应的三个形态（public_url / multipart_file / inline_data）；
 * FILE_DATA_URI 等其余形态不直接对应单一 transport，返回 undefined 交由 uploadOptions fallback。
 *
 * 与 resolveTransportFromUploadMode 的区别：这里输入是嵌套规则上的 media_target 声明
 * （seedance 式 pack 在 map_array/field.extractUrls 上声明），不经过 resolveUploadUrlOptions。
 */
const resolveTransportFromMediaTarget = (
  mediaTarget: string | undefined,
): MediaRefTransport | undefined => {
  if (mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.PUBLIC_URL) {
    return MEDIA_REF_TRANSPORT.PUBLIC_URL;
  }
  if (mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.MULTIPART_FILE) {
    return MEDIA_REF_TRANSPORT.MULTIPART_FILE;
  }
  if (mediaTarget === MODEL_ASSET_MEDIA_TARGET_SHAPE.INLINE_DATA) {
    return MEDIA_REF_TRANSPORT.INLINE_DATA;
  }
  return undefined;
};

const resolveUploadUrlOptions = (
  projection: PlainObject,
  targetPath: string,
  payloadFormat: string | undefined,
): UploadOptions => {
  const projectionRaw = asProjectionRaw(projection);
  const runtime = asProjectionRuntimeRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.runtime : undefined));
  const uploadMode = normalizeString((runtime !== null && runtime !== undefined ? runtime.url_input_upload_mode : undefined));
  const targetType = normalizeString((runtime !== null && runtime !== undefined ? runtime.url_input_upload_target_type : undefined));
  if (uploadMode === MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY) {
    const options: UploadOptions = { fieldPath: targetPath, uploadMode, targetType };
    return options;
  }
  if (payloadFormat === "multipart") {
    const options: UploadOptions = {
      fieldPath: targetPath,
      uploadMode: MULTIPART_FILE_UPLOAD_MODE,
      targetType: MULTIPART_FILE_UPLOAD_MODE,
    };
    return options;
  }
  const options: UploadOptions = { fieldPath: targetPath, uploadMode: undefined, targetType: undefined };
  return options;
};

const resolveUploadUrlOptionsFromContext = (
  state: EvaluateState,
  targetPath: unknown,
): UploadOptions => {
  // 优先读 state.runtime.payloadFormat（请求构造期求值 payload_format_rule 的结果），
  // fallback 到 projection.runtime.payload_format（静态声明）。
  // 这层兜底保证 build_content_blocks 等内部 operator 在 payload_format_rule 路径上也能拿到正确 transport。
  const stateRuntimePayloadFormat = normalizeString(readOpenField(state.runtime, "payloadFormat"));
  const projectionRaw = asProjectionRaw(state.projection);
  const runtime = asProjectionRuntimeRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.runtime : undefined));
  const payloadFormat = stateRuntimePayloadFormat || normalizeString((runtime !== null && runtime !== undefined ? runtime.payload_format : undefined));
  return resolveUploadUrlOptions(
    state.projection,
    normalizeString(targetPath) || "body.contents",
    payloadFormat || undefined,
  );
};

const toInlineDataPart = (
  item: MediaRefPlaceholder,
  state: EvaluateState,
  options: UploadOptions,
) => {
  void options;
  const source = item.source;
  if (source.kind === "inline_data") {
    return { inline_data: { mime_type: source.mimeType || item.mimeType || "application/octet-stream", data: source.data } };
  }
  // source.kind === "url"
  if (/^https?:\/\//i.test(source.url)) {
    throw new Error(
      `Cannot convert MediaRefPlaceholder with remote url source to inline_data: url=${source.url}`,
    );
  }
  const projectPath = state.projectPath;
  if (projectPath === null || projectPath === undefined) {
    throw new Error(
      `Cannot resolve local url source without projectPath: url=${source.url}`,
    );
  }
  const resolved = resolveImageProcessingSource(projectPath, source.url);
  if (!fs.existsSync(resolved.sourceFilePath)) {
    throw new Error(
      `Local media file not found: ${resolved.sourceFilePath} (source url=${source.url})`,
    );
  }
  const fileBuffer = fs.readFileSync(resolved.sourceFilePath);
  const base64Data = fileBuffer.toString("base64");
  const mimeType = item.mimeType || guessMimeTypeFromPath(resolved.sourceFilePath);
  return { inline_data: { mime_type: mimeType, data: base64Data } };
};

/**
 * 由 mime_type 推断 Interactions 输入条目的 type 字段。
 *
 * Interactions API 的 input[] 条目用 `type` 区分内容种类（text/image/audio/video）。
 * 未知 mime 前缀按 image 兜底并留 debug 日志（条件跳过必须留痕）。
 */
const inferInteractionsEntryType = (mimeType: string): string => {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("video/")) return "video";
  loggingModule.logDebug(
    "[request-assembler-runtime] inferInteractionsEntryType: unrecognized mime_type, defaulting to image",
    { mimeType },
  );
  return "image";
};

/**
 * Gemini Interactions 形状转换：把 generateContent 形状的 part 转为扁平条目。
 *
 * - `{ text }` → `{ type: "text", text }`
 * - `{ inline_data: { mime_type, data } }` → `{ type, mime_type, data }`
 *
 * 未识别的 part 形状原样透传并留 debug 日志，避免静默丢字段。
 */
const toInteractionsInputEntry = (part: unknown): unknown => {
  if (!isPlainObject(part)) {
    loggingModule.logDebug(
      "[request-assembler-runtime] toInteractionsInputEntry: non-object content part passed through",
      { partType: typeof part },
    );
    return part;
  }
  const text = readOpenField(part, "text");
  if (typeof text === "string") {
    return { type: "text", text };
  }
  const inlineData = readOpenField(part, "inline_data");
  if (isPlainObject(inlineData)) {
    const mimeType =
      normalizeString(readOpenField(inlineData, "mime_type")) ||
      normalizeString(readOpenField(inlineData, "mimeType")) ||
      "application/octet-stream";
    return {
      type: inferInteractionsEntryType(mimeType),
      mime_type: mimeType,
      data: normalizeString(readOpenField(inlineData, "data")),
    };
  }
  loggingModule.logDebug(
    "[request-assembler-runtime] toInteractionsInputEntry: unrecognized content part passed through",
    { keys: Object.keys(part) },
  );
  return part;
};

/** 直接从输入值构建 MediaRefPlaceholder，不经 MediaItem 中间格式 */
const MEDIA_REF_MARKER = { __media_ref__: true as const };
const buildMediaRefPlaceholders = (
  value: unknown,
  uploadOptions: UploadOptions | undefined,
  explicitTransport?: MediaRefTransport,
): MediaRefPlaceholder[] => {
  const transport = explicitTransport !== undefined
    ? explicitTransport
    : resolveTransportFromUploadMode(uploadOptions !== undefined ? uploadOptions.uploadMode : undefined);
  const fieldPath = uploadOptions !== undefined ? uploadOptions.fieldPath : undefined;
  const results: MediaRefPlaceholder[] = [];
  const guessFilename = (mt: string) => guessFileExtension(mt) !== "bin" ? `media.${guessFileExtension(mt)}` : undefined;
  const processEntry = (entry: unknown): void => {
    if (entry === null || entry === undefined) return;
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) return;
      const p = parseDataUrlSource(trimmed);
      if (p !== null) {
        results.push({ ...MEDIA_REF_MARKER, source: { kind: "inline_data" as const, data: p.data, mimeType: p.mimeType }, mimeType: p.mimeType, transport, filename: guessFilename(p.mimeType ?? ""), fieldPath });
        return;
      }
      results.push({ ...MEDIA_REF_MARKER, source: { kind: "url" as const, url: trimmed }, transport, fieldPath });
      return;
    }
    if (Array.isArray(entry)) { for (const item of entry) { processEntry(item); } return; }
    if (typeof entry !== "object") return;
    // 媒体身份（提交面显式给出时）：来源资产标识与产品级素材位标识。
    // 只作审计/溯源随占位符带到序列化文件描述，不参与字段分桶与出网形态。
    const entryAssetId =
      normalizeString(readOpenField(entry, "assetId")) ||
      normalizeString(readOpenField(entry, "asset_id"));
    const entrySlotId =
      normalizeString(readOpenField(entry, "slotId")) ||
      normalizeString(readOpenField(entry, "slot_id"));
    const identity = {
      ...(entryAssetId ? { assetId: entryAssetId } : {}),
      ...(entrySlotId ? { slotId: entrySlotId } : {}),
    };
    const kind = normalizeString(readOpenField(entry, "kind")).toLowerCase();
    if (kind === "inline_data") {
      const data = normalizeString(readOpenField(entry, "data"));
      const mimeType = normalizeString(readOpenField(entry, "mimeType")) || normalizeString(readOpenField(entry, "mime_type")) || "application/octet-stream";
      if (!data) { loggingModule.logDebug("[request-assembler-runtime] buildMediaRefPlaceholders: inline_data entry has empty data, skipping", undefined); return; }
      const fn = readOpenField(entry, "filename");
      results.push({ ...MEDIA_REF_MARKER, source: { kind: "inline_data" as const, data, mimeType }, mimeType, transport, filename: typeof fn === "string" && fn.trim() ? fn.trim() : guessFilename(mimeType), fieldPath, ...identity });
      return;
    }
    const url = normalizeString(readOpenField(entry, "url"));
    if (url) {
      const fn = readOpenField(entry, "filename");
      results.push({ ...MEDIA_REF_MARKER, source: { kind: "url" as const, url }, mimeType: normalizeString(readOpenField(entry, "mime_type")) || undefined, transport, filename: typeof fn === "string" && fn.trim() ? fn.trim() : undefined, fieldPath, ...identity });
      return;
    }
    const rawUrl = normalizeString(readOpenField(entry, "asset_url") || readOpenField(entry, "assetUrl") || readOpenField(entry, "src"));
    if (rawUrl) { results.push({ ...MEDIA_REF_MARKER, source: { kind: "url" as const, url: rawUrl }, transport, fieldPath }); return; }
    if (isPlainObject(entry)) { loggingModule.logDebug("[request-assembler-runtime] buildMediaRefPlaceholders: unrecognized object discarded", { keys: Object.keys(entry) }); }
  };
  processEntry(value);
  return results;
};

// 调用点 evaluateRule 传入的 extra 是具体形状（UploadOptions/PreRequestOutputsMap），
// 共享求值器的 handler 类型按 TExtra 参数化；handlers 必须标注同一具体 Extra，
// 否则默认 Extra（uploadOptions: unknown）在协变位与调用点推断的具体类型不兼容。
type RuleEvaluationExtra = {
  uploadOptions: UploadOptions | undefined;
  preRequestOutputs: PreRequestOutputsMap | undefined;
};

const transformHandlers: ModelAssetRuntimeEvaluationOptions<EvaluateState, RuleEvaluationExtra>["transformHandlers"] =
  {
    extractUrls: ({ value, options }) => {
      const uploadOptions = (options.extra !== null && options.extra !== undefined)
        ? options.extra.uploadOptions as UploadOptions | undefined
        : undefined;
      // 优先用嵌套规则声明的 media_target 推导 transport（seedance 式 pack 的
      // map_array/field.extractUrls 在顶层 coalesce 无 media_target 时仍带声明）；
      // 未命中四个明确映射时 fallback 到顶层 uploadOptions。
      const mediaTarget = normalizeString(options.mediaTarget);
      if (mediaTarget) {
        const transport = resolveTransportFromMediaTarget(mediaTarget);
        if (transport !== undefined) {
          return buildMediaRefPlaceholders(value, uploadOptions, transport);
        }
      }
      return buildMediaRefPlaceholders(value, uploadOptions);
    },
    extractFirstBase64DataUrl: ({ value }) => {
      // 直接从输入值提取第一个 base64 data URL，不经 MediaItem 中间格式
      const extractFirst = (v: unknown): string | undefined => {
        if (v === null || v === undefined) return undefined;
        if (typeof v === "string") {
          const trimmed = v.trim();
          if (!trimmed) return undefined;
          const parsed = parseDataUrlSource(trimmed);
          if (parsed !== null) return `data:${parsed.mimeType};base64,${parsed.data}`;
          if (looksLikeBase64(trimmed)) return `data:application/octet-stream;base64,${trimmed}`;
          return undefined;
        }
        if (Array.isArray(v)) {
          for (const item of v) {
            const result = extractFirst(item);
            if (result !== undefined) return result;
          }
          return undefined;
        }
        if (typeof v !== "object") return undefined;
        const kind = normalizeString(readOpenField(v, "kind")).toLowerCase();
        if (kind === "inline_data") {
          const data = normalizeString(readOpenField(v, "data"));
          const mimeType = normalizeString(readOpenField(v, "mimeType")) || normalizeString(readOpenField(v, "mime_type")) || "application/octet-stream";
          if (data) return `data:${mimeType};base64,${data}`;
        }
        const data = normalizeString(readOpenField(v, "data"));
        const mimeType = normalizeString(readOpenField(v, "mimeType")) || normalizeString(readOpenField(v, "mime_type"));
        if (data && mimeType) return `data:${mimeType};base64,${data}`;
        const url = normalizeString(readOpenField(v, "url") || readOpenField(v, "src") || readOpenField(v, "asset_url") || readOpenField(v, "assetUrl"));
        if (url) {
          const parsed = parseDataUrlSource(url);
          if (parsed !== null) return `data:${parsed.mimeType};base64,${parsed.data}`;
        }
        return undefined;
      };
      return extractFirst(value);
    },
  };

const operatorHandlers: ModelAssetRuntimeEvaluationOptions<EvaluateState, RuleEvaluationExtra>["operatorHandlers"] =
  {
    build_content_blocks: async ({ rule, context, options, evaluateRule }) => {
      const ruleConfig = parseRuleConfigRecord(rule);
      const ruleOptions = parseRuleOptionsRecord((ruleConfig !== null && ruleConfig !== undefined ? ruleConfig.options : undefined)) ?? { fallback: undefined, allowed_values: undefined, message: undefined, source: undefined, max_items: undefined, prepend: undefined, append: undefined, item: undefined, skip_if_empty: undefined, parts: undefined, role: undefined, output_shape: undefined };
      const parts: unknown[] = Array.isArray(ruleOptions.parts)
        ? ruleOptions.parts
        : [];
      const contentParts = [];
      for (const part of parts) {
        const partConfig = parseContentPartRecord(part) ?? { part_kind: undefined, partKind: undefined, value: undefined, multiple: undefined };
        const partKind = normalizeString(
          partConfig.part_kind ?? partConfig.partKind,
        ).toLowerCase();
        const value = await evaluateRule(
          partConfig.value as Parameters<
            typeof evaluateSharedRuntimeValueRule
          >[0],
          options,
        );
        const multiple = partConfig.multiple === true;
        const values = multiple && Array.isArray(value) ? value : [value];
        for (const entry of values) {
          if (entry === undefined || entry === null || entry === "") {
            loggingModule.logDebug("[request-assembler-runtime] build_content_blocks: part entry is empty, skipping", { partKind });
            if (partKind === "inline_data") {
              loggingModule.logWarn("[request-assembler-runtime] build_content_blocks: inline_data part skipped due to empty resolved value. This may indicate media data was lost upstream.", { partKind, entryPreview: String(entry).substring(0, 100) });
            }
            continue;
          }
          if (partKind === "text") {
            contentParts.push({ text: String(entry) });
            continue;
          }
          if (partKind === "inline_data") {
            // 优先检测 MediaRefPlaceholder（统一协议路径）
            if (isMediaRefPlaceholder(entry)) {
              contentParts.push(
                toInlineDataPart(
                  entry,
                  context,
                  resolveUploadUrlOptionsFromContext(context, options.targetPath),
                ),
              );
              continue;
            }
            // 数组中可能包含 MediaRefPlaceholder 和普通 media items 混合
            if (Array.isArray(entry)) {
              const inlineParts = [];
              for (const arrayItem of entry) {
                if (isMediaRefPlaceholder(arrayItem)) {
                  inlineParts.push(
                    toInlineDataPart(
                      arrayItem,
                      context,
                      resolveUploadUrlOptionsFromContext(context, options.targetPath),
                    ),
                  );
                } else {
                  const placeholders = buildMediaRefPlaceholders(arrayItem, undefined);
                  for (const placeholder of placeholders) {
                    inlineParts.push(
                      toInlineDataPart(
                        placeholder,
                        context,
                        resolveUploadUrlOptionsFromContext(context, options.targetPath),
                      ),
                    );
                  }
                }
              }
              if (inlineParts.length > 0) {
                for (const part of inlineParts) {
                  contentParts.push(part);
                }
                continue;
              }
            }
            // 从输入值直接构建 MediaRefPlaceholder，不经 MediaItem 中间格式
            const placeholders = buildMediaRefPlaceholders(entry, undefined);
            if (placeholders.length > 0) {
              for (const placeholder of placeholders) {
                contentParts.push(
                  toInlineDataPart(
                    placeholder,
                    context,
                    resolveUploadUrlOptionsFromContext(context, options.targetPath),
                  ),
                );
              }
              continue;
            }
            loggingModule.logDebug("[request-assembler-runtime] build_content_blocks: no media items for inline_data part", { partKind, entryType: typeof entry });
            throw new Error(
              `build_content_blocks: inline_data part has no resolvable media items, entry type: ${typeof entry}`,
            );
          }
        }
      }
      if (contentParts.length === 0) {
        loggingModule.logDebug("[request-assembler-runtime] build_content_blocks: all parts empty, returning undefined", undefined);
        return undefined;
      }
      const outputShape =
        normalizeString(ruleOptions.output_shape).toLowerCase() ||
        MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE.GEMINI_CONTENTS;
      if (outputShape === MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE.INTERACTIONS_INPUT) {
        return contentParts.map((part) => toInteractionsInputEntry(part));
      }
      return [
        {
          role: normalizeString(ruleOptions.role) || "user",
          parts: contentParts,
        },
      ];
    },
  };

const evaluateRule = (
  rule: unknown,
  state: EvaluateState,
  options: EvaluationOptions = {} as EvaluationOptions,
): Promise<unknown> =>
  evaluateSharedRuntimeValueRule(
    rule as Parameters<typeof evaluateSharedRuntimeValueRule>[0],
    state,
    {
      item: options.item,
      targetPath: options.targetPath,
      mediaTarget: undefined,
      extra: { uploadOptions: options.uploadOptions, preRequestOutputs: options.preRequestOutputs },
      transformHandlers,
      operatorHandlers,
      createError: invalidArguments,
    },
  );

export {
  evaluateRule,
  guessFileExtension,
  normalizeMediaInputBuckets,
  resolveUploadUrlOptions,
  toInlineDataPart,
};
