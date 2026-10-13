import { isRecord } from "@/client/utils/typeGuards";
import {
  assertMediaReferencesResolved,
  normalizeMediaInput,
  normalizeMediaReferences,
  resolveAllMediaReferences,
  resolveFirstMediaReference,
  type ResolvedTargetMediaReference,
} from "@/features/models/shared/mediaReferenceResolver";
import {
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
  type ModelAssetUrlInputUploadMode,
} from "@iart/contracts/model-asset-contract";
import {
  filesToInlineDataList,
  filesToInlineDataListWithMeta,
  inferMimeTypeFromUrl,
  normalizeUploadItems,
  readAsDataURL,
  type FormTransformContext,
  type ModelFormValues,
} from "@/features/models/shared/formTransformsInlineData";

export {
  fileToBase64Object,
  filesToInlineDataListWithMeta,
  type FilesToInlineDataListWithMetaResult,
} from "@/features/models/shared/formTransformsInlineData";
export {
  filesToInlineDataList,
  inferMimeTypeFromUrl,
  normalizeUploadItems,
  readAsDataURL,
};
export type { FormTransformContext, ModelFormValues } from "@/features/models/shared/formTransformsInlineData";

export interface ExtractUploadUrlOptions {
  uploadMode: ModelAssetUrlInputUploadMode | undefined;
  fieldPath: string | undefined;
  /** media_target 为 inline_data/file_data_uri 时为 true：
   *  Editor 直接透传本地媒体引用给后端物化，不做 remote-url 公网 URL 校验。 */
  passThroughLocalMedia?: boolean;
}

const mediaItemToDataUrl = async (
  item: ResolvedTargetMediaReference,
): Promise<string> => {
  if (!item.file) {
    throw new Error("这份素材读不出文件内容，请重新上传后再试。");
  }
  const mimeType = item.mimeType || item.file.type || "application/octet-stream";
  const dataUrl = await readAsDataURL(item.file);
  return `data:${mimeType};base64,${dataUrl}`;
};

export const extractUrlsFromUpload = async (
  value: unknown,
  options: ExtractUploadUrlOptions | undefined
): Promise<string[]> => {
  if (normalizeMediaInput(value, undefined).length === 0) return [];

  const uploadMode = (options !== null && options !== undefined ? options.uploadMode : undefined);

  if (uploadMode === MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY) {
    // 前端直接传递 data URL，后端负责识别并上传到公网
    const resolved = await resolveAllMediaReferences(value, "upload-file", undefined);
    assertMediaReferencesResolved(resolved.errors);
    const urls: string[] = [];
    for (let index = 0; index < resolved.items.length; index++) {
      const item = resolved.items[index];
      if (!item) continue;
      urls.push(await mediaItemToDataUrl(item));
    }
    return urls;
  }

  if (options?.passThroughLocalMedia) {
    // media_target=inline_data / file_data_uri：
    // Editor 直接透传本地媒体引用给后端物化，不做 remote-url 公网 URL 校验。
    // URL 字符串（local-media://、data:、http(s)://、blob:、file: 等）原样透传；
    // File/Blob 对象转为 data URL 透传（后端能从 data URL 构造 inline_data source）。
    const normalized = normalizeMediaReferences(value, undefined);
    assertMediaReferencesResolved(normalized.errors);
    const urls: string[] = [];
    for (const item of normalized.items) {
      if (item.source.type === "url") {
        urls.push(item.source.url);
      } else if (item.source.type === "file") {
        const file = item.source.file;
        const mimeType = file.type || "application/octet-stream";
        const base64 = await readAsDataURL(file);
        urls.push(`data:${mimeType};base64,${base64}`);
      }
    }
    return urls;
  }

  // 转换为第三方远端可消费 URL。本地项目媒体不再在这里直接透传。
  const resolved = await resolveAllMediaReferences(value, "remote-url", undefined);
  assertMediaReferencesResolved(resolved.errors);
  return resolved.items.map((item) => item.url).filter((url): url is string => Boolean(url));
};

const guessMediaExtension = (mimeType: string | undefined): string => {
  const lower = (mimeType || "").toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
  if (lower === "image/png") return "png";
  if (lower === "image/webp") return "webp";
  if (lower === "image/gif") return "gif";
  if (lower === "image/bmp") return "bmp";
  if (lower === "image/svg+xml") return "svg";
  if (lower === "image/avif") return "avif";
  if (lower === "audio/mpeg") return "mp3";
  if (lower === "audio/wav" || lower === "audio/x-wav") return "wav";
  if (lower === "video/quicktime") return "mov";
  const fallback = lower.split("/")[1];
  return fallback || "bin";
};

const buildMediaFilename = (mimeType: string | undefined, index: number): string => {
  const ext = guessMediaExtension(mimeType);
  return `media_${Date.now()}_${index}.${ext}`;
};

const createFileNameFromResolvedMedia = (
  item: ResolvedTargetMediaReference,
  index: number,
): string => {
  if (typeof File !== "undefined" && item.file instanceof File && item.file.name) {
    return item.file.name;
  }
  const urlWithoutQuery = typeof item.url === "string" ? item.url.split("?")[0] : "";
  const urlPath = (urlWithoutQuery !== undefined ? urlWithoutQuery.split("#")[0] : "") || "";
  const urlSegments = urlPath.split("/");
  const lastSegment = urlSegments[urlSegments.length - 1];
  const fromUrl = lastSegment !== undefined ? lastSegment.trim() : undefined;
  if (fromUrl && fromUrl.includes(".")) {
    return fromUrl;
  }
  return buildMediaFilename(item.mimeType || (item.file !== null && item.file !== undefined ? item.file.type : undefined), index);
};

const createFileFromBlob = (blob: Blob, name: string, mimeType: string | undefined): File => {
  const type = mimeType || blob.type || "application/octet-stream";
  if (typeof File !== "undefined") {
    return new File([blob], name, { type });
  }
  const fallback = new Blob([blob], { type }) as Blob & {
    name: string | undefined;
    lastModified: number | undefined;
  };
  fallback.name = name;
  fallback.lastModified = Date.now();
  return fallback as File;
};

const resolvedReferenceToFile = (
  item: ResolvedTargetMediaReference,
  index: number,
): File => {
  if (!item.file) {
    throw new Error("这份素材读不出文件内容，请重新上传后再试。");
  }
  if (typeof File !== "undefined" && item.file instanceof File) {
    return item.file;
  }
  return createFileFromBlob(item.file, createFileNameFromResolvedMedia(item, index), item.mimeType);
};

export const extractFirstUrlFromUpload = async (
  value: unknown,
  options: ExtractUploadUrlOptions | undefined
): Promise<string | undefined> => {
  const urls = await extractUrlsFromUpload(value, options);
  if (!Array.isArray(urls) || urls.length === 0) {
    return undefined;
  }
  return urls[0];
};

/**
 * 从上传值中提取第一个媒体并转为 base64 data URL 格式
 * 返回格式：data:{MIME_type};base64,{base64_data}
 * 用于 API 直接接受 base64 编码图像的场景（如阿里百炼 Wan 模型）
 */
export const extractFirstBase64DataUrl = async (
  value: unknown
): Promise<string | undefined> => {
  const { inlineDataList, errors } = await filesToInlineDataListWithMeta(value, { limit: 1 });
  assertMediaReferencesResolved(errors);
  if (inlineDataList.length === 0) {
    return undefined;
  }
  const [first] = inlineDataList;
  if (first === undefined) {
    return undefined;
  }
  return `data:${first.mime_type};base64,${first.data}`;
};

/**
 * 从上传值中提取第一个 File 对象（用于 multipart 表单提交）
 * - 优先使用已有的 file 对象
 * - 最后从 src URL 获取并转为 File
 */
export const extractFirstFileFromUpload = async (
  value: unknown
): Promise<File | undefined> => {
  const resolved = await resolveFirstMediaReference(value, "upload-file");
  assertMediaReferencesResolved(resolved.errors);
  return resolved.item ? resolvedReferenceToFile(resolved.item, 0) : undefined;
};

/**
 * 从上传值中提取所有 File 对象（用于 multipart 表单提交）
 * - 支持 UploadFileItem[] / File / Blob / URL 字符串 / data/blob/file//files/ URL
 * - 对 URL 会通过统一媒体解析层下载并转为 File
 */
export const extractFilesFromUpload = async (
  value: unknown,
  opts: { limit: number | undefined } | undefined
): Promise<File[]> => {
  const limit =
    typeof (opts !== null && opts !== undefined ? opts.limit : undefined) === "number" && Number.isFinite(opts !== undefined && opts !== null ? opts.limit : undefined)
      ? Math.max(1, Math.round((opts as { limit: number }).limit))
      : undefined;

  const resolved = await resolveAllMediaReferences(value, "upload-file", {
    maxItems: limit,
  });
  assertMediaReferencesResolved(resolved.errors);
  return resolved.items.map((item, index) => resolvedReferenceToFile(item, index));
};

export const extractFirstFileOrUrlFromUpload = async (
  value: unknown
): Promise<File | Blob | string | undefined> => {
  const resolved = await resolveFirstMediaReference(value, "file-or-url");
  assertMediaReferencesResolved(resolved.errors);
  return (resolved.item !== null && resolved.item !== undefined ? resolved.item.file : undefined) ?? (resolved.item !== null && resolved.item !== undefined ? resolved.item.url : undefined);
};

export const extractUrlListOrUndefined = async (
  value: unknown
): Promise<string[] | undefined> => {
  const urls = await extractUrlsFromUpload(value, undefined);
  if (!Array.isArray(urls) || urls.length === 0) {
    return undefined;
  }
  return urls;
};

export const ensureMultiMaxImages = (
  value: unknown,
  context: FormTransformContext | undefined
): number | undefined => {
  const values = ((context !== null && context !== undefined ? context.values : undefined) ?? {}) as ModelFormValues;
  const mode = typeof values.mode === "string" ? values.mode : "";
  if (mode !== "multi_image") {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  const clamped = Math.max(1, Math.min(15, Math.round(num)));
  return clamped;
};

export const mapBoolean = (value: unknown, context: FormTransformContext | undefined): unknown => {
  if (value !== true && value !== false) {
    return value;
  }
  const options = (context !== null && context !== undefined ? context.options : undefined);
  if (!isRecord(options)) {
    return value ? true : false;
  }
  const trueValue = (options as { true: unknown | undefined }).true;
  const falseValue = (options as { false: unknown | undefined }).false;
  if (value === true) {
    return trueValue !== undefined ? trueValue : true;
  }
  return falseValue !== undefined ? falseValue : false;
};

/**
 * 将上传控件中的第一个视频文件转为 Base64 编码。
 * 返回去除 data URL 前缀后的纯 Base64 字符串。
 */
export const fileToBase64Video = async (
  value: unknown
): Promise<{ mime_type: string; data: string } | null> => {
  try {
    const resolved = await resolveFirstMediaReference(value, "upload-file");
    assertMediaReferencesResolved(resolved.errors);
    const item = resolved.item;
    const file = item !== null && item !== undefined ? item.file : undefined;
    if (file === undefined) return null;
    const base64 = await readAsDataURL(file);
    return {
      mime_type:
        (item !== undefined ? item.mimeType : undefined) ||
        file.type ||
        (item !== undefined && item.url ? inferMimeTypeFromUrl(item.url) : undefined) ||
        "video/mp4",
      data: base64,
    };
  } catch (error) {
    console.error("视频文件转为 Base64 失败", error);
    return null;
  }
};
