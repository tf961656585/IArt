import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { logWarn } from './logging.cts';
export { binarizeAlpha, dilateBinary, detectConnectedComponents } from './smart-split-algorithm.cts';
import * as filesUrl from './files-url.cts';
import {
  resolveFilesKeyToFilePath,
  resolveFilesUrlToFilePath,
  resolveFilesUrlToFilePathInProject,
  ensureFilesUrlToFilePathInProject,
} from './image-processing-paths.cts';
import { readImageDimensionsFromFilePath } from './image-processing-dimensions.cts';

type ErrorWithCode = Error & { code: string | undefined };
type SharpOutputInfo = { width: number | undefined; height: number | undefined; channels: number | undefined };
type SharpBufferResult = { data: Buffer; info: SharpOutputInfo };
type SharpMetadata = { format: string | undefined; width: number | undefined; height: number | undefined };
type SharpResizeKernel = 'lanczos3' | 'nearest';
type SharpResizeBoundedOptions = {
  width: number;
  height: number;
  fit: 'inside';
  withoutEnlargement: boolean;
};
type SharpResizeKernelOptions = {
  width: number;
  height: number;
  fit: 'inside' | undefined;
  withoutEnlargement: boolean | undefined;
  kernel: SharpResizeKernel | undefined;
  fastShrinkOnLoad: boolean | undefined;
};
type SharpResizeOptions = SharpResizeBoundedOptions | SharpResizeKernelOptions;
export type ImageSharpPipeline = {
  metadata(): Promise<SharpMetadata>;
  rotate(degrees: number | undefined): ImageSharpPipeline;
  jpeg(options: { quality: number | undefined; mozjpeg: boolean | undefined } | undefined): ImageSharpPipeline;
  webp(options: { quality: number | undefined } | undefined): ImageSharpPipeline;
  avif(options: { quality: number | undefined } | undefined): ImageSharpPipeline;
  tiff(options: { quality: number | undefined } | undefined): ImageSharpPipeline;
  gif(): ImageSharpPipeline;
  png(): ImageSharpPipeline;
  flop(): ImageSharpPipeline;
  flip(): ImageSharpPipeline;
  extract(rect: { left: number; top: number; width: number; height: number }): ImageSharpPipeline;
  resize(width: number, height: number): ImageSharpPipeline;
  resize(options: SharpResizeOptions): ImageSharpPipeline;
  clone(): ImageSharpPipeline;
  ensureAlpha(): ImageSharpPipeline;
  raw(): ImageSharpPipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<SharpBufferResult>;
};
export type ImageSharpFactory = {
  (input: Buffer | string, options: { animated: boolean | undefined; failOnError: boolean | undefined } | undefined): ImageSharpPipeline;
  (input: Buffer, options: { raw: { width: number; height: number; channels: number } }): ImageSharpPipeline;
};
type NormalizedImageOptions = { format: unknown | undefined };
type SharpOperation = { type: unknown | undefined; deg: unknown | undefined };
type CropRect = { x: unknown | undefined; y: unknown | undefined; left: unknown | undefined; top: unknown | undefined; width: unknown | undefined; height: unknown | undefined; w: unknown | undefined; h: unknown | undefined };
type EdgeDetectOptions = { threshold: unknown | undefined; maxDimension: unknown | undefined };

const requireDependency = createRequire(__filename);
export const buildSharpResizeOptions = (width: number, height: number, kernel: SharpResizeKernel): SharpResizeOptions =>
  kernel === 'nearest'
    ? { width, height, fit: undefined, withoutEnlargement: undefined, kernel: 'nearest', fastShrinkOnLoad: false }
    : { width, height, fit: undefined, withoutEnlargement: undefined, kernel: undefined, fastShrinkOnLoad: undefined };

const getRequireErrorMeta = (error: unknown) => {
  if (error instanceof Error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : '';
    return {
      module: 'sharp',
      code,
      message: error.message,
      stackHead: typeof error.stack === 'string' ? error.stack.split(/\r?\n/, 1)[0] : '',
    };
  }
  return { module: 'sharp', code: '', message: String(error), stackHead: '' };
};
let sharp: ImageSharpFactory | null = null;
try {
  sharp = requireDependency('sharp') as ImageSharpFactory;
} catch (error) {
  logWarn('optional native dependency unavailable', getRequireErrorMeta(error));
  sharp = null;
}

const NORMALIZED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']);

const normalizeSharpImageFormat = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return '';
  if (normalized === 'jpg') return 'jpeg';
  if (normalized === 'svg') return 'png';
  return NORMALIZED_IMAGE_FORMATS.has(normalized) ? normalized : '';
};

const getNormalizedImageOutputInfo = (format: unknown) => {
  const normalized = normalizeSharpImageFormat(format) || 'png';
  switch (normalized) {
    case 'jpeg':
      return { format: normalized, mimeType: 'image/jpeg', extension: '.jpg' };
    case 'png':
      return { format: normalized, mimeType: 'image/png', extension: '.png' };
    case 'webp':
      return { format: normalized, mimeType: 'image/webp', extension: '.webp' };
    case 'avif':
      return { format: normalized, mimeType: 'image/avif', extension: '.avif' };
    case 'tiff':
      return { format: normalized, mimeType: 'image/tiff', extension: '.tiff' };
    case 'gif':
      return { format: normalized, mimeType: 'image/gif', extension: '.gif' };
    default:
      return { format: 'png', mimeType: 'image/png', extension: '.png' };
  }
};

const readProjectImageDimensions = (projectPath: unknown, sourceUrl: unknown) => {
  const resolved = resolveFilesUrlToFilePathInProject(projectPath, sourceUrl);
  if (resolved === null) return null;
  if (!(resolved !== null && resolved !== undefined ? resolved.filePath : undefined)) return null;
  return readImageDimensionsFromFilePath(resolved.filePath);
};

const normalizeUploadedImageBuffer = async (buffer: unknown, options: NormalizedImageOptions = { format: undefined }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    const error = new Error('Invalid image buffer') as ErrorWithCode;
    error.code = 'INVALID_IMAGE';
    throw error;
  }
  if (!sharp) {
    const error = new Error('Sharp library not installed') as ErrorWithCode;
    error.code = 'SHARP_NOT_AVAILABLE';
    throw error;
  }

  const metadata = await sharp(buffer, { animated: false, failOnError: true }).metadata();
  const outputInfo = getNormalizedImageOutputInfo((metadata !== null && metadata !== undefined ? metadata.format : undefined) || (options !== null && options !== undefined ? options.format : undefined));
  let pipeline = sharp(buffer, { animated: false, failOnError: true }).rotate(undefined);

  switch (outputInfo.format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: 100, mozjpeg: true });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: 100 });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: 100 });
      break;
    case 'tiff':
      pipeline = pipeline.tiff({ quality: 100 });
      break;
    case 'gif':
      pipeline = pipeline.gif();
      break;
    case 'png':
    default:
      pipeline = pipeline.png();
      break;
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    mimeType: outputInfo.mimeType,
    extension: outputInfo.extension,
    width: Number.isFinite((info !== null && info !== undefined ? info.width : undefined)) ? Number(info.width) : null,
    height: Number.isFinite((info !== null && info !== undefined ? info.height : undefined)) ? Number(info.height) : null,
  };
};

const writeBufferToSameDirDedup = (buffer: Buffer, ext: unknown, outputDir: string) => {
  const normalizedExt =
    typeof ext === 'string' && ext.trim()
      ? ext.trim().startsWith('.')
        ? ext.trim()
        : `.${ext.trim()}`
      : '';
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `${digest}${normalizedExt}`;
  const targetPath = path.join(outputDir, filename);
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, buffer);
  }
  return { digest, filename, targetPath };
};

const applySharpOps = async (sourceFilePath: string, ops: unknown) => {
  if (!sharp) {
    const error = new Error('Sharp library not installed') as ErrorWithCode;
    error.code = 'SHARP_NOT_AVAILABLE';
    throw error;
  }

  const opList: SharpOperation[] = Array.isArray(ops) ? ops.filter((op): op is SharpOperation => Boolean(op) && typeof op === 'object') : [];
  let pipeline = sharp(sourceFilePath, undefined);

  for (const op of opList) {
    const type = op.type;
    if (type === 'mirrorX') {
      pipeline = pipeline.flop();
      continue;
    }
    if (type === 'mirrorY') {
      pipeline = pipeline.flip();
      continue;
    }
    if (type === 'rotate') {
      const deg = Number(op.deg);
      pipeline = pipeline.rotate(deg);
      continue;
    }
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { buffer: data, info };
};

const normalizeCropInt = (value: unknown, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(num);
};

const applyCrop = async (sourceFilePath: string, rect: CropRect = { x: undefined, y: undefined, left: undefined, top: undefined, width: undefined, height: undefined, w: undefined, h: undefined }) => {
  if (!sharp) {
    const error = new Error('Sharp library not installed') as ErrorWithCode;
    error.code = 'SHARP_NOT_AVAILABLE';
    throw error;
  }

  const meta = await sharp(sourceFilePath, undefined).metadata();
  const originalWidth = (meta !== null && meta !== undefined ? meta.width : undefined) || 0;
  const originalHeight = (meta !== null && meta !== undefined ? meta.height : undefined) || 0;
  if (!originalWidth || !originalHeight) {
    const error = new Error('Cannot read image dimensions') as ErrorWithCode;
    error.code = 'INVALID_IMAGE';
    throw error;
  }

  const leftRaw = normalizeCropInt(rect.x ?? rect.left ?? 0, 0);
  const topRaw = normalizeCropInt(rect.y ?? rect.top ?? 0, 0);
  const widthRaw = normalizeCropInt(rect.width ?? rect.w ?? 0, 0);
  const heightRaw = normalizeCropInt(rect.height ?? rect.h ?? 0, 0);

  const left = Math.max(0, Math.min(originalWidth - 1, leftRaw));
  const top = Math.max(0, Math.min(originalHeight - 1, topRaw));

  if (widthRaw <= 0 || heightRaw <= 0) {
    const error = new Error('Invalid crop rect') as ErrorWithCode;
    error.code = 'INVALID_CROP';
    throw error;
  }

  const width = Math.max(1, Math.min(originalWidth - left, widthRaw));
  const height = Math.max(1, Math.min(originalHeight - top, heightRaw));

  const { data, info } = await sharp(sourceFilePath, undefined)
    .extract({ left, top, width, height })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    info,
    meta: {
      originalWidth,
      originalHeight,
      x: left,
      y: top,
      width,
      height,
    },
  };
};

const DEFAULT_EDGE_MAX_DIMENSION = 4096;
const SOBEL_GX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_GY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

const normalizeEdgeThreshold = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 128;
  const rounded = Math.round(num);
  return Math.max(0, Math.min(255, rounded));
};

const normalizeEdgeMaxDimension = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_EDGE_MAX_DIMENSION;
  return Math.max(64, Math.min(8192, Math.round(num)));
};

const applySobelEdgeDetect = async (sourceFilePath: string, options: EdgeDetectOptions = { threshold: undefined, maxDimension: undefined }) => {
  if (!sharp) {
    const error = new Error('Sharp library not installed') as ErrorWithCode;
    error.code = 'SHARP_NOT_AVAILABLE';
    throw error;
  }

  const threshold = normalizeEdgeThreshold(options.threshold);
  const maxDimension = normalizeEdgeMaxDimension(options.maxDimension);

  // 读取像素（必要时缩放），统一成 RGBA raw
  let pipeline = sharp(sourceFilePath, undefined);
  try {
    const meta = await pipeline.metadata();
    const w = (meta !== null && meta !== undefined ? meta.width : undefined) || 0;
    const h = (meta !== null && meta !== undefined ? meta.height : undefined) || 0;
    if (w > maxDimension || h > maxDimension) {
      pipeline = pipeline.resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
  } catch {
    // ignore metadata error, continue with original pipeline
  }

  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = (info !== null && info !== undefined ? info.width : undefined) || 0;
  const height = (info !== null && info !== undefined ? info.height : undefined) || 0;
  const channels = (info !== null && info !== undefined ? info.channels : undefined) || 0;

  if (!width || !height || channels < 1) {
    const error = new Error('Invalid image data') as ErrorWithCode;
    error.code = 'INVALID_IMAGE';
    throw error;
  }

  const pixelCount = width * height;
  const gray = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const base = i * channels;
    const r = data[base] || 0;
    const g = channels >= 3 ? data[base + 1] || 0 : r;
    const b = channels >= 3 ? data[base + 2] || 0 : r;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const out = Buffer.allocUnsafe(pixelCount * 4);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      let gx = 0;
      let gy = 0;

      for (let ky = -1; ky <= 1; ky += 1) {
        const ny = y + ky;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let kx = -1; kx <= 1; kx += 1) {
          const nx = x + kx;
          if (nx < 0 || nx >= width) continue;
          const kIndex = (ky + 1) * 3 + (kx + 1);
          const sample = gray[nRow + nx] || 0;
          gx += sample * (SOBEL_GX[kIndex] ?? 0);
          gy += sample * (SOBEL_GY[kIndex] ?? 0);
        }
      }

      const magnitude = Math.sqrt(gx * gx + gy * gy);
      const value = magnitude > threshold ? 255 : 0;
      const outBase = (rowOffset + x) * 4;
      out[outBase] = value;
      out[outBase + 1] = value;
      out[outBase + 2] = value;
      out[outBase + 3] = 255;
    }
  }

  const encoded = await sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: encoded.data,
    info: encoded.info,
    meta: { width, height, threshold, maxDimension },
  };
};

const applyChromaKey = async (
  sourceFilePath: string,
  params: { targetColor: { r: number; g: number; b: number }; tolerance: number; feather: number },
) => {
  if (!sharp) {
    const error = new Error('Sharp library not installed') as ErrorWithCode;
    error.code = 'SHARP_NOT_AVAILABLE';
    throw error;
  }

  const { data, info } = await sharp(sourceFilePath, undefined)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = (info !== null && info !== undefined ? info.width : undefined) || 0;
  const height = (info !== null && info !== undefined ? info.height : undefined) || 0;
  const channels = (info !== null && info !== undefined ? info.channels : undefined) || 0;

  if (!width || !height || channels < 1) {
    const error = new Error('Invalid image data') as ErrorWithCode;
    error.code = 'INVALID_IMAGE';
    throw error;
  }

  let rgbData = data;
  let rgbChannels = channels;
  if (channels < 3) {
    const pixelCount = width * height;
    const converted = Buffer.allocUnsafe(pixelCount * 3);
    for (let i = 0; i < pixelCount; i += 1) {
      const gray = data[i] || 0;
      converted[i * 3] = gray;
      converted[i * 3 + 1] = gray;
      converted[i * 3 + 2] = gray;
    }
    rgbData = converted;
    rgbChannels = 3;
  }

  const pixelCount = width * height;
  const alpha = new Uint8Array(pixelCount);
  const maxDistance = Math.sqrt(3) * 255;
  const threshold = (params.tolerance / 100) * maxDistance;
  const featherNormalized = params.feather * (maxDistance / 100);

  for (let i = 0; i < pixelCount; i += 1) {
    const base = i * rgbChannels;
    const r = rgbData[base] || 0;
    const g = rgbData[base + 1] || 0;
    const b = rgbData[base + 2] || 0;

    const deltaR = r - params.targetColor.r;
    const deltaG = g - params.targetColor.g;
    const deltaB = b - params.targetColor.b;
    const distance = Math.sqrt(deltaR * deltaR + deltaG * deltaG + deltaB * deltaB);

    if (distance <= threshold) {
      alpha[i] = 0;
    } else if (featherNormalized > 0 && distance >= threshold + featherNormalized) {
      alpha[i] = 255;
    } else if (featherNormalized > 0) {
      alpha[i] = Math.round(255 * (distance - threshold) / featherNormalized);
    } else {
      alpha[i] = 255;
    }
  }

  const rgba = Buffer.allocUnsafe(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const srcBase = i * rgbChannels;
    const dstBase = i * 4;
    rgba[dstBase] = rgbData[srcBase] || 0;
    rgba[dstBase + 1] = rgbData[srcBase + 1] || 0;
    rgba[dstBase + 2] = rgbData[srcBase + 2] || 0;
    rgba[dstBase + 3] = alpha[i] || 0;
  }

  const encoded = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: encoded.data,
    info: { width, height },
  };
};

const sharpAvailable = Boolean(sharp);
const loadImageSharp = () => sharp;

const parseFilesKeyFromUrl = filesUrl.parseFilesKeyFromUrl;

export {
  resolveFilesKeyToFilePath,
  resolveFilesUrlToFilePath,
  resolveFilesUrlToFilePathInProject,
  readImageDimensionsFromFilePath,
  readProjectImageDimensions,
  ensureFilesUrlToFilePathInProject,
  writeBufferToSameDirDedup,
  normalizeUploadedImageBuffer,
  applySharpOps,
  applyCrop,
  applySobelEdgeDetect,
  applyChromaKey,
  loadImageSharp,
  parseFilesKeyFromUrl,
  sharpAvailable,
};
