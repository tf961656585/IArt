import { isMediaRefPlaceholder } from "@iart/contracts";
import { isMultipartFileValue } from "./model-input-multipart-file.cts";
import {
  isPlainObject,
  looksLikeBareBase64,
  looksLikeRemoteUrl,
  normalizeString,
  parseDataUrlSource,
  readField,
  readRequestBodyPathValue,
} from "./model-input-source.cts";
import {
  hasPublicUrlMediaPathHint,
  joinPublicUrlChildPath,
} from "./model-input-policy.cts";
import type { ModelInputPolicy } from "./model-input-policy.cts";

type GuardResult = { ok: true } | { ok: false; code: string; message: string };

const isInlineMediaObject = (value: unknown) => {
  if (!isPlainObject(value)) return false;
  if (isPlainObject(readField(value, "inline_data"))) return true;
  const kind = normalizeString(readField(value, "kind"));
  if (kind === "inline_data") return true;
  return Boolean(
    normalizeString(readField(value, "data")) &&
    (normalizeString(readField(value, "mimeType")) ||
      normalizeString(readField(value, "mime_type"))),
  );
};

const describeInvalidPublicUrlValue = (value: unknown) => {
  if (typeof value === "string") {
    if (parseDataUrlSource(value)) return "data_url";
    const normalized = normalizeString(value);
    if (normalized.startsWith("blob:")) return "blob_url";
    if (normalized.startsWith("file:")) return "file_url";
    if (normalized.startsWith("local-media://")) return "local_media_url";
    if (normalized.startsWith("/files/")) return "local_files_url";
    if (normalized.startsWith("/project-media/")) return "project_media_url";
    return "local_media_source";
  }
  if (isInlineMediaObject(value)) return "inline_media_object";
  return "inline_media_object";
};

const getInvalidPublicUrlResidualReason = (
  value: unknown,
  fieldPath: string,
): string | null => {
  if (typeof value !== "string") {
    return isInlineMediaObject(value) ? describeInvalidPublicUrlValue(value) : null;
  }
  if (looksLikeRemoteUrl(value)) return null;
  if (parseDataUrlSource(value)) return describeInvalidPublicUrlValue(value);
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.startsWith("blob:")) return describeInvalidPublicUrlValue(value);
  if (normalized.startsWith("file:")) return describeInvalidPublicUrlValue(value);
  if (normalized.startsWith("local-media://"))
    return describeInvalidPublicUrlValue(value);
  if (normalized.startsWith("/files/")) return describeInvalidPublicUrlValue(value);
  if (normalized.startsWith("/project-media/"))
    return describeInvalidPublicUrlValue(value);
  if (hasPublicUrlMediaPathHint(fieldPath) && looksLikeBareBase64(value))
    return "base64";
  return null;
};

const guardPublicUrlSubtree = (
  value: unknown,
  fieldPath: string,
): GuardResult => {
  const reason = getInvalidPublicUrlResidualReason(value, fieldPath);
  if (reason) {
    return {
      ok: false,
      code: "model_input_final_guard_failed",
      message: `Model input field ${fieldPath} contains unprepared public URL media source: ${reason}`,
    };
  }
  if (value === undefined || value === null || value === "")
    return { ok: true };
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const guarded = guardPublicUrlSubtree(
        item,
        joinPublicUrlChildPath(fieldPath, index),
      );
      if (!guarded.ok) return guarded;
    }
    return { ok: true };
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const guarded = guardPublicUrlSubtree(
        item,
        joinPublicUrlChildPath(fieldPath, key),
      );
      if (!guarded.ok) return guarded;
    }
  }
  return { ok: true };
};

const guardMultipartResidual = (
  value: unknown,
  fieldPath: string,
): GuardResult => {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { ok: true };
  }
  if (Buffer.isBuffer(value)) return { ok: true };
  if (isMultipartFileValue(value)) return { ok: true };
  if (isMediaRefPlaceholder(value)) {
    return {
      ok: false,
      code: "model_input_multipart_unresolved_placeholder",
      message: `Multipart field ${fieldPath} contains unresolved MediaRefPlaceholder — file was not converted to Buffer`,
    };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const guarded = guardMultipartResidual(
        item,
        joinPublicUrlChildPath(fieldPath, index),
      );
      if (!guarded.ok) return guarded;
    }
    return { ok: true };
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const guarded = guardMultipartResidual(
        item,
        joinPublicUrlChildPath(fieldPath, key),
      );
      if (!guarded.ok) return guarded;
    }
    return { ok: true };
  }
  return { ok: true };
};

const guardUnresolvedPlaceholder = (
  value: unknown,
  fieldPath: string,
): GuardResult => {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { ok: true };
  }
  if (Buffer.isBuffer(value)) return { ok: true };
  if (isMultipartFileValue(value)) return { ok: true };
  if (isMediaRefPlaceholder(value)) {
    return {
      ok: false,
      code: "model_input_unresolved_placeholder",
      message: `Model input field ${fieldPath} contains unresolved MediaRefPlaceholder — placeholder was not materialized`,
    };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const guarded = guardUnresolvedPlaceholder(
        item,
        joinPublicUrlChildPath(fieldPath, index),
      );
      if (!guarded.ok) return guarded;
    }
    return { ok: true };
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const guarded = guardUnresolvedPlaceholder(
        item,
        joinPublicUrlChildPath(fieldPath, key),
      );
      if (!guarded.ok) return guarded;
    }
    return { ok: true };
  }
  return { ok: true };
};

const guardPreparedModelInput = (params: {
  body: unknown;
  policy: ModelInputPolicy;
}): GuardResult => {
  // input_uploads 字段残留检查已移除：body 中不再包含 input_uploads 映射表
  // token 残留检查已移除：body 中不再包含 __iart_input_upload__ token 字符串

  // 统一 MediaRefPlaceholder 残留检查：确保所有 transport 类型的占位符都已物化
  const allFields = [
    ...(params.policy.publicUrl ? params.policy.publicUrl.fields : []),
    ...(params.policy.multipartFiles ? params.policy.multipartFiles.fields : []),
    ...(params.policy.inlineData ? params.policy.inlineData.fields : []),
  ];
  for (const field of allFields) {
    const value = readRequestBodyPathValue(
      params.body,
      field.requestBodyPath,
    );
    const guarded = guardUnresolvedPlaceholder(value, field.targetPath);
    if (!guarded.ok) return guarded;
  }

  // multipart 残留检查：确保 multipart 目标字段中的 MediaRefPlaceholder 已被解析为 Buffer
  const multipartPolicy = params.policy.multipartFiles;
  if (multipartPolicy) {
    for (const field of multipartPolicy.fields) {
      const value = readRequestBodyPathValue(
        params.body,
        field.requestBodyPath,
      );
      const guarded = guardMultipartResidual(value, field.targetPath);
      if (!guarded.ok) return guarded;
    }
  }

  const publicUrlPolicy = params.policy.publicUrl;
  if (!publicUrlPolicy) return { ok: true };
  for (const field of publicUrlPolicy.fields) {
    const value = readRequestBodyPathValue(
      params.body,
      field.requestBodyPath,
    );
    const guarded = guardPublicUrlSubtree(value, field.targetPath);
    if (!guarded.ok) return guarded;
  }
  return { ok: true };
};

export { type GuardResult, guardPreparedModelInput };
