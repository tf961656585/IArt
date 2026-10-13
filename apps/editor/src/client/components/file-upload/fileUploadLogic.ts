import { describeAllowedImageFormats, inspectPngTransparency } from "./imageValidation";
import {
  normalizeImageFile,
  readImageDimensions,
  type ImageDimensions,
} from "./imageConstraints";
import { dataUrlToFile } from "./imageProcessing";
import type {
  ProcessedFileItem,
  UploadFileItem,
  ValidationMessage,
} from "./fileUploadTypes";
import type { ImageValidationConstraints } from "@iart/contracts/media/imageValidationTypes";

export type FileUploadTranslationOptions =
  | { count: number }
  | { count: number; max: number }
  | { count: number; maxSizeMB: number };

type FileUploadTranslate = (
  key: string,
  options: FileUploadTranslationOptions,
) => string;

const buildAutoResizeTranslationOptions = (
  count: number,
  maxImageDimension: number | undefined,
): FileUploadTranslationOptions =>
  typeof maxImageDimension === "number"
    ? { count, max: maxImageDimension }
    : { count };

const buildSizeExceededTranslationOptions = (
  count: number,
  maxSizeMB: number | undefined,
): FileUploadTranslationOptions =>
  typeof maxSizeMB === "number" ? { count, maxSizeMB } : { count };

export const releaseObjectUrl = (item: Pick<UploadFileItem, "src"> | undefined) => {
  const src = (item !== null && item !== undefined ? item.src : undefined);
  if (src === null || src === undefined || !src.startsWith("blob:")) return;
  try {
    URL.revokeObjectURL(src);
  } catch {
    void 0;
  }
};

export const releaseRange = (list: UploadFileItem[], start: number) => {
  for (let i = start; i < list.length; i += 1) releaseObjectUrl(list[i]);
};

export const releaseAll = (list: UploadFileItem[]) => {
  for (const item of list) releaseObjectUrl(item);
};

export const cloneItems = (list: UploadFileItem[] | undefined): UploadFileItem[] =>
  Array.isArray(list) ? list.map((item) => ({ ...item })) : [];

export const shallowEqualItems = (
  a: UploadFileItem[],
  b: UploadFileItem[],
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const current = a[i];
    const next = b[i];
    if (!current || !next) return false;
    if (
      current.id !== next.id ||
      current.src !== next.src ||
      current.file !== next.file
    )
      return false;
  }
  return true;
};

export const isImagePreviewItem = (item: UploadFileItem): boolean => {
  if (item.file !== null && item.file !== undefined && item.file.type.startsWith("image/")) return true;
  const src = item.src ?? "";
  if (!src) return false;
  if (src.startsWith("blob:") || src.startsWith("data:image")) return true;
  const questionIndex = src.indexOf("?");
  const sanitized = questionIndex >= 0 ? src.slice(0, questionIndex) : src;
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(sanitized);
};

const normalizeMimeType = (raw: string | undefined): string => {
  const [mimeType] = (raw ?? "").split(";");
  return (mimeType ?? "").trim().toLowerCase();
};

export const getImageConstraintError = async (
  file: File,
  imageConstraints: ImageValidationConstraints | undefined,
  dimensions: ImageDimensions | undefined,
): Promise<string | null> => {
  if (!imageConstraints) return null;
  const allowed = imageConstraints.allowedMimeTypes;
  if (Array.isArray(allowed) && allowed.length > 0) {
    const mime = normalizeMimeType(file.type);
    const set = new Set(allowed.map((type) => normalizeMimeType(type)));
    if (!mime || !set.has(mime)) {
      const allowedFormats = describeAllowedImageFormats(allowed);
      return mime
        ? `这张图片的格式不支持，请换成 ${allowedFormats} 图片。`
        : `无法识别图片格式，请重新选择 ${allowedFormats} 图片。`;
    }
  }
  if (
    imageConstraints.disallowPngTransparency &&
    normalizeMimeType(file.type) === "image/png"
  ) {
    const transparency = await inspectPngTransparency(file);
    if (!transparency.ok)
      return "PNG 图片解析失败，请重新导出为不带透明通道的 PNG 后再上传。";
    if (transparency.hasTransparency)
      return "PNG 图片不能带透明通道，请去掉透明区域后再上传。";
  }
  if (!dimensions) return null;
  const { minWidth, minHeight, maxWidth, maxHeight } = imageConstraints;
  const tooSmall =
    (typeof minWidth === "number" && dimensions.width < minWidth) ||
    (typeof minHeight === "number" && dimensions.height < minHeight);
  const tooLarge =
    (typeof maxWidth === "number" && dimensions.width > maxWidth) ||
    (typeof maxHeight === "number" && dimensions.height > maxHeight);
  if (!tooSmall && !tooLarge) return null;
  const rangeText =
    typeof minWidth === "number" &&
    typeof minHeight === "number" &&
    typeof maxWidth === "number" &&
    typeof maxHeight === "number" &&
    minWidth === minHeight &&
    maxWidth === maxHeight
      ? `宽高需在 ${minWidth}~${maxWidth} 像素之间`
      : `尺寸需满足：宽 ${minWidth ?? "-"}~${maxWidth ?? "-"}，高 ${minHeight ?? "-"}~${maxHeight ?? "-"}`;
  return `图片尺寸不符合要求：${rangeText}，当前为 ${dimensions.width}×${dimensions.height}。`;
};

export async function buildUploadItems(
  files: File[],
  options: {
    maxSizeBytes: number | undefined | undefined;
    maxImageDimension: number | undefined | undefined;
    shouldAutoResize: boolean;
    imageConstraints: ImageValidationConstraints | undefined | undefined;
  },
) {
  let skippedBySize = 0;
  let skippedByError = 0;
  let resizedCount = 0;
  let firstConstraintError: string | null = null;
  const processed = await Promise.all(
    files.map(async (file, index) => {
      if (
        typeof options.maxSizeBytes === "number" &&
        file.size > options.maxSizeBytes
      ) {
        skippedBySize += 1;
        return null;
      }
      if (!file.type.startsWith("image/"))
        return {
          id: `${Date.now()}-${index}`,
          file,
          src: URL.createObjectURL(file),
          dimensions: undefined,
        };
      try {
        const item = await buildImageUploadItem(file, index, options);
        if (!item) {
          skippedByError += 1;
          return null;
        }
        if (item.resized) resizedCount += 1;
        return item.value;
      } catch (error) {
        skippedByError += 1;
        if (error instanceof Error)
          firstConstraintError = firstConstraintError ?? error.message;
        return null;
      }
    }),
  );
  return {
    items: processed.filter((item): item is ProcessedFileItem => item !== null),
    skippedBySize,
    skippedByError,
    resizedCount,
    firstConstraintError,
  };
}

async function buildImageUploadItem(
  file: File,
  index: number,
  options: {
    maxImageDimension: number | undefined | undefined;
    shouldAutoResize: boolean;
    imageConstraints: ImageValidationConstraints | undefined | undefined;
  },
): Promise<{ value: ProcessedFileItem; resized: boolean } | null> {
  if (!options.shouldAutoResize) {
    const src = URL.createObjectURL(file);
    const dimensions = await readImageDimensions(src);
    if (!dimensions) {
      releaseObjectUrl({ src });
      return null;
    }
    const error = await getImageConstraintError(
      file,
      options.imageConstraints,
      dimensions,
    );
    if (error) {
      releaseObjectUrl({ src });
      throw new Error(error);
    }
    return {
      value: { id: `${Date.now()}-${index}`, file, src, dimensions },
      resized: false,
    };
  }
  if (typeof options.maxImageDimension !== "number") return null;
  const normalized = await normalizeImageFile(file, options.maxImageDimension);
  const error = await getImageConstraintError(
    normalized.file,
    options.imageConstraints,
    normalized.dimensions,
  );
  if (error) {
    releaseObjectUrl({ src: normalized.src });
    throw new Error(error);
  }
  return {
    value: {
      id: `${Date.now()}-${index}`,
      file: normalized.file,
      src: normalized.src,
      dimensions: normalized.dimensions,
    },
    resized: normalized.resized,
  };
}

export function appendWithinLimit(
  prev: UploadFileItem[],
  arr: UploadFileItem[],
  maxFiles: number,
  onLimitExceeded: (maxFiles: number) => void | undefined,
) {
  const remaining = maxFiles - prev.length;
  if (remaining <= 0) {
    releaseAll(arr);
    if (onLimitExceeded !== null && onLimitExceeded !== undefined) {
      onLimitExceeded(maxFiles);
    }
    return prev;
  }
  const toAdd = arr.slice(0, remaining);
  if (toAdd.length < arr.length) {
    releaseRange(arr, remaining);
    if (onLimitExceeded !== null && onLimitExceeded !== undefined) {
      onLimitExceeded(maxFiles);
    }
  }
  return prev.concat(toAdd);
}

export function buildValidationMessage(
  result: Awaited<ReturnType<typeof buildUploadItems>>,
  maxSizeMB: number | undefined,
  t: FileUploadTranslate,
) {
  if (result.firstConstraintError) return result.firstConstraintError;
  return result.skippedBySize > 0
    ? t(
        "fileUpload.validation.sizeExceeded",
        buildSizeExceededTranslationOptions(result.skippedBySize, maxSizeMB),
      )
    : t("fileUpload.validation.invalidImage", { count: result.skippedByError });
}

export function buildNotice(
  result: Awaited<ReturnType<typeof buildUploadItems>>,
  maxSizeMB: number | undefined,
  maxImageDimension: number | undefined,
  t: FileUploadTranslate,
): ValidationMessage | null {
  const parts: string[] = [];
  if (result.resizedCount)
    parts.push(
      t(
        "fileUpload.validation.autoResize",
        buildAutoResizeTranslationOptions(
          result.resizedCount,
          maxImageDimension,
        ),
      ),
    );
  if (result.skippedBySize)
    parts.push(
      t(
        "fileUpload.validation.sizeExceeded",
        buildSizeExceededTranslationOptions(result.skippedBySize, maxSizeMB),
      ),
    );
  if (result.skippedByError)
    parts.push(
      t("fileUpload.validation.invalidImage", { count: result.skippedByError }),
    );
  return parts.length > 0
    ? {
        type: result.skippedBySize || result.skippedByError ? "error" : "info",
        text: parts.join(" "),
      }
    : null;
}

export async function buildProcessedReplacement(
  target: UploadFileItem,
  processedSrc: string,
  shouldAutoResize: boolean,
  maxImageDimension: number | undefined,
  imageConstraints: ImageValidationConstraints | undefined | undefined,
): Promise<UploadFileItem> {
  const newFile = await dataUrlToFile(processedSrc, (target.file !== null && target.file !== undefined ? target.file.name : undefined));
  if (!shouldAutoResize) {
    const src = URL.createObjectURL(newFile);
    const dimensions = await readImageDimensions(src);
    if (!dimensions) {
      releaseObjectUrl({ src });
      throw new Error("无法读取图片尺寸，请换一张图片再试。");
    }
    const error = await getImageConstraintError(
      newFile,
      imageConstraints,
      dimensions,
    );
    if (error) {
      releaseObjectUrl({ src });
      throw new Error(error);
    }
    return { ...target, file: newFile, src, dimensions };
  }
  if (typeof maxImageDimension !== "number")
    throw new Error("PROCESS_APPLY_ERROR");
  const normalized = await normalizeImageFile(newFile, maxImageDimension);
  const error = await getImageConstraintError(
    normalized.file,
    imageConstraints,
    normalized.dimensions,
  );
  if (error) {
    releaseObjectUrl({ src: normalized.src });
    throw new Error(error);
  }
  return {
    ...target,
    file: normalized.file,
    src: normalized.src,
    dimensions: normalized.dimensions ?? target.dimensions,
  };
}
