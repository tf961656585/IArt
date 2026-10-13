/**
 * public URL 模式下裸字符串 / 对象兼容处理。
 *
 * 在 public URL 模式下，body 中的裸 data URL、base64、本地路径、
 * inline_data 对象、url 对象等非 MediaRefPlaceholder 值也需要上传 relay。
 * 本模块提供这些兼容旧路径的物化函数。
 */
import path from "node:path";
import {
  type MediaRefSource,
} from "@iart/contracts";
import {
  isPlainObject,
  normalizeString,
  readField,
} from "./model-input-source.cts";
import { hasPublicUrlMediaPathHint } from "./model-input-policy.cts";
import { uploadModelInputViaPublicRelay } from "./model-input-public-relay.cts";
import {
  appendUploadEvent,
  type AtomPreparationResult,
  type MaterializeContext,
} from "./model-input-shared.cts";
import { guessFileExtension } from "../request-assembler-runtime.cts";

const filenameFromSourceUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  const base = path.basename(url);
  if (base && path.extname(base)) return base;
  return null;
};

// ---------------------------------------------------------------------------
// uploadInlineDataViaRelay：将 inline data 通过 relay 上传为公网 URL
// ---------------------------------------------------------------------------

const uploadInlineDataViaRelay = async (
  context: MaterializeContext,
  data: string,
  mimeType: string,
  filename: string,
  fieldPath: string,
): Promise<AtomPreparationResult> => {
  const source: MediaRefSource = { kind: "inline_data", data, mimeType };

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
    mimeType,
    filename,
  });

  if (!result.ok) {
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
};

// ---------------------------------------------------------------------------
// 字符串分类辅助
// ---------------------------------------------------------------------------

const looksLikeLocalPublicRelaySource = (value: string) => {
  const normalized = normalizeString(value);
  if (!normalized) return false;
  return (
    normalized.startsWith("/files/") ||
    normalized.startsWith("/project-media/") ||
    normalized.startsWith("local-media://") ||
    normalized.startsWith("blob:") ||
    normalized.startsWith("file:")
  );
};

// ---------------------------------------------------------------------------
// 裸字符串物化：data URL / base64 / 本地路径 → 上传 relay → 公网 URL
// ---------------------------------------------------------------------------

const materializeStringValueForPublicUrl = async (
  context: MaterializeContext,
  value: string,
  fieldPath: string,
  looksLikeRemoteUrl: (value: unknown) => boolean,
  looksLikeBareBase64: (value: unknown) => boolean,
  parseDataUrlSource: (value: string) => { data: string; mimeType: string } | null,
): Promise<AtomPreparationResult> => {
  const normalized = normalizeString(value);
  if (!normalized) return { ok: true, value };
  if (looksLikeRemoteUrl(normalized)) return { ok: true, value: normalized };

  const dataUrl = parseDataUrlSource(normalized);
  if (dataUrl) {
    return uploadInlineDataViaRelay(
      context,
      dataUrl.data,
      dataUrl.mimeType,
      `input.${guessFileExtension(dataUrl.mimeType)}`,
      fieldPath,
    );
  }

  if (hasPublicUrlMediaPathHint(fieldPath) && looksLikeBareBase64(normalized)) {
    return uploadInlineDataViaRelay(
      context,
      normalized,
      "application/octet-stream",
      "input.bin",
      fieldPath,
    );
  }

  if (looksLikeLocalPublicRelaySource(normalized)) {
    const source: MediaRefSource = { kind: "url", url: normalized };
    const filename = filenameFromSourceUrl(normalized) || "input.bin";

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

  return { ok: true, value };
};

// ---------------------------------------------------------------------------
// 读取显式 inline_data 对象源
// ---------------------------------------------------------------------------

const readInlineObjectSource = (
  value: unknown,
): { data: string; mimeType: string; filename: string | undefined } | null => {
  if (!isPlainObject(value)) return null;
  const inlineData = readField(value, "inline_data");
  if (isPlainObject(inlineData)) {
    const data = normalizeString(readField(inlineData, "data"));
    if (!data) return null;
    return {
      data,
      mimeType:
        normalizeString(readField(inlineData, "mime_type")) ||
        normalizeString(readField(inlineData, "mimeType")) ||
        "application/octet-stream",
      filename: normalizeString(readField(value, "filename")) || undefined,
    };
  }

  const kind = normalizeString(readField(value, "kind"));
  const data = normalizeString(readField(value, "data"));
  const mimeType =
    normalizeString(readField(value, "mimeType")) ||
    normalizeString(readField(value, "mime_type"));
  if (kind === "inline_data") {
    if (!data) return null;
    return {
      data,
      mimeType: mimeType || "application/octet-stream",
      filename: normalizeString(readField(value, "filename")) || undefined,
    };
  }
  if (data && mimeType) {
    return {
      data,
      mimeType,
      filename: normalizeString(readField(value, "filename")) || undefined,
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// 读取对象中的 url 源
// ---------------------------------------------------------------------------

const readObjectUrlSource = (
  value: unknown,
  fieldPath: string,
): { url: string; filename: string | undefined } | null => {
  if (!isPlainObject(value)) return null;
  const url =
    normalizeString(readField(value, "asset_url")) ||
    normalizeString(readField(value, "assetUrl")) ||
    normalizeString(readField(value, "src"));
  if (url) {
    return {
      url,
      filename: normalizeString(readField(value, "filename")) || undefined,
    };
  }
  const directUrl = normalizeString(readField(value, "url"));
  if (!directUrl) return null;
  const segments = fieldPath
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim().toLowerCase().replace(/[_-]/g, ""));
  const containerSegments = new Set(["audiourl", "imageurl", "videourl"]);
  const terminal = segments.at(-1);
  if (terminal !== undefined && containerSegments.has(terminal)) return null;
  return {
    url: directUrl,
    filename: normalizeString(readField(value, "filename")) || undefined,
  };
};

export {
  uploadInlineDataViaRelay,
  materializeStringValueForPublicUrl,
  readInlineObjectSource,
  readObjectUrlSource,
  looksLikeLocalPublicRelaySource,
  filenameFromSourceUrl,
};
