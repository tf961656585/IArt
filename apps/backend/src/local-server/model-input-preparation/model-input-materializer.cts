/**
 * 统一 MediaRefPlaceholder 物化函数。
 *
 * 根据 placeholder.transport 字段分发到具体物化逻辑：
 * - public_url: 上传到 relay，替换为公网 URL
 * - multipart_file: 转为 Buffer
 * - inline_data: 转为 { kind: "inline_data", data, mimeType }
 *
 * 无 transport 的旧占位符按上下文推断（向后兼容）。
 */
import fs from "node:fs";
import {
  MEDIA_REF_TRANSPORT,
  type MediaRefPlaceholder,
  type MediaRefSource,
  isMediaRefPlaceholder,
} from "@iart/contracts";
import {
  isPlainObject,
  normalizeString,
  writeField,
  looksLikeRemoteUrl,
  parseDataUrlSource,
  looksLikeBareBase64,
} from "./model-input-source.cts";
import { joinPublicUrlChildPath } from "./model-input-policy.cts";
import { uploadModelInputViaPublicRelay } from "./model-input-public-relay.cts";
import { resolveImageProcessingSource } from "../image-processing-source-resolver.cts";
import {
  appendUploadEvent,
  type AtomPreparationResult,
  type MaterializeContext,
} from "./model-input-shared.cts";
import { logDebug, logInfo } from "../logging.cts";
import { guessFileExtension } from "../request-assembler-runtime.cts";
import { wrapMultipartFile } from "./model-input-multipart-file.cts";
import {
  uploadInlineDataViaRelay,
  materializeStringValueForPublicUrl,
  readInlineObjectSource,
  readObjectUrlSource,
  filenameFromSourceUrl,
} from "./model-input-materializer-public-url-compat.cts";

type MultipartMaterializeContext = {
  projectPath: unknown;
};

/**
 * 推断旧占位符（无 transport 字段）应使用的 transport。
 * 按上下文推断：有 targetType → public_url，否则默认 inline_data。
 */
const inferTransport = (
  _placeholder: MediaRefPlaceholder,
  context: MaterializeContext,
): "public_url" | "multipart_file" | "inline_data" => {
  const targetType = normalizeString(context.targetType);
  if (targetType) return MEDIA_REF_TRANSPORT.PUBLIC_URL;
  if (context.multipartMode) return MEDIA_REF_TRANSPORT.MULTIPART_FILE;
  return MEDIA_REF_TRANSPORT.INLINE_DATA;
};

// ---------------------------------------------------------------------------
// public_url 物化：上传 relay → 替换为公网 URL
// ---------------------------------------------------------------------------

const materializePublicUrl = async (
  context: MaterializeContext,
  placeholder: MediaRefPlaceholder,
  fieldPath: string,
): Promise<AtomPreparationResult> => {
  const sourceUrl = placeholder.source.kind === "url" ? placeholder.source.url : undefined;
  const filename = placeholder.filename
    || filenameFromSourceUrl(sourceUrl)
    || `input.${guessFileExtension(placeholder.mimeType)}`;
  const mimeType = placeholder.mimeType || undefined;

  appendUploadEvent(context, "task.input_upload_started", placeholder.source, fieldPath, {
    continueToRequesting: false,
    errorCode: null,
    error: null,
    url: null,
  });

  const result = await uploadModelInputViaPublicRelay({
    projectPath: context.projectPath,
    source: placeholder.source,
    targetType: context.targetType,
    mimeType,
    filename,
  });

  if (!result.ok) {
    logInfo("[materializer] public_url materialization failed", {
      fieldPath,
      code: result.code,
      message: result.message,
      sourceKind: placeholder.source.kind,
    });
    appendUploadEvent(context, "task.input_upload_failed", placeholder.source, fieldPath, {
      continueToRequesting: false,
      errorCode: result.code,
      error: result.message,
      url: null,
    });
    return { ok: false, code: result.code, message: result.message };
  }

  appendUploadEvent(context, "task.input_upload_succeeded", placeholder.source, fieldPath, {
    continueToRequesting: true,
    errorCode: null,
    error: null,
    url: result.url,
  });
  return { ok: true, value: result.url };
};

// ---------------------------------------------------------------------------
// multipart_file 物化：source → Buffer
// ---------------------------------------------------------------------------

type MultipartResolveError = {
  ok: false;
  reason: string;
  sourceKind: string;
};

const resolveMultipartFileBuffer = (
  source: MediaRefSource,
  projectPath: unknown,
): Buffer | MultipartResolveError => {
  if (source.kind === "inline_data") {
    if (!source.data) {
      return { ok: false, reason: "inline_data source has empty data field", sourceKind: "inline_data" };
    }
    try {
      return Buffer.from(source.data, "base64");
    } catch (error: unknown) {
      return {
        ok: false,
        reason: `inline_data base64 decode failed: ${error instanceof Error && error.message ? error.message : "unknown error"}`,
        sourceKind: "inline_data",
      };
    }
  }
  if (source.kind === "url") {
    if (!source.url) {
      return { ok: false, reason: "url source has empty url field", sourceKind: "url" };
    }
    const normalizedProjectPath = normalizeString(projectPath);
    if (!normalizedProjectPath) {
      return { ok: false, reason: "projectPath is empty for url source resolution", sourceKind: "url" };
    }
    const urlStr = source.url;
    if (/^https?:\/\//i.test(urlStr)) {
      return { ok: false, reason: `remote URL cannot be resolved to local file: ${urlStr}`, sourceKind: "url" };
    }
    try {
      const resolved = resolveImageProcessingSource(normalizedProjectPath, urlStr);
      const filePath = resolved.sourceFilePath;
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, reason: `local file not found for url source: ${urlStr}`, sourceKind: "url" };
      }
      if (!fs.statSync(filePath).isFile()) {
        return { ok: false, reason: `resolved path is not a file: ${filePath}`, sourceKind: "url" };
      }
      return fs.readFileSync(filePath);
    } catch (error: unknown) {
      return {
        ok: false,
        reason: `failed to read local file for url source ${urlStr}: ${error instanceof Error && error.message ? error.message : "unknown error"}`,
        sourceKind: "url",
      };
    }
  }
  return { ok: false, reason: "unsupported source kind", sourceKind: "unknown" };
};

const isBuffer = (value: Buffer | MultipartResolveError): value is Buffer =>
  Buffer.isBuffer(value);

const materializeMultipartFile = (
  context: MultipartMaterializeContext,
  placeholder: MediaRefPlaceholder,
): AtomPreparationResult => {
  const bufferOrError = resolveMultipartFileBuffer(placeholder.source, context.projectPath);
  if (isBuffer(bufferOrError)) {
    // 字节照旧出网；来源身份只随字节带进文件描述（审计），出网形态由序列化器固定。
    return {
      ok: true,
      value: wrapMultipartFile(bufferOrError, {
        sourceFilename: placeholder.filename,
        mimeType:
          placeholder.mimeType ??
          (placeholder.source.kind === "inline_data" ? placeholder.source.mimeType : undefined),
        assetId: placeholder.assetId,
        slotId: placeholder.slotId,
      }),
    };
  }
  return {
    ok: false,
    code: "multipart_file_resolve_failed",
    message: `Failed to resolve multipart file: ${bufferOrError.reason}`,
  };
};

// ---------------------------------------------------------------------------
// inline_data 物化：source → { inline_data: { mime_type, data } }
//
// 物化结果是请求体里的最终线格式（与 Gemini 原生 inline_data part、Veo
// instances[].image 消费的 `{inline_data:{mime_type,data}}` 一致），不再产出中间
// 标记对象，避免下游出现「已物化但仍是占位标记」的二义形态。
// ---------------------------------------------------------------------------

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

const INLINE_DATA_ERROR_PREFIX = "inline_data_preparation_error";

const toInlineDataValue = (data: string, mimeType: string) => ({
  inline_data: { mime_type: mimeType, data },
});

const materializeInlineData = (
  projectPath: string,
  placeholder: MediaRefPlaceholder,
  fieldPath: string,
): AtomPreparationResult => {
  const source = placeholder.source;
  if (source.kind === "inline_data") {
    if (!source.data) {
      logDebug(
        "[materializer] inline_data materialization skipped: empty data on inline source",
        { fieldPath, sourceKind: source.kind },
      );
      return {
        ok: false,
        code: INLINE_DATA_ERROR_PREFIX,
        message: `${INLINE_DATA_ERROR_PREFIX}: MediaRefPlaceholder inline_data source has empty data at ${fieldPath}`,
      };
    }
    return {
      ok: true,
      value: toInlineDataValue(
        source.data,
        source.mimeType || placeholder.mimeType || "application/octet-stream",
      ),
    };
  }
  if (source.kind === "url") {
    const url = source.url;
    if (!url) {
      logDebug(
        "[materializer] inline_data materialization skipped: empty url on url source",
        { fieldPath, sourceKind: source.kind },
      );
      return {
        ok: false,
        code: INLINE_DATA_ERROR_PREFIX,
        message: `${INLINE_DATA_ERROR_PREFIX}: MediaRefPlaceholder url source has empty url at ${fieldPath}`,
      };
    }
    if (/^https?:\/\//i.test(url)) {
      logDebug(
        "[materializer] inline_data materialization skipped: remote url cannot be inlined",
        { fieldPath, sourceKind: source.kind },
      );
      return {
        ok: false,
        code: INLINE_DATA_ERROR_PREFIX,
        message: `${INLINE_DATA_ERROR_PREFIX}: remote URL cannot be converted to inline_data (need public_relay path): ${url} at ${fieldPath}`,
      };
    }
    const resolved = resolveImageProcessingSource(projectPath, url);
    const filePath = resolved.sourceFilePath;
    if (!filePath || !fs.existsSync(filePath)) {
      logDebug(
        "[materializer] inline_data materialization skipped: local file not found",
        { fieldPath, sourceKind: source.kind, resolvedFilePath: filePath || null },
      );
      return {
        ok: false,
        code: INLINE_DATA_ERROR_PREFIX,
        message: `${INLINE_DATA_ERROR_PREFIX}: local file not found for MediaRefPlaceholder url source: ${url} at ${fieldPath}`,
      };
    }
    const buffer = fs.readFileSync(filePath);
    const mimeType = placeholder.mimeType || guessMimeTypeFromPath(filePath);
    return {
      ok: true,
      value: toInlineDataValue(buffer.toString("base64"), mimeType),
    };
  }
  logDebug(
    "[materializer] inline_data materialization skipped: unsupported source kind",
    { fieldPath, sourceKind: "unknown" },
  );
  return {
    ok: false,
    code: INLINE_DATA_ERROR_PREFIX,
    message: `${INLINE_DATA_ERROR_PREFIX}: unsupported source kind at ${fieldPath}`,
  };
};

// ---------------------------------------------------------------------------
// 统一物化入口
// ---------------------------------------------------------------------------

const materializeMediaRefPlaceholder = async (
  context: MaterializeContext,
  placeholder: MediaRefPlaceholder,
  fieldPath: string,
): Promise<AtomPreparationResult> => {
  const transport = placeholder.transport !== undefined
    ? placeholder.transport
    : inferTransport(placeholder, context);

  if (transport === MEDIA_REF_TRANSPORT.PUBLIC_URL) {
    return materializePublicUrl(context, placeholder, fieldPath);
  }
  if (transport === MEDIA_REF_TRANSPORT.MULTIPART_FILE) {
    return materializeMultipartFile(
      { projectPath: context.projectPath },
      placeholder,
    );
  }
  const normalizedProjectPath = normalizeString(context.projectPath);
  return materializeInlineData(normalizedProjectPath || "", placeholder, fieldPath);
};

// ---------------------------------------------------------------------------
// 递归遍历 body 物化所有 MediaRefPlaceholder
// ---------------------------------------------------------------------------

type DynamicObject = object;

const materializeSubtree = async (
  context: MaterializeContext,
  value: unknown,
  fieldPath: string,
): Promise<AtomPreparationResult> => {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value };
  }

  if (isMediaRefPlaceholder(value)) {
    return materializeMediaRefPlaceholder(context, value, fieldPath);
  }

  if (typeof value === "string") {
    const targetType = normalizeString(context.targetType);
    if (targetType) {
      return materializeStringValueForPublicUrl(
        context,
        value,
        fieldPath,
        looksLikeRemoteUrl,
        looksLikeBareBase64,
        parseDataUrlSource,
      );
    }
    return { ok: true, value };
  }

  if (Array.isArray(value)) {
    const results: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const prepared = await materializeSubtree(
        context,
        item,
        joinPublicUrlChildPath(fieldPath, index),
      );
      if (!prepared.ok) return prepared;
      results.push(prepared.value);
    }
    return { ok: true, value: results };
  }

  if (isPlainObject(value)) {
    const targetType = normalizeString(context.targetType);
    if (targetType) {
      const inlineSource = readInlineObjectSource(value);
      if (inlineSource !== null) {
        return uploadInlineDataViaRelay(
          context,
          inlineSource.data,
          inlineSource.mimeType,
          inlineSource.filename || `input.${guessFileExtension(inlineSource.mimeType)}`,
          fieldPath,
        );
      }
      const urlSource = readObjectUrlSource(value, fieldPath);
      if (urlSource !== null) {
        if (looksLikeRemoteUrl(urlSource.url)) {
          return { ok: true, value: urlSource.url };
        }
        const source: MediaRefSource = { kind: "url", url: urlSource.url };
        const filename = urlSource.filename || filenameFromSourceUrl(urlSource.url) || "input.bin";

        appendUploadEvent(context, "task.input_upload_started", source, fieldPath, {
          continueToRequesting: false,
          errorCode: null,
          error: null,
          url: null,
        });

        const result = await uploadModelInputViaPublicRelay({
          projectPath: context.projectPath,
          source,
          targetType: context.targetType,
          mimeType: undefined,
          filename,
        });

        if (!result.ok) {
          logInfo("[materializer] subtree public_url upload failed", {
            fieldPath,
            code: result.code,
            message: result.message,
          });
          appendUploadEvent(context, "task.input_upload_failed", source, fieldPath, {
            continueToRequesting: false,
            errorCode: result.code,
            error: result.message,
            url: null,
          });
          return { ok: false, code: result.code, message: result.message };
        }

        appendUploadEvent(context, "task.input_upload_succeeded", source, fieldPath, {
          continueToRequesting: true,
          errorCode: null,
          error: null,
          url: result.url,
        });
        return { ok: true, value: result.url };
      }
    }

    const preparedObject: DynamicObject = {};
    for (const [key, item] of Object.entries(value)) {
      const prepared = await materializeSubtree(
        context,
        item,
        joinPublicUrlChildPath(fieldPath, key),
      );
      if (!prepared.ok) return prepared;
      writeField(preparedObject, key, prepared.value);
    }
    return { ok: true, value: preparedObject };
  }

  if (Buffer.isBuffer(value)) {
    return { ok: true, value };
  }

  return { ok: true, value };
};

export {
  materializeMediaRefPlaceholder,
  materializeSubtree,
  resolveMultipartFileBuffer,
  guessMimeTypeFromPath,
};
export type {
  MaterializeContext,
  MultipartMaterializeContext,
};
