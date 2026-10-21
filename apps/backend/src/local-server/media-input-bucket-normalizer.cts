/**
 * 旧版 media_inputs 分桶逻辑。
 *
 * 从 request-assembler-runtime.cts 拆出，负责将 media_inputs 数组
 * 按 media_kind 分桶到对应的 field_key。
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseDataUrlSource,
  TaskSubmitMediaInputSchema,
} from "@iart/contracts";
import mediaConstantsModule = require("@iart/utils/media-constants");
import mediaFileKeyModule = require("@iart/utils/media-file-key");
import * as loggingModule from "./logging.cts";
import {
  invalidArguments,
  mediaKindNotSupported,
  mediaSourceUnavailable,
} from "./errors.cts";
import {
  asProjectionCapabilityRaw,
  asProjectionRaw,
  isPlainObject,
  normalizeString,
  readOpenField,
  type PlainObject,
} from "./request-assembler-shared.cts";
import {
  parseLocalMediaSourceRecord,
} from "./media-item-normalizer.cts";

type ResolvedMediaSource =
  | { kind: "url"; url: string }
  | { kind: "inline_data"; data: string; mimeType: string };
type MediaInputBuckets = Record<string, unknown[]>;

const MEDIA_UPLOAD_COMPONENT_TO_KIND: Record<string, string> = {
  imageupload: "image",
  videoupload: "video",
  audioupload: "audio",
  file: "file",
};

/**
 * 从 projection 的 parameter_schema.fields 建立 media_kind → 全部候选字段键的映射。
 *
 * 一个媒体类型可能对应**多个**素材位（如视频生成的首帧 + 尾帧都是 imageUpload）。
 * 旧实现用 Map<string,string> 逐个覆盖，结果是「后声明的位胜出」——图片被整体倒进最后
 * 那一个位，且不报错。这里保留全部候选，交给分桶逻辑判断是否无歧义。
 */
const buildMediaKindToFieldKeysMap = (
  projection: PlainObject,
): Map<string, string[]> => {
  const mapping = new Map<string, string[]>();
  const parameterSchema = readOpenField(projection, "parameter_schema");
  if (!isPlainObject(parameterSchema)) return mapping;
  const schemaFields = readOpenField(parameterSchema, "fields");
  if (!Array.isArray(schemaFields)) return mapping;
  for (const field of schemaFields) {
    if (!isPlainObject(field)) continue;
    const fieldKey = normalizeString(readOpenField(field, "field_key"));
    const component = normalizeString(readOpenField(field, "component")).toLowerCase();
    if (!fieldKey) continue;
    const mediaKind = MEDIA_UPLOAD_COMPONENT_TO_KIND[component];
    if (mediaKind === undefined) continue;
    const existing = mapping.get(mediaKind);
    if (existing === undefined) {
      mapping.set(mediaKind, [fieldKey]);
    } else if (!existing.includes(fieldKey)) {
      existing.push(fieldKey);
    }
  }
  return mapping;
};

const normalizeMediaKind = (value: unknown): "image" | "video" | "audio" | "" => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "image" || normalized === "video" || normalized === "audio") {
    return normalized;
  }
  return "";
};

const normalizeMediaSourceKind = (
  value: unknown,
): "attachment" | "local_path" | "url" | "base64" | "" => {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === "attachment" || normalized === "local_path" ||
    normalized === "url" || normalized === "base64"
  ) {
    return normalized;
  }
  return "";
};

/**
 * 把 attachment/local_path 的 source value 解析为可读的本地文件路径。
 *
 * PromptDock 提交面的 attachment value 是画布已登记资产的 local-media:// URL
 * （editor mediaAssets.original.url），不是文件系统路径；此处经 media-file-key
 * 单一入口解析 fileKey 后落到项目 media 目录。fileKey 来自跨边界提交体，
 * 解析结果必须收敛在 projectPath/media 内（防路径穿越）。
 */
const resolveLocalMediaFilePath = (
  sourceValue: string,
  projectPath: string | null,
): string => {
  if (!sourceValue.startsWith(mediaConstantsModule.LOCAL_MEDIA_SCHEME)) {
    return sourceValue;
  }
  if (!normalizeString(projectPath ?? null)) {
    throw mediaSourceUnavailable(
      `Attachment local-media URL ${sourceValue.slice(0, 120)} requires a project context (project_path missing)`,
    );
  }
  const fileKey = mediaFileKeyModule.extractMediaFileKey(sourceValue);
  if (!fileKey) {
    throw mediaSourceUnavailable(
      `Attachment source unavailable: unparseable local-media URL ${sourceValue.slice(0, 120)}`,
    );
  }
  const mediaDir = path.resolve(normalizeString(projectPath), "media");
  const filePath = path.resolve(mediaDir, fileKey);
  if (!filePath.startsWith(mediaDir + path.sep)) {
    throw mediaSourceUnavailable(
      `Attachment local-media URL escapes project media directory: ${fileKey}`,
    );
  }
  return filePath;
};

const readLocalMediaFile = (
  sourceKind: string,
  value: unknown,
  projectPath: string | null,
): Buffer => {
  const sourceRecord = parseLocalMediaSourceRecord(value);
  const sourceValue =
    typeof value === "string"
      ? value
      : normalizeString(
          (sourceRecord !== null && sourceRecord !== undefined ? sourceRecord.path : undefined) ??
            (sourceRecord !== null && sourceRecord !== undefined ? sourceRecord.local_path : undefined) ??
            (sourceRecord !== null && sourceRecord !== undefined ? sourceRecord.localPath : undefined) ??
            (sourceRecord !== null && sourceRecord !== undefined ? sourceRecord.file_path : undefined) ??
            (sourceRecord !== null && sourceRecord !== undefined ? sourceRecord.filePath : undefined),
        );
  const filePath = resolveLocalMediaFilePath(sourceValue, projectPath);
  if (!filePath || !fs.existsSync(filePath)) {
    throw mediaSourceUnavailable(
      sourceKind === "attachment"
        ? `Attachment source unavailable: ${filePath || "(empty)"}`
        : `Local media path unavailable: ${filePath || "(empty)"}`,
    );
  }
  return fs.readFileSync(filePath);
};

const decodeBase64MediaSource = (
  value: unknown,
  mimeType: unknown,
): { data: string; mimeType: string } => {
  const parsedDataUrl = parseDataUrlSource(
    typeof value === "string" ? value : "",
  );
  const data =
    (parsedDataUrl !== null && parsedDataUrl !== undefined ? parsedDataUrl.data : undefined) || normalizeString(value).replace(/\s+/g, "");
  const resolvedMimeType =
    normalizeString(mimeType) ||
    (parsedDataUrl !== null && parsedDataUrl !== undefined ? parsedDataUrl.mimeType : undefined) ||
    "application/octet-stream";
  if (!data) {
    throw mediaSourceUnavailable("Base64 media source unavailable");
  }
  return { data, mimeType: resolvedMimeType };
};

const resolveMediaSourceValue = (
  sourceKind: string, value: unknown, mimeType: unknown, projectPath: string | null,
): ResolvedMediaSource => {
  if (sourceKind === "url") {
    const url = normalizeString(value);
    if (!url) throw mediaSourceUnavailable("Media URL unavailable");
    return { kind: "url", url };
  }
  if (sourceKind === "base64") {
    const decoded = decodeBase64MediaSource(value, mimeType);
    return {
      kind: "inline_data",
      data: decoded.data,
      mimeType: decoded.mimeType,
    };
  }
  if (sourceKind === "local_path" || sourceKind === "attachment") {
    const buffer = readLocalMediaFile(sourceKind, value, projectPath);
    return {
      kind: "inline_data",
      data: buffer.toString("base64"),
      mimeType: normalizeString(mimeType) || "application/octet-stream",
    };
  }
  throw invalidArguments(
    `Unsupported media input source_kind: ${sourceKind || "(empty)"}`,
  );
};

const projectResolvedMediaSourceForDraft = (
  source: ResolvedMediaSource, mediaKind: string, filename: unknown,
  mimeType: unknown,
): unknown => {
  if (source.kind === "url") {
    return {
      media_kind: mediaKind,
      url: source.url,
      mime_type: normalizeString(mimeType),
      filename: normalizeString(filename),
      owner: "backend",
    };
  }
  return {
    kind: "inline_data",
    data: source.data,
    mimeType:
      normalizeString(source.mimeType) ||
      normalizeString(mimeType) ||
      "application/octet-stream",
    filename: normalizeString(filename),
  };
};

const ensureProjectionSupportsMediaKind = (
  projection: PlainObject,
  mediaKind: string,
) => {
  const projectionRaw = asProjectionRaw(projection);
  const capability = asProjectionCapabilityRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.capability : undefined));
  const inputModalities = (capability !== null && capability !== undefined ? capability.input_modalities : undefined);
  const supported = Array.isArray(inputModalities)
    ? inputModalities
        .map((item) => normalizeString(item).toLowerCase())
        .filter(Boolean)
    : [];
  if (supported.length === 0 || supported.includes(mediaKind)) return;
  throw mediaKindNotSupported(
    `Model does not support media kind: ${mediaKind}`,
  );
};

const normalizeMediaInputBuckets = async (
  mediaInputs: unknown,
  projection: PlainObject,
  projectPath: string | null = null,
): Promise<MediaInputBuckets> => {
  const mediaKindToFieldKeys = buildMediaKindToFieldKeysMap(projection);
  const buckets: MediaInputBuckets = {};
  if (mediaInputs === undefined || mediaInputs === null) {
    const projectionRaw = asProjectionRaw(projection);
    const capability = asProjectionCapabilityRaw((projectionRaw !== null && projectionRaw !== undefined ? projectionRaw.capability : undefined));
    const inputModalities = (capability !== null && capability !== undefined ? capability.input_modalities : undefined);
    const mediaModalities = Array.isArray(inputModalities)
      ? inputModalities.map((item: unknown) => normalizeString(item).toLowerCase()).filter(Boolean)
      : [];
    const mediaRelated = mediaModalities.filter((m: string) => m === "image" || m === "video" || m === "audio");
    if (mediaRelated.length > 0) {
      loggingModule.logWarn("[request-assembler-runtime] normalizeMediaInputBuckets: media_inputs is empty but model declares media-capable input_modalities", { mediaModalities: mediaRelated });
    }
    return buckets;
  }
  if (!Array.isArray(mediaInputs)) {
    throw invalidArguments("media_inputs must be an array");
  }
  for (const item of mediaInputs) {
    const parsedMediaInput = TaskSubmitMediaInputSchema.safeParse(item);
    if (!parsedMediaInput.success) throw invalidArguments(`media_inputs entry validation failed: ${parsedMediaInput.error.message}`);
    const mediaInput = parsedMediaInput.data;
    const mediaKind = normalizeMediaKind(mediaInput.media_kind);
    const sourceKind = normalizeMediaSourceKind(mediaInput.source_kind);
    if (!mediaKind) {
      throw mediaKindNotSupported(
        `Unsupported media kind: ${normalizeString(mediaInput.media_kind) || "(empty)"}`,
      );
    }
    if (!sourceKind) {
      throw invalidArguments(
        `Unsupported media input source_kind: ${normalizeString(mediaInput.source_kind) || "(empty)"}`,
      );
    }
    ensureProjectionSupportsMediaKind(projection, mediaKind);
    // 分桶键优先级：显式字段绑定 > 该媒体类型唯一候选位 > 明确失败。
    //
    // 不做「按声明顺序取一个」的启发式：多素材位模型上猜错位不会报错，只会产出一张语义
    // 错了的图（首帧被当成尾帧），比直接失败更难发现。
    const explicitFieldKey = normalizeString(mediaInput.field_key);
    const candidates = mediaKindToFieldKeys.get(mediaKind) ?? [];
    let fieldKey: string;
    if (explicitFieldKey) {
      if (candidates.length > 0 && !candidates.includes(explicitFieldKey)) {
        throw invalidArguments(
          `media_inputs field_key "${explicitFieldKey}" is not a media field of this model (candidates: ${candidates.join(', ')})`,
        );
      }
      fieldKey = explicitFieldKey;
    } else if (candidates.length === 1) {
      // 长度已判为 1，索引 0 必然存在；显式兜底避免 noUncheckedIndexedAccess 下的可选类型。
      fieldKey = candidates[0] ?? mediaKind;
    } else if (candidates.length === 0) {
      fieldKey = mediaKind;
    } else {
      throw invalidArguments(
        `media_inputs requires an explicit field_key: this model declares ${candidates.length} fields accepting ${mediaKind} (${candidates.join(', ')}); set field_key on the media entry to say which one it belongs to`,
      );
    }
    const existingBucket = buckets[fieldKey];
    const bucket = existingBucket ?? [];
    if (existingBucket === undefined) {
      buckets[fieldKey] = bucket;
    }
    const source = resolveMediaSourceValue(
      sourceKind,
      mediaInput.value,
      mediaInput.mime_type,
      projectPath,
    );
    bucket.push(
      projectResolvedMediaSourceForDraft(
        source,
        mediaKind,
        mediaInput.filename,
        mediaInput.mime_type,
      ),
    );
    loggingModule.logDebug("[request-assembler-runtime] normalizeMediaInputBuckets: media input bucketed", { mediaKind, fieldKey, sourceKind });
  }
  return buckets;
};

export {
  normalizeMediaInputBuckets,
  MEDIA_UPLOAD_COMPONENT_TO_KIND,
};
