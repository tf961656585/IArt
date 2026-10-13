import {
  normalizeString,
  isPlainObject,
  looksLikeBase64,
  parseDataUrlSource,
  isSerializedFormDataBody,
  type SerializedFormData,
  type SerializedFormDataField,
} from "@iart/contracts";
import {
  cloneValue,
  parsePath as parsePathShared,
  readOpenField as readField,
} from "../request-assembler-shared.cts";

type DynamicObject = object;

type PathSegment = string | number;

const writeField = (target: unknown, key: string, value: unknown) => {
  if (!isPlainObject(target)) return;
  Reflect.set(target, key, value);
};

const cloneJsonValue = cloneValue;

const asSerializedFormData = (value: unknown): SerializedFormData | null =>
  isPlainObject(value) ? (value as SerializedFormData) : null;

const asSerializedFormDataField = (value: unknown): SerializedFormDataField | null =>
  isPlainObject(value) ? (value as SerializedFormDataField) : null;

const parsePath = parsePathShared;

const readPathValue = (source: unknown, rawPath: unknown): unknown => {
  const segments = parsePath(rawPath);
  if (segments.length === 0) return undefined;
  let current = source;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = readField(current, segment);
  }
  return current;
};

const ensureChildContainer = (
  parent: unknown,
  segment: PathSegment,
  nextSegment: PathSegment,
): unknown => {
  if (typeof segment === "number") {
    if (!Array.isArray(parent)) return undefined;
    if (parent[segment] === undefined || parent[segment] === null) {
      parent[segment] = typeof nextSegment === "number" ? [] : {};
    }
    return parent[segment];
  }
  if (!isPlainObject(parent)) return undefined;
  const existing = readField(parent, segment);
  if (!isPlainObject(existing) && !Array.isArray(existing)) {
    writeField(parent, segment, typeof nextSegment === "number" ? [] : {});
  }
  return readField(parent, segment);
};

const writePathValue = (target: unknown, rawPath: unknown, value: unknown) => {
  const segments = parsePath(rawPath);
  if (segments.length === 0) return;
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (segment === undefined || nextSegment === undefined) return;
    current = ensureChildContainer(current, segment, nextSegment);
    if (current === undefined) return;
  }
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  if (typeof last === "number") {
    if (Array.isArray(current)) current[last] = value;
    return;
  }
  writeField(current, last, value);
};

const looksLikeRemoteUrl = (value: unknown) =>
  /^https?:\/\//i.test(normalizeString(value));

const stripPayloadBodyPrefix = (targetPath: string) => {
  const normalized = normalizeString(targetPath);
  if (normalized === "body") return "";
  if (normalized.startsWith("body.")) return normalized.slice("body.".length);
  if (normalized.startsWith("/body/"))
    return normalized.slice("/body/".length).replaceAll("/", ".");
  return "";
};

/* ── body projection (merged from model-input-body-projection.cts) ── */

const readSerializedFormDataFields = (body: unknown): unknown[] => {
  if (!isSerializedFormDataBody(body)) return [];
  const form = asSerializedFormData(readField(body, "__formData"));
  if (form === null) return [];
  return Array.isArray(form.fields) ? form.fields : [];
};

const formFieldNameFromRequestBodyPath = (requestBodyPath: string): string => {
  const segments = parsePath(requestBodyPath);
  if (segments.length === 0) return "";
  return segments
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join("");
};

const createSerializedFormDataField = (name: string, value: unknown): SerializedFormDataField => ({
  name,
  value,
});

const readSerializedFormDataFieldValue = (
  body: unknown,
  requestBodyPath: string,
): unknown => {
  const fieldName = formFieldNameFromRequestBodyPath(requestBodyPath);
  if (!fieldName) return undefined;
  const values = readSerializedFormDataFields(body)
    .map((field) => asSerializedFormDataField(field))
    .filter(
      (field): field is SerializedFormDataField =>
        normalizeString((field !== null && field !== undefined ? field.name : undefined)) === fieldName,
    )
    .map((field) => field.value);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
};

const writeSerializedFormDataFieldValue = (
  body: unknown,
  requestBodyPath: string,
  value: unknown,
): void => {
  const fieldName = formFieldNameFromRequestBodyPath(requestBodyPath);
  if (!fieldName || !isSerializedFormDataBody(body)) return;
  const form = asSerializedFormData(readField(body, "__formData"));
  const fields = form !== null && Array.isArray(form.fields) ? form.fields : [];
  const nextFields: unknown[] = [];
  let written = false;
  const values = Array.isArray(value) ? value : [value];
  for (const field of fields) {
    const fieldValue = asSerializedFormDataField(field);
    if (normalizeString((fieldValue !== null && fieldValue !== undefined ? fieldValue.name : undefined)) !== fieldName) {
      nextFields.push(cloneJsonValue(field));
      continue;
    }
    if (!written) {
      values.forEach((item) => {
        if (item !== undefined && item !== null) {
          nextFields.push(createSerializedFormDataField(fieldName, item));
        }
      });
      written = true;
    }
  }
  if (!written) {
    values.forEach((item) => {
      if (item !== undefined && item !== null) {
        nextFields.push(createSerializedFormDataField(fieldName, item));
      }
    });
  }
  if (form) {
    writeField(form, "fields", nextFields);
  }
};

const readRequestBodyPathValue = (
  body: unknown,
  requestBodyPath: string,
): unknown => {
  if (isSerializedFormDataBody(body)) {
    return readSerializedFormDataFieldValue(body, requestBodyPath);
  }
  return readPathValue(body, requestBodyPath);
};

const writeRequestBodyPathValue = (
  body: unknown,
  requestBodyPath: string,
  value: unknown,
): void => {
  if (isSerializedFormDataBody(body)) {
    writeSerializedFormDataFieldValue(body, requestBodyPath, value);
    return;
  }
  writePathValue(body, requestBodyPath, value);
};

export {
  type DynamicObject,
  normalizeString,
  isPlainObject,
  readField,
  writeField,
  cloneJsonValue,
  isSerializedFormDataBody,
  parsePath,
  readPathValue,
  writePathValue,
  looksLikeRemoteUrl,
  parseDataUrlSource,
  looksLikeBase64 as looksLikeBareBase64,
  stripPayloadBodyPrefix,
  readRequestBodyPathValue,
  writeRequestBodyPathValue,
};
