import type { ImageDimensions, ImageValidationConstraints } from '@iart/contracts/media/imageValidationTypes';
import { loadImageElement } from './imageConstraints';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPngSignature = (bytes: Uint8Array): boolean => {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
};

const readFourCC = (view: DataView, offset: number): string => {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
};

type PngTransparencyInspectResult = { ok: true; hasTransparency: boolean } | { ok: false };

export const inspectPngTransparency = async (blob: Blob): Promise<PngTransparencyInspectResult> => {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!isPngSignature(bytes)) return { ok: false };

    const view = new DataView(buffer);
    let offset = 8; // signature
    let hasAlphaByColorType = false;

    while (offset + 8 <= view.byteLength) {
      const chunkLength = view.getUint32(offset, false);
      offset += 4;
      const chunkType = readFourCC(view, offset);
      offset += 4;

      if (offset + chunkLength + 4 > view.byteLength) {
        return { ok: false };
      }

      if (chunkType === 'IHDR') {
        // IHDR data: width(4) height(4) bitDepth(1) colorType(1) ...
        if (chunkLength < 10) return { ok: false };
        const colorType = view.getUint8(offset + 9);
        // 4: grayscale+alpha, 6: truecolor+alpha
        if (colorType === 4 || colorType === 6) {
          hasAlphaByColorType = true;
        }
      }

      if (chunkType === 'tRNS') {
        return { ok: true, hasTransparency: true };
      }

      if (chunkType === 'IEND') {
        break;
      }

      offset += chunkLength + 4; // data + CRC
    }

    return { ok: true, hasTransparency: hasAlphaByColorType };
  } catch {
    return { ok: false };
  }
};

export const readImageDimensionsFromBlob = async (blob: Blob): Promise<ImageDimensions | null> => {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImageElement(objectUrl);
    const width = Math.max(image.naturalWidth || image.width, 0);
    const height = Math.max(image.naturalHeight || image.height, 0);
    if (!width || !height) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  } finally {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // ignore
    }
  }
};

export type ImageValidationResult =
  | { ok: true; dimensions: ImageDimensions }
  | { ok: false; message: string; dimensions: ImageDimensions | undefined };

const normalizeMimeType = (value: string | undefined): string => {
  const [mimeType] = (value ?? '').split(';');
  return (mimeType ?? '').trim().toLowerCase();
};

/** `mime → 用户能照做的格式名`；未登记的图片类型按子类型大写兜底（`image/x-foo` → `X-FOO`）。 */
const IMAGE_MIME_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/jpg': 'JPG',
  'image/webp': 'WEBP',
  'image/bmp': 'BMP',
  'image/gif': 'GIF',
  'image/tiff': 'TIFF',
  'image/avif': 'AVIF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
  'image/svg+xml': 'SVG',
};

/** 约束给不出可读格式时的通用兜底句（与约束生成句同一出口，保证两份实现文案一致）。 */
const GENERIC_IMAGE_FORMATS = 'JPG、PNG、BMP 或 WEBP';

const describeImageMimeType = (mimeType: string): string | null => {
  if (!mimeType) return null;
  const known = IMAGE_MIME_DISPLAY_NAMES[mimeType];
  if (known) return known;
  const [type, subtype] = mimeType.split('/');
  if (type !== 'image' || !subtype) return null;
  const [suffix] = subtype.split('+');
  return suffix ? suffix.toUpperCase() : null;
};

/**
 * `allowedMimeTypes` 约束 → 用户看得懂的格式名（`['image/png','image/jpeg']` → `PNG 或 JPG`）。
 * 提示文案必须由约束生成：写死格式会让用户照提示换格式后仍被拒。
 */
export const describeAllowedImageFormats = (
  allowedMimeTypes: readonly string[] | undefined
): string => {
  const displayNames: string[] = [];
  for (const mimeType of allowedMimeTypes ?? []) {
    const displayName = describeImageMimeType(normalizeMimeType(mimeType));
    if (!displayName || displayNames.includes(displayName)) continue;
    displayNames.push(displayName);
  }
  if (displayNames.length === 0) return GENERIC_IMAGE_FORMATS;
  if (displayNames.length === 1) return displayNames.join('');
  return `${displayNames.slice(0, -1).join('、')} 或 ${displayNames.slice(-1).join('')}`;
};

export const validateImageBlob = async (
  blob: Blob,
  constraints: ImageValidationConstraints | undefined
): Promise<ImageValidationResult> => {
  const mimeType = normalizeMimeType(blob.type);

  const allowedMimeTypes =
    constraints !== null && constraints !== undefined ? constraints.allowedMimeTypes : undefined;

  if (Array.isArray(allowedMimeTypes) && allowedMimeTypes.length > 0) {
    const allowedFormats = describeAllowedImageFormats(allowedMimeTypes);
    if (!mimeType) {
      return {
        ok: false,
        message: `无法识别图片格式，请重新选择 ${allowedFormats} 图片。`,
        dimensions: undefined,
      };
    }
    const allowed = new Set(allowedMimeTypes.map((t) => normalizeMimeType(t)));
    if (!allowed.has(mimeType)) {
      return {
        ok: false,
        message: `这张图片的格式不支持，请换成 ${allowedFormats} 图片。`,
        dimensions: undefined,
      };
    }
  }

  if ((constraints !== null && constraints !== undefined ? constraints.disallowPngTransparency : undefined) && mimeType === 'image/png') {
    const result = await inspectPngTransparency(blob);
    if (!result.ok) {
      return {
        ok: false,
        message: 'PNG 图片解析失败，请重新导出为不带透明通道的 PNG 后再上传。',
        dimensions: undefined,
      };
    }
    if (result.hasTransparency) {
      return {
        ok: false,
        message: 'PNG 图片不能带透明通道，请去掉透明区域后再上传。',
        dimensions: undefined,
      };
    }
  }

  const dimensions = await readImageDimensionsFromBlob(blob);
  if (!dimensions) {
    return { ok: false, message: '无法读取图片尺寸，请换一张图片再试。', dimensions: undefined };
  }

  const minWidth = (constraints !== null && constraints !== undefined ? constraints.minWidth : undefined);
  const minHeight = (constraints !== null && constraints !== undefined ? constraints.minHeight : undefined);
  const maxWidth = (constraints !== null && constraints !== undefined ? constraints.maxWidth : undefined);
  const maxHeight = (constraints !== null && constraints !== undefined ? constraints.maxHeight : undefined);

  const tooSmall =
    (typeof minWidth === 'number' && dimensions.width < minWidth) ||
    (typeof minHeight === 'number' && dimensions.height < minHeight);
  const tooLarge =
    (typeof maxWidth === 'number' && dimensions.width > maxWidth) ||
    (typeof maxHeight === 'number' && dimensions.height > maxHeight);

  if (tooSmall || tooLarge) {
    const rangeText =
      typeof minWidth === 'number' &&
      typeof minHeight === 'number' &&
      typeof maxWidth === 'number' &&
      typeof maxHeight === 'number' &&
      minWidth === minHeight &&
      maxWidth === maxHeight
        ? `宽高需在 ${minWidth}~${maxWidth} 像素之间`
        : `尺寸需满足：宽 ${minWidth ?? '-'}~${maxWidth ?? '-'}，高 ${minHeight ?? '-'}~${maxHeight ?? '-'}`;
    return {
      ok: false,
      message: `图片尺寸不符合要求：${rangeText}，当前为 ${dimensions.width}×${dimensions.height}。`,
      dimensions,
    };
  }

  return { ok: true, dimensions };
};
