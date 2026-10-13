import { createHash } from "node:crypto";
import { cloneJsonValue } from "@iart/contracts";

type JsonRecord = Record<string, unknown>;
type MediaDownloadView = {
  candidates: unknown | undefined;
  assetId: unknown | undefined;
  fileKey: unknown | undefined;
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
};
type RequestView = {
  method: unknown | undefined;
  url: unknown | undefined;
  headers: unknown | undefined;
  body: unknown | undefined;
};
type ResponseView = {
  status: unknown | undefined;
  ok: unknown | undefined;
  contentType: unknown | undefined;
  bodyType: unknown | undefined;
  size: unknown | undefined;
  receivedAt: unknown | undefined;
  attempt: unknown | undefined;
  body: unknown | undefined;
  file: unknown | undefined;
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
  mediaDownload: unknown | undefined;
  pollingCompletion: unknown | undefined;
};

const MAX_PREVIEW_LENGTH = 256;
const MAX_ARRAY_PREVIEW = 6;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const isPlainObject = (value: unknown): value is JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const safeSerialize = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const digestValue = (value: unknown) => {
  const serialized = safeSerialize(value);
  return {
    sha256: serialized ? createHash("sha256").update(serialized).digest("hex") : null,
    size: serialized ? Buffer.byteLength(serialized) : 0,
  };
};

const summarizeArchiveValue = (value: unknown, key = "root"): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= MAX_PREVIEW_LENGTH) return value;
    return {
      kind: "text_summary",
      size: value.length,
      preview: value.slice(0, MAX_PREVIEW_LENGTH),
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const preview = value.slice(0, MAX_ARRAY_PREVIEW).map((item) => summarizeArchiveValue(item, key));
    const serialized = safeSerialize(value);
    return {
      kind: "array_summary",
      length: value.length,
      size: serialized ? Buffer.byteLength(serialized) : 0,
      preview,
    };
  }
  if (!isPlainObject(value)) return cloneValue(value);
  if (key === "headers") {
    return {
      names: Object.keys(value).sort(),
    };
  }
  if (key === "mediaDownload") {
    const download = value as MediaDownloadView;
    const candidates = Array.isArray(download.candidates) ? download.candidates : [];
    return {
      candidateCount: candidates.length,
      selectedAssetId: normalizeString(download.assetId) || null,
      selectedFileKey: normalizeString(download.fileKey) || null,
      localOutput: summarizeArchiveValue(download.localOutput, "localOutput"),
      localOutputs: summarizeArchiveValue(download.localOutputs, "localOutputs"),
    };
  }
  const result: JsonRecord = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (nestedKey === "dataBase64") {
      result[nestedKey] = {
        kind: "omitted_base64",
        size: typeof nestedValue === "string" ? nestedValue.length : null,
      };
      continue;
    }
    result[nestedKey] = summarizeArchiveValue(nestedValue, nestedKey);
  }
  const digest = digestValue(result);
  const serialized = safeSerialize(result);
  if (serialized.length > 4096) {
    return {
      kind: "object_summary",
      keys: Object.keys(result).sort(),
      sha256: digest.sha256,
      size: digest.size,
    };
  }
  return result;
};

const summarizeArchiveRequest = (request: unknown) => {
  if (!isPlainObject(request)) return summarizeArchiveValue(request, "request");
  const requestView = request as RequestView;
  return {
    method: normalizeString(requestView.method) || null,
    url: normalizeString(requestView.url) || null,
    headers: summarizeArchiveValue(requestView.headers, "headers"),
    body: summarizeArchiveValue(requestView.body, "body"),
  };
};

const summarizeArchiveResponse = (response: unknown) => {
  if (!isPlainObject(response)) return null;
  const responseView = response as ResponseView;
  const bodyDigest = digestValue(responseView.body ?? null);
  return {
    status: typeof responseView.status === "number" && Number.isFinite(responseView.status) ? responseView.status : null,
    ok: typeof responseView.ok === "boolean" ? responseView.ok : null,
    contentType: normalizeString(responseView.contentType) || null,
    bodyType: normalizeString(responseView.bodyType) || null,
    size: typeof responseView.size === "number" && Number.isFinite(responseView.size) ? responseView.size : bodyDigest.size,
    receivedAt: normalizeString(responseView.receivedAt) || null,
    attempt: typeof responseView.attempt === "number" && Number.isFinite(responseView.attempt) ? responseView.attempt : null,
    bodySummary: summarizeArchiveValue(responseView.body, "body"),
    bodySha256: bodyDigest.sha256,
    file: summarizeArchiveValue(responseView.file, "file"),
    localOutput: summarizeArchiveValue(responseView.localOutput, "localOutput"),
    localOutputs: summarizeArchiveValue(responseView.localOutputs, "localOutputs"),
    mediaDownload: summarizeArchiveValue(responseView.mediaDownload, "mediaDownload"),
    pollingCompletion: summarizeArchiveValue(responseView.pollingCompletion, "pollingCompletion"),
  };
};

export {
  summarizeArchiveRequest,
  summarizeArchiveResponse,
  summarizeArchiveValue,
};
