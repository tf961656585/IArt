import fs from "node:fs";
import {
  isMediaRefPlaceholder,
  type MediaRefSource,
  parseDataUrlSource,
  type SerializedFormDataBody,
} from "@iart/contracts";
import {
  isPlainObject,
  looksLikeRemoteUrl,
  normalizeString,
  type DynamicObject,
  writeField,
} from "./model-input-source.cts";
import { joinPublicUrlChildPath } from "./model-input-policy.cts";
import { resolveImageProcessingSource } from "../image-processing-source-resolver.cts";

type AtomPreparationResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string };

type MultipartFilePreparationContext = {
  projectPath: unknown;
};

type MultipartResolveError = {
  ok: false;
  reason: string;
  sourceKind: string;
};

const parseDataUrlToBuffer = (value: string): Buffer | null => {
  const parsed = parseDataUrlSource(value);
  if (parsed === null) return null;
  try {
    return Buffer.from(parsed.data, "base64");
  } catch (_error: unknown) {
    return null;
  }
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
    if (looksLikeRemoteUrl(source.url)) {
      return { ok: false, reason: `remote URL cannot be resolved to local file: ${source.url}`, sourceKind: "url" };
    }
    try {
      const resolved = resolveImageProcessingSource(normalizedProjectPath, source.url);
      const filePath = resolved.sourceFilePath;
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, reason: `local file not found for url source: ${source.url}`, sourceKind: "url" };
      }
      if (!fs.statSync(filePath).isFile()) {
        return { ok: false, reason: `resolved path is not a file: ${filePath}`, sourceKind: "url" };
      }
      return fs.readFileSync(filePath);
    } catch (error: unknown) {
      return {
        ok: false,
        reason: `failed to read local file for url source ${source.url}: ${error instanceof Error && error.message ? error.message : "unknown error"}`,
        sourceKind: "url",
      };
    }
  }
  return { ok: false, reason: "unsupported source kind", sourceKind: "unknown" };
};

const prepareMultipartFileSubtree = async (
  context: MultipartFilePreparationContext,
  value: unknown,
  fieldPath: string,
): Promise<AtomPreparationResult> => {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value };
  }

  // 检测 MediaRefPlaceholder 对象
  const isPlaceholder = isMediaRefPlaceholder(value);
  if (isPlaceholder) {
    const bufferOrError = resolveMultipartFileBuffer(value.source, context.projectPath);
    if (bufferOrError instanceof Buffer) {
      return { ok: true, value: bufferOrError };
    }
    if ("ok" in bufferOrError && bufferOrError.ok === false) {
      return {
        ok: false,
        code: "multipart_file_resolve_failed",
        message: `Failed to resolve multipart file: ${bufferOrError.reason}`,
      };
    }
    return {
      ok: false,
      code: "multipart_file_resolve_failed",
      message: "Failed to resolve multipart file: unknown error",
    };
  }

  if (typeof value === "string") {
    const parsed = parseDataUrlToBuffer(value);
    if (parsed !== null) {
      return { ok: true, value: parsed };
    }
    return { ok: true, value };
  }
  if (Array.isArray(value)) {
    const results: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const prepared = await prepareMultipartFileSubtree(
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
    const preparedObject: DynamicObject = {};
    for (const [key, item] of Object.entries(value)) {
      const prepared = await prepareMultipartFileSubtree(
        context,
        item,
        joinPublicUrlChildPath(fieldPath, key),
      );
      if (!prepared.ok) return prepared;
      writeField(preparedObject, key, prepared.value);
    }
    return { ok: true, value: preparedObject };
  }
  return { ok: true, value };
};

const collectFormDataEntries = (
  value: unknown,
  parentKey: string,
  entries: Array<{ key: string; value: unknown }>,
  repeatedTopLevelKeys: ReadonlySet<string>,
  isTopLevel: boolean,
) => {
  if (value === undefined || value === null) return;
  if (Buffer.isBuffer(value)) {
    entries.push({ key: parentKey, value });
    return;
  }
  if (Array.isArray(value)) {
    // 仅在声明了 multipart_array_naming=repeated 的顶层字段上，
    // 数组展开为同名重复 part；其余维持 indexed（兼容既有行为）。
    const useRepeated = isTopLevel && repeatedTopLevelKeys.has(parentKey);
    for (const [index, item] of value.entries()) {
      const childKey = useRepeated ? parentKey : `${parentKey}[${index}]`;
      collectFormDataEntries(item, childKey, entries, repeatedTopLevelKeys, false);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childKey = parentKey ? `${parentKey}.${key}` : key;
      collectFormDataEntries(item, childKey, entries, repeatedTopLevelKeys, false);
    }
    return;
  }
  entries.push({ key: parentKey, value });
};

const EMPTY_REPEATED_KEYS: ReadonlySet<string> = new Set<string>();

const convertBodyToSerializedFormData = (
  body: DynamicObject,
  repeatedTopLevelKeys: ReadonlySet<string> = EMPTY_REPEATED_KEYS,
): SerializedFormDataBody => {
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const [key, item] of Object.entries(body)) {
    collectFormDataEntries(item, key, entries, repeatedTopLevelKeys, true);
  }
  const fields: Array<{ name: string; value: string }> = [];
  const files: Array<{ name: string; dataBase64: string; contentType: string; filename: string }> = [];
  for (const entry of entries) {
    if (Buffer.isBuffer(entry.value)) {
      files.push({
        name: entry.key,
        dataBase64: entry.value.toString("base64"),
        contentType: "application/octet-stream",
        filename: "file",
      });
    } else {
      const stringValue = (entry.value === undefined || entry.value === null)
        ? ""
        : String(entry.value);
      fields.push({ name: entry.key, value: stringValue });
    }
  }
  return {
    __formData: { fields, files },
  };
};

export {
  type MultipartFilePreparationContext,
  convertBodyToSerializedFormData,
  prepareMultipartFileSubtree,
};
