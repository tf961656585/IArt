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

const URL_ENCODED_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const PLAIN_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

type RequestBodyFormat = "json" | "multipart" | "form" | "text";
type FormFieldStyle = "dotted" | "bracket";
type FormArrayStyle = "repeat" | "bracket" | "index";

/**
 * 请求体序列化所需的形态声明（来自组装期的 `submit_request` / 轮询请求）。
 *
 * 表单正文**不得在组装期提前序列化成字符串**：模型 ID 注入发生在发送前（body 对象上的
 * `{{model_id}}` 规则值），先序列化会让注入落到一个已经编码好的字符串上。
 */
type RequestBodyEncodingOptions = {
  payloadFormat: string | undefined;
  formFieldStyle: string | undefined;
  formArrayStyle: string | undefined;
};

const DEFAULT_REQUEST_BODY_ENCODING: RequestBodyEncodingOptions = {
  payloadFormat: undefined,
  formFieldStyle: undefined,
  formArrayStyle: undefined,
};

const normalizeBodyFormat = (value: unknown): RequestBodyFormat => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "multipart" || normalized === "form" || normalized === "text") {
    return normalized;
  }
  // 历史 `stream` 等声明按 JSON 处理（与改造前一致：只认 multipart 特例）。
  return "json";
};

const normalizeFormFieldStyle = (value: unknown): FormFieldStyle =>
  normalizeString(value).toLowerCase() === "bracket" ? "bracket" : "dotted";

const normalizeFormArrayStyle = (value: unknown): FormArrayStyle => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "bracket" || normalized === "index") return normalized;
  return "repeat";
};

const appendFormEntries = (
  params: URLSearchParams,
  key: string,
  value: unknown,
  fieldStyle: FormFieldStyle,
  arrayStyle: FormArrayStyle,
): void => {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const arrayKey =
        arrayStyle === "bracket"
          ? `${key}[]`
          : arrayStyle === "index"
            ? `${key}[${index}]`
            : key;
      appendFormEntries(params, arrayKey, item, fieldStyle, arrayStyle);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const nextKey =
        key.length === 0
          ? childKey
          : fieldStyle === "bracket"
            ? `${key}[${childKey}]`
            : `${key}.${childKey}`;
      appendFormEntries(params, nextKey, childValue, fieldStyle, arrayStyle);
    }
    return;
  }
  params.append(key, String(value));
};

/**
 * `application/x-www-form-urlencoded` 正文编码。
 *
 * - 嵌套对象：`dotted` → `options.size`，`bracket` → `options[size]`；
 * - 数组：`repeat` → `tag=a&tag=b`，`bracket` → `tag[]=a&tag[]=b`，`index` → `tag[0]=a&tag[1]=b`；
 * - 标量 `String()`；`undefined` / `null` 跳过；空字符串保留。
 *
 * 根必须是对象：表单正文由字段构成，标量没有可命名的键（静默包一层会造出用户没声明的字段名）。
 */
const encodeUrlEncodedFormBody = (
  body: unknown,
  options: RequestBodyEncodingOptions,
): string => {
  if (!isRecord(body)) {
    throw new Error("form payload_format requires an object request body");
  }
  const params = new URLSearchParams();
  appendFormEntries(
    params,
    "",
    body,
    normalizeFormFieldStyle(options.formFieldStyle),
    normalizeFormArrayStyle(options.formArrayStyle),
  );
  return params.toString();
};

const readRequestBodyEncodingOptions = (request: unknown): RequestBodyEncodingOptions => {
  if (!isRecord(request)) return DEFAULT_REQUEST_BODY_ENCODING;
  return {
    payloadFormat: normalizeString(Reflect.get(request, "payload_format")) || undefined,
    formFieldStyle: normalizeString(Reflect.get(request, "form_field_style")) || undefined,
    formArrayStyle: normalizeString(Reflect.get(request, "form_array_style")) || undefined,
  };
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
  options: RequestBodyEncodingOptions = DEFAULT_REQUEST_BODY_ENCODING,
): BodyInit | undefined => {
  if (body === undefined || body === null) return undefined;
  if (isSerializedFormDataBody(body)) {
    stripContentTypeHeader(headers);
    return buildFormDataFromSerialized(body.__formData);
  }
  const payloadFormat = normalizeBodyFormat(options.payloadFormat);
  if (payloadFormat === "form") {
    if (!headers.has("content-type")) {
      headers.set("content-type", URL_ENCODED_FORM_CONTENT_TYPE);
    }
    return encodeUrlEncodedFormBody(body, options);
  }
  if (payloadFormat === "text") {
    if (typeof body !== "string") {
      throw new Error("text payload_format requires a string request body");
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", PLAIN_TEXT_CONTENT_TYPE);
    }
    return body;
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
  const requestPayloadFormat: unknown = Reflect.get(requestValue, "payload_format");
  const requestFormFieldStyle: unknown = Reflect.get(requestValue, "form_field_style");
  const requestFormArrayStyle: unknown = Reflect.get(requestValue, "form_array_style");
  return {
    url: cloneValue(requestValue.url ?? null),
    method: cloneValue(requestValue.method ?? null),
    headers: cloneValue(requestValue.headers ?? null),
    body,
    // 请求体形态随记录保存：发送期据此序列化（multipart / 表单 / 纯文本），
    // 缺省（历史记录）按 JSON 处理。
    payload_format: cloneValue(requestPayloadFormat ?? null),
    form_field_style: cloneValue(requestFormFieldStyle ?? null),
    form_array_style: cloneValue(requestFormArrayStyle ?? null),
  };
};

export {
  type SerializedFormDataBody,
  type RequestBodyEncodingOptions,
  DEFAULT_REQUEST_BODY_ENCODING,
  buildFormDataFromSerialized,
  flattenHeaders,
  isTextContentType,
  isSerializedFormDataBody,
  buildRequestBody,
  encodeUrlEncodedFormBody,
  readRequestBodyEncodingOptions,
  isJsonContentType,
  isLikelyCompleteJsonFile,
  projectSerializedFormDataField,
  projectSerializedFormDataBody,
  projectTaskRequest,
};
