import { isRecord, type DynamicRecord, type UnknownRecord } from "@/client/utils/typeGuards";
import {
  normalizeMediaInput,
  type NormalizedMediaItem,
  resolveAllNormalizedMediaReferences,
} from "@/features/models/shared/mediaReferenceResolver";
import type { UploadFileItem } from "@/features/canvas/services/mediaDataContract";
import type {
  AttachmentMeta,
  MediaResolutionError,
} from "@/features/models/shared/mediaResolutionTypes";
import { formatMediaResolutionErrorsForUser } from "@/features/models/shared/mediaResolutionTypes";

export type InlineData = { mime_type: string; data: string };
type InlineDataCandidate = UnknownRecord & {
  inline_data: unknown | undefined;
  mime_type: unknown | undefined;
  data: unknown | undefined;
  src: unknown | undefined;
};
export type ModelFormValues = UnknownRecord & {
  mode: unknown | undefined;
  systemPrompt: unknown | undefined;
  duration: unknown | undefined;
  aspectRatio: unknown | undefined;
  stylePreset: unknown | undefined;
  cameraMotion: unknown | undefined;
  audioProfile: unknown | undefined;
  negativePrompt: unknown | undefined;
  storyBeats: unknown | undefined;
  referenceNotes: unknown | undefined;
};

export type FilesToInlineDataListWithMetaResult = {
  inlineDataList: InlineData[];
  attachmentMetas: AttachmentMeta[];
  errors: MediaResolutionError[];
};

export interface FormTransformContext {
  fieldId: string | undefined;
  values: UnknownRecord;
  options: DynamicRecord | undefined;
}

export const createTransformContext = (
  fieldId: string,
  values: UnknownRecord,
  options: DynamicRecord | undefined
): FormTransformContext => ({
  fieldId: fieldId || undefined,
  values,
  options,
});

const isInlineDataObject = (value: unknown): value is InlineData => {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const candidate = value as InlineDataCandidate;
  const mime = candidate.mime_type;
  const data = candidate.data;
  return typeof mime === "string" && typeof data === "string" && mime.trim() !== "" && data.trim() !== "";
};

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const encodeStringToBase64 = (value: string): string | null => {
  try {
    if (typeof btoa === "function") {
      return btoa(value);
    }
  } catch {
    // ignore
  }
  return null;
};

const inferMimeTypeFromBase64 = (raw: string): string | undefined => {
  const prefix = raw.trim().slice(0, 16);
  if (!prefix) return undefined;
  // JPEG: FF D8 FF => /9j/
  if (prefix.startsWith("/9j/")) return "image/jpeg";
  // PNG: 89 50 4E 47 => iVBORw0KGgo
  if (prefix.startsWith("iVBORw0KGgo")) return "image/png";
  // GIF: GIF87a/GIF89a => R0lGOD
  if (prefix.startsWith("R0lGOD")) return "image/gif";
  return undefined;
};

const parseDataUrlToInlineData = (raw: string, mimeHint: string | undefined): InlineData | null => {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("data:")) return null;

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) return null;

  const meta = trimmed.slice(5, commaIndex);
  const dataPart = trimmed.slice(commaIndex + 1);
  if (!dataPart) return null;

  const metaParts = meta.split(";");
  const metaMime = metaParts[0] !== undefined ? metaParts[0].trim() : "";
  const normalizedHint = mimeHint !== undefined ? mimeHint.trim() : "";
  const mimeType = metaMime || normalizedHint || "application/octet-stream";
  const isBase64 = metaParts.slice(1).some((part) => part.toLowerCase() === "base64");

  if (isBase64) {
    return { mime_type: mimeType, data: dataPart };
  }

  try {
    const decoded = decodeURIComponent(dataPart);
    const encoded = encodeStringToBase64(decoded);
    return encoded ? { mime_type: mimeType, data: encoded } : null;
  } catch {
    return null;
  }
};

const parseBase64StringToInlineData = (raw: string, mimeHint: string | undefined): InlineData | null => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith("data:")) return null;
  if (trimmed.length < 16 || !BASE64_REGEX.test(trimmed)) return null;
  const normalizedHint = mimeHint !== undefined ? mimeHint.trim() : "";
  return {
    mime_type: normalizedHint || inferMimeTypeFromBase64(trimmed) || "application/octet-stream",
    data: trimmed,
  };
};

const inferMimeTypeFromUrl = (raw: string): string | undefined => {
  const url = raw.trim();
  if (!url) return undefined;
  const lower = url.toLowerCase();
  if (lower.startsWith("data:")) return undefined;

  const urlWithoutQuery = url.split("?")[0];
  const withoutQuery = (urlWithoutQuery !== undefined ? urlWithoutQuery.split("#")[0] : url) || url;
  const match = withoutQuery.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = (match !== null && match !== undefined ? match[1] : undefined);
  if (!ext) return undefined;

  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "avif":
      return "image/avif";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "m4v":
      return "video/x-m4v";
    default:
      return undefined;
  }
};

const coerceInlineData = (candidate: unknown): InlineData | null => {
  if (typeof candidate === "string") {
    return parseDataUrlToInlineData(candidate, undefined) ?? parseBase64StringToInlineData(candidate, undefined);
  }

  if (!isRecord(candidate) || Array.isArray(candidate)) {
    return null;
  }

  const rawCandidate = candidate as InlineDataCandidate;
  const inlineDataField = rawCandidate.inline_data;
  if (isInlineDataObject(inlineDataField)) {
    return inlineDataField;
  }

  if (isInlineDataObject(rawCandidate)) {
    return rawCandidate;
  }

  const mimeType = rawCandidate.mime_type;
  const mimeHint = typeof mimeType === "string" ? mimeType : undefined;

  const data = rawCandidate.data;
  if (typeof data === "string" && mimeHint) {
    return { mime_type: mimeHint.trim(), data };
  }

  const src = rawCandidate.src;
  if (typeof src === "string") {
    return parseDataUrlToInlineData(src, mimeHint) ?? parseBase64StringToInlineData(src, mimeHint);
  }

  return null;
};

/**
 * 将标准化媒体项转为 UploadFileItem 格式
 * 内部调用 mediaDataContract.normalizeMediaInput
 */
const normalizeUploadItems = (value: unknown): UploadFileItem[] => {
  const items = normalizeMediaInput(value, undefined);
  return items.map((item: NormalizedMediaItem) => {
    const id = item.id || undefined;
    switch (item.source.type) {
      case "file":
        return { id, file: item.source.file, src: undefined };
      case "url":
        return { id, file: undefined, src: item.source.url };
      default: {
        const exhaustiveCheck: never = item.source;
        void exhaustiveCheck;
        return { id, file: undefined, src: undefined };
      }
    }
  });
};

const INVALID_MEDIA_ITEM_ERROR_MESSAGE = "这份素材的类型不支持，请重新选择文件";

const isRuntimeBlobLike = (value: unknown): value is Blob | File =>
  typeof Blob !== "undefined" && value instanceof Blob;

const readAsDataURL = (candidate: unknown): Promise<string> => {
  if (!isRuntimeBlobLike(candidate)) {
    throw new Error(INVALID_MEDIA_ITEM_ERROR_MESSAGE);
  }

  if (typeof FileReader === "undefined") {
    return candidate.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      if (typeof btoa !== "function") {
        throw new Error("读不出这份文件的内容，请重新选择后再试");
      }
      return btoa(binary);
    });
  }

  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const result = fr.result as string;
      const idx = result.indexOf(",");
      const base64 = idx >= 0 ? result.slice(idx + 1) : result;
      resolve(base64);
    };
    fr.onerror = (e) => reject(e);
    fr.readAsDataURL(candidate);
  });
};

export const fileToBase64Object = async (
  value: unknown
): Promise<{ mime_type: string; data: string } | null> => {
  const items = normalizeUploadItems(value);
  if (items.length === 0) return null;
  const first = items[0];
  const file = (first !== null && first !== undefined ? first.file : undefined);
  if (!file) return null;

  const base64 = await readAsDataURL(file);
  return {
    mime_type: file.type || "application/octet-stream",
    data: base64,
  };
};

/**
 * 将媒体输入转为 inline_data 格式数组
 * 重构后：统一通过解析层获取数据
 */
export const filesToInlineDataList = async (
  value: unknown,
  opts: { limit: number | undefined } | undefined
): Promise<Array<{ mime_type: string; data: string }>> => {
  const { inlineDataList, errors } = await filesToInlineDataListWithMeta(value, opts);
  if (errors.length > 0) {
    throw new Error(formatMediaResolutionErrorsForUser(errors));
  }
  return inlineDataList;
};

export const filesToInlineDataListWithMeta = async (
  value: unknown,
  opts: { limit: number | undefined } | undefined
): Promise<FilesToInlineDataListWithMetaResult> => {
  const rawLimit = opts !== null && opts !== undefined ? opts.limit : undefined;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.max(1, Math.round(rawLimit)) : undefined;

  const mkInlineMeta = (inline: InlineData): AttachmentMeta => ({
    id: undefined,
    sourceKind: "inline_data",
    url: undefined,
    mimeType: inline.mime_type,
    sizeBytes: undefined,
    hash: undefined,
    base64Bytes: inline.data.length,
  });

  // 1) 单值快速路径：支持 inline_data / data URL / base64 / 纯 URL / UploadFileItem / File
  if (!Array.isArray(value)) {
    const directInlineData = coerceInlineData(value);
    if (directInlineData) {
      return {
        inlineDataList: [directInlineData],
        attachmentMetas: [mkInlineMeta(directInlineData)],
        errors: [],
      };
    }

    const items = normalizeMediaInput(value, limit);
    if (items.length === 0) return { inlineDataList: [], attachmentMetas: [], errors: [] };

    const resolved = await resolveAllNormalizedMediaReferences(items, "upload-file");

    const inlineDataList: InlineData[] = [];
    const attachmentMetas: AttachmentMeta[] = [];

    for (const item of resolved.items) {
      if (typeof limit === "number" && inlineDataList.length >= limit) break;
      if (!item.file) continue;

      const base64 = await readAsDataURL(item.file);
      const mime_type =
        item.mimeType || (item.url ? inferMimeTypeFromUrl(item.url) : undefined) || "application/octet-stream";

      inlineDataList.push({ mime_type, data: base64 });
      attachmentMetas.push({
        ...item.meta,
        mimeType: mime_type,
        base64Bytes: base64.length,
      });
    }

    return { inlineDataList, attachmentMetas, errors: resolved.errors };
  }

  // 2. 优先检查原始输入中的 inline_data（数组场景）
  // normalizeMediaInput 不会识别 inline_data 对象，需要单独处理
  const rawArray = Array.isArray(value) ? value : [];
  const candidates = typeof limit === "number" ? rawArray.slice(0, limit) : rawArray;

  const inlineDataList: InlineData[] = [];
  const attachmentMetas: AttachmentMeta[] = [];
  const processedIndices = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    const inlineData = coerceInlineData(candidates[i]);
    if (inlineData) {
      inlineDataList.push(inlineData);
      attachmentMetas.push(mkInlineMeta(inlineData));
      processedIndices.add(i);
    }
  }

  // 当 limit 已被 inline_data 占满时直接返回
  if (typeof limit === "number" && inlineDataList.length >= limit) {
    return {
      inlineDataList: inlineDataList.slice(0, limit),
      attachmentMetas: attachmentMetas.slice(0, limit),
      errors: [],
    };
  }

  const remainingLimit = typeof limit === "number" ? Math.max(limit - inlineDataList.length, 0) : undefined;

  // 3. 规范化（使用剩余名额），排除已被 coerceInlineData 处理的项目
  const remainingItems = rawArray.filter((_, idx) => !processedIndices.has(idx));
  const items = normalizeMediaInput(remainingItems, remainingLimit);

  // 4. 没有可解析的媒体时，直接返回已有 inline_data
  if (items.length === 0) return { inlineDataList, attachmentMetas, errors: [] };

  // 5. 统一解析（下载 URL）
  const resolved = await resolveAllNormalizedMediaReferences(items, "upload-file");

  // 7. 格式转换
  for (const item of resolved.items) {
    if (typeof limit === "number" && inlineDataList.length >= limit) break;
    if (!item.file) continue;

    const base64 = await readAsDataURL(item.file);
    const mime_type =
      item.mimeType || (item.url ? inferMimeTypeFromUrl(item.url) : undefined) || "application/octet-stream";
    inlineDataList.push({ mime_type, data: base64 });
    attachmentMetas.push({
      ...item.meta,
      mimeType: mime_type,
      base64Bytes: base64.length,
    });
  }

  return typeof limit === "number"
    ? {
        inlineDataList: inlineDataList.slice(0, limit),
        attachmentMetas: attachmentMetas.slice(0, limit),
        errors: resolved.errors,
      }
    : {
        inlineDataList,
        attachmentMetas,
        errors: resolved.errors,
      };
};


export { normalizeUploadItems, readAsDataURL, inferMimeTypeFromUrl };
