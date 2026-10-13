import * as fs from "node:fs";
import {
  cloneValue,
  isRecord,
  TASK_RESULT_INLINE_LIMIT,
  toRecord,
} from "./task-engine-shared.cts";
import { normalizeString } from "./task-normalizer.cts";
import { logWarn } from "./logging.cts";
import {
  isSerializedFormDataBody,
  type SerializedFormDataBody,
} from "@iart/contracts";

const flattenHeaders = (headers: unknown): Headers => {
  const result = new Headers();
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => result.set(key, value));
    return result;
  }
  if (Array.isArray(headers)) {
    for (const item of headers) {
      if (!Array.isArray(item) || item.length < 2) continue;
      result.set(String(item[0]), String(item[1]));
    }
    return result;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        result.set(key, value.map((item) => String(item)).join(", "));
        continue;
      }
      result.set(key, String(value));
    }
  }
  return result;
};

const isTextContentType = (contentType: unknown) => {
  const normalized = normalizeString(contentType).toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("text/")) return true;
  return (
    normalized.includes("application/json") ||
    normalized.includes("+json") ||
    normalized.includes("application/xml") ||
    normalized.includes("+xml")
  );
};

const stripContentTypeHeader = (headers: Headers) => {
  headers.delete("content-type");
};

const buildFormDataFromSerialized = (payload: unknown) => {
  const payloadValue = toRecord(payload);
  const form = new FormData();
  const fields: unknown[] = Array.isArray(payloadValue.fields)
    ? payloadValue.fields
    : [];
  const files: unknown[] = Array.isArray(payloadValue.files)
    ? payloadValue.files
    : [];
  for (const field of fields) {
    const fieldValue = toRecord(field);
    const name = normalizeString(fieldValue.name);
    if (!name) continue;
    const value =
      fieldValue.value === undefined || fieldValue.value === null
        ? ""
        : String(fieldValue.value);
    form.append(name, value);
  }
  let filesAppended = 0;
  for (const file of files) {
    const fileValue = toRecord(file);
    const name = normalizeString(fileValue.name);
    const dataBase64 = normalizeString(fileValue.dataBase64);
    if (!name || !dataBase64) {
      logWarn("[task-engine-request] buildFormDataFromSerialized: skipping file entry with missing name or dataBase64", {
        name,
        hasData: Boolean(dataBase64),
      });
      continue;
    }
    let buffer;
    try {
      buffer = Buffer.from(dataBase64, "base64");
    } catch (error: unknown) {
      logWarn("[task-engine-request] buildFormDataFromSerialized: base64 decode failed for file", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const contentType =
      normalizeString(fileValue.contentType) || "application/octet-stream";
    const filename = normalizeString(fileValue.filename) || "file";
    const blob = new Blob([buffer], { type: contentType });
    form.append(name, blob, filename);
    filesAppended++;
  }
  if (files.length > 0 && filesAppended === 0) {
    throw new Error(
      `buildFormDataFromSerialized: all ${files.length} file(s) were skipped — expected at least one valid file entry`,
    );
  }
  return form;
};

const buildRequestBody = (
  body: unknown,
  headers: Headers,
): BodyInit | undefined => {
  if (body === undefined || body === null) return undefined;
  if (isSerializedFormDataBody(body)) {
    stripContentTypeHeader(headers);
    return buildFormDataFromSerialized(body.__formData);
  }
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return new Blob([bytes]);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
};

const isJsonContentType = (value: unknown) => {
  const normalized = normalizeString(value).toLowerCase();
  return normalized.includes("application/json") || normalized.includes("+json");
};

const isLikelyCompleteJsonFile = (filePath: unknown) => {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(normalizedPath, "r");
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size <= 0) return false;
    const readSize = Math.min(stats.size, TASK_RESULT_INLINE_LIMIT);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    const text = buffer.toString("utf-8").trimEnd();
    return text.endsWith("}") || text.endsWith("]");
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        void 0;
      }
    }
  }
};

const projectSerializedFormDataField = (field: unknown, value: unknown) => {
  if (!isRecord(field)) return field;
  return { name: cloneValue(field.name ?? null), value };
};

const projectSerializedFormDataFiles = (files: unknown) => {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    const fileValue = toRecord(file);
    return {
      name: cloneValue(fileValue.name ?? null),
      filename: cloneValue(fileValue.filename ?? null),
      contentType: cloneValue(fileValue.contentType ?? null),
      dataBase64: cloneValue(fileValue.dataBase64 ?? null),
    };
  });
};

const projectSerializedFormDataBody = (body: unknown, fields: unknown[]) => {
  const payload = isSerializedFormDataBody(body) ? body.__formData : {};
  const payloadValue = toRecord(payload);
  return {
    __formData: {
      fields,
      files: projectSerializedFormDataFiles(payloadValue.files),
    },
  };
};

const projectTaskRequest = (request: unknown, body: unknown) => {
  const requestValue = toRecord(request);
  return {
    url: cloneValue(requestValue.url ?? null),
    method: cloneValue(requestValue.method ?? null),
    headers: cloneValue(requestValue.headers ?? null),
    body,
  };
};

export {
  type SerializedFormDataBody,
  buildFormDataFromSerialized,
  flattenHeaders,
  isTextContentType,
  isSerializedFormDataBody,
  buildRequestBody,
  isJsonContentType,
  isLikelyCompleteJsonFile,
  projectSerializedFormDataField,
  projectSerializedFormDataBody,
  projectTaskRequest,
};
