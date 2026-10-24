import { computeFittedCanvasSize } from '@iart/utils/canvas-geometry';

export const DEFAULT_MAX_IMAGE_DIMENSION = 768;

export type ImageDimensions = { width: number; height: number };

export type NormalizedImage = {
  file: File;
  src: string;
  dimensions: ImageDimensions;
  resized: boolean;
};

export const loadImageElement = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('IMAGE_LOAD_ERROR'));
    img.src = src;
  });

export const readImageDimensions = async (src: string): Promise<ImageDimensions | undefined> => {
  try {
    const img = await loadImageElement(src);
    const width = Math.max(img.naturalWidth || img.width, 0);
    const height = Math.max(img.naturalHeight || img.height, 0);
    if (!width || !height) return undefined;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return undefined;
  }
};

/**
 * 按最大边长等比缩放。
 *
 * maxDimension 为 undefined / 非有限 / 非正时不缩放（等价于无上限）；
 * 返回的 resized 表示是否发生缩放，调用方据此决定是否重绘。
 */
export const computeFittedSize = (
  width: number,
  height: number,
  maxDimension: number | undefined
): { width: number; height: number; resized: boolean } =>
  computeFittedCanvasSize(width, height, maxDimension);

const drawToCanvas = async (
  image: HTMLImageElement,
  width: number,
  height: number,
  mimeType: string,
  fileName: string | undefined
): Promise<Omit<NormalizedImage, 'dimensions' | 'resized'>> => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('CANVAS_CONTEXT_UNAVAILABLE');
  }
  ctx.drawImage(image, 0, 0, width, height);
  const preferredType = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('CANVAS_TO_BLOB_FAILED'));
      },
      preferredType,
      preferredType === 'image/jpeg' ? 0.92 : undefined
    )
  );
  const finalName =
    typeof fileName === 'string' && fileName.trim().length > 0 ? fileName : `resized-${Date.now()}.${preferredType === 'image/jpeg' ? 'jpg' : 'png'}`;
  const file = new File([blob], finalName, { type: blob.type });
  const src = URL.createObjectURL(file);
  return { file, src };
};

export const normalizeImageFile = async (
  file: File,
  maxDimension: number | undefined
): Promise<NormalizedImage> => {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const width = Math.max(image.naturalWidth || image.width, 0);
    const height = Math.max(image.naturalHeight || image.height, 0);
    if (!width || !height) {
      throw new Error('IMAGE_DIMENSION_UNAVAILABLE');
    }
    const fitted = computeFittedSize(width, height, maxDimension);
    if (!fitted.resized) {
      return {
        file,
        src: objectUrl,
        dimensions: { width: fitted.width, height: fitted.height },
        resized: false,
      };
    }
    const scaled = await drawToCanvas(image, fitted.width, fitted.height, file.type, file.name);
    URL.revokeObjectURL(objectUrl);
    return {
      ...scaled,
      dimensions: { width: fitted.width, height: fitted.height },
      resized: true,
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
};
