import {
  ImageProcessingRequestSchema,
  type ImageProcessingOperation,
  type ImageProcessingRequest,
} from '@iart/contracts/media-processing-contract';
import {
  asUnknownObject,
  readUnknownField,
} from './unknown-object.cts';

type TransformOperation =
  | { type: 'mirrorX' }
  | { type: 'mirrorY' }
  | { type: 'rotate'; deg: 0 | 90 | 180 | 270 };

type RawTransformOperation = {
  type: unknown | undefined;
  deg: unknown | undefined;
};

type LegacyImageProcessingPayload = {
  sourceUrl: unknown | undefined;
  percent: unknown | undefined;
  x: unknown | undefined;
  y: unknown | undefined;
  left: unknown | undefined;
  top: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  w: unknown | undefined;
  h: unknown | undefined;
  horizontalPercents: unknown | undefined;
  verticalPercents: unknown | undefined;
  threshold: unknown | undefined;
  ops: unknown | undefined;
  targetColor: unknown | undefined;
  tolerance: unknown | undefined;
  feather: unknown | undefined;
};

const normalizeRequiredNumber = (
  value: unknown,
  code: string,
  message: string,
  createError: (code: string, message: string, status: number | undefined) => Error,
) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw createError(code, message, 400);
  }
  return num;
};

const buildLegacyImageProcessingPayload = (): LegacyImageProcessingPayload => ({
  sourceUrl: undefined,
  percent: undefined,
  x: undefined,
  y: undefined,
  left: undefined,
  top: undefined,
  width: undefined,
  height: undefined,
  w: undefined,
  h: undefined,
  horizontalPercents: undefined,
  verticalPercents: undefined,
  threshold: undefined,
  ops: undefined,
  targetColor: undefined,
  tolerance: undefined,
  feather: undefined,
});

const asLegacyImageProcessingPayload = (value: unknown): LegacyImageProcessingPayload => {
  const raw = asUnknownObject(value);
  if (raw === null) return buildLegacyImageProcessingPayload();
  return {
    sourceUrl: readUnknownField(raw, 'sourceUrl'),
    percent: readUnknownField(raw, 'percent'),
    x: readUnknownField(raw, 'x'),
    y: readUnknownField(raw, 'y'),
    left: readUnknownField(raw, 'left'),
    top: readUnknownField(raw, 'top'),
    width: readUnknownField(raw, 'width'),
    height: readUnknownField(raw, 'height'),
    w: readUnknownField(raw, 'w'),
    h: readUnknownField(raw, 'h'),
    horizontalPercents: readUnknownField(raw, 'horizontalPercents'),
    verticalPercents: readUnknownField(raw, 'verticalPercents'),
    threshold: readUnknownField(raw, 'threshold'),
    ops: readUnknownField(raw, 'ops'),
    targetColor: readUnknownField(raw, 'targetColor'),
    tolerance: readUnknownField(raw, 'tolerance'),
    feather: readUnknownField(raw, 'feather'),
  };
};

const asRawTransformOperation = (value: unknown): RawTransformOperation | null => {
  const raw = asUnknownObject(value);
  if (raw === null) return null;
  return {
    type: readUnknownField(raw, 'type'),
    deg: readUnknownField(raw, 'deg'),
  };
};

const normalizeTransformOps = (
  value: unknown,
  createError: (code: string, message: string, status: number | undefined) => Error,
): TransformOperation[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw createError('INVALID_OPS', 'Missing ops', 400);
  }
  const normalized: TransformOperation[] = [];
  for (const rawOp of value) {
    const op = asRawTransformOperation(rawOp);
    if (!op) {
      throw createError('INVALID_OPS', 'Invalid op item', 400);
    }
    if (op.type === 'mirrorX') {
      normalized.push({ type: 'mirrorX' });
      continue;
    }
    if (op.type === 'mirrorY') {
      normalized.push({ type: 'mirrorY' });
      continue;
    }
    if (op.type === 'rotate') {
      const deg = Number(op.deg);
      const allowed = deg === 0 || deg === 90 || deg === 180 || deg === 270;
      if (!Number.isFinite(deg) || !allowed) {
        throw createError(
          'INVALID_ROTATE',
          'Invalid rotate deg (must be 0/90/180/270)',
          400,
        );
      }
      normalized.push({ type: 'rotate', deg });
      continue;
    }
    throw createError('INVALID_OPS', `Unsupported op: ${String(op.type)}`, 400);
  }
  return normalized;
};

const buildTransformOperation = (
  value: unknown,
  createError: (code: string, message: string, status: number | undefined) => Error,
): Extract<ImageProcessingOperation, { type: 'transform' }> => ({
  type: 'transform',
  ops: normalizeTransformOps(value, createError),
});

const normalizeEdgeDetectThreshold = (
  value: unknown,
  createError: (code: string, message: string, status: number | undefined) => Error,
) => {
  const threshold = value === undefined ? 128 : Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw createError('INVALID_THRESHOLD', 'Invalid threshold (0-255)', 400);
  }
  return threshold;
};

const buildImageProcessingRequestFromLegacyPayload = (
  payload: unknown,
  operationType: ImageProcessingOperation['type'],
  createError: (code: string, message: string, status: number | undefined) => Error,
): ImageProcessingRequest => {
  const input = asLegacyImageProcessingPayload(payload);
  const sourceUrl = typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : '';
  if (operationType === 'resize') {
    return ImageProcessingRequestSchema.parse({
      source: { type: 'media-url', url: sourceUrl },
      operation: {
        type: 'resize',
        percent: normalizeRequiredNumber(input.percent, 'INVALID_PERCENT', 'Invalid percent (must be 10-100)', createError),
      },
    });
  }
  if (operationType === 'crop') {
    return ImageProcessingRequestSchema.parse({
      source: { type: 'media-url', url: sourceUrl },
      operation: {
        type: 'crop',
        x: normalizeRequiredNumber(input.x ?? input.left ?? 0, 'INVALID_CROP_RECT', 'Invalid crop rectangle', createError),
        y: normalizeRequiredNumber(input.y ?? input.top ?? 0, 'INVALID_CROP_RECT', 'Invalid crop rectangle', createError),
        width: normalizeRequiredNumber(input.width ?? input.w, 'INVALID_CROP_RECT', 'Invalid crop rectangle', createError),
        height: normalizeRequiredNumber(input.height ?? input.h, 'INVALID_CROP_RECT', 'Invalid crop rectangle', createError),
      },
    });
  }
  if (operationType === 'split') {
    return ImageProcessingRequestSchema.parse({
      source: { type: 'media-url', url: sourceUrl },
      operation: {
        type: 'split',
        horizontalPercents: Array.isArray(input.horizontalPercents) ? input.horizontalPercents.map(Number) : [],
        verticalPercents: Array.isArray(input.verticalPercents) ? input.verticalPercents.map(Number) : [],
      },
    });
  }
  if (operationType === 'edgeDetect') {
    return ImageProcessingRequestSchema.parse({
      source: { type: 'media-url', url: sourceUrl },
      operation: {
        type: 'edgeDetect',
        mode: 'sobel',
        threshold: normalizeEdgeDetectThreshold(input.threshold, createError),
      },
    });
  }
  if (operationType === 'chromaKey') {
    const tcRaw = (typeof input === 'object' && input !== null && 'targetColor' in input)
      ? input.targetColor
      : null;
    const tc = (tcRaw !== null && typeof tcRaw === 'object')
      ? tcRaw as { r: unknown; g: unknown; b: unknown }
      : ({ r: 0, g: 0, b: 0 } as { r: unknown; g: unknown; b: unknown });
    return ImageProcessingRequestSchema.parse({
      source: { type: 'media-url', url: sourceUrl },
      operation: {
        type: 'chromaKey',
        targetColor: {
          r: normalizeRequiredNumber(tc.r ?? 0, 'INVALID_COLOR', 'Invalid target color R', createError),
          g: normalizeRequiredNumber(tc.g ?? 0, 'INVALID_COLOR', 'Invalid target color G', createError),
          b: normalizeRequiredNumber(tc.b ?? 0, 'INVALID_COLOR', 'Invalid target color B', createError),
        },
        tolerance: normalizeRequiredNumber(input.tolerance ?? 30, 'INVALID_TOLERANCE', 'Invalid tolerance (0-100)', createError),
        feather: normalizeRequiredNumber(input.feather ?? 0, 'INVALID_FEATHER', 'Invalid feather (0-20)', createError),
      },
    });
  }
  return ImageProcessingRequestSchema.parse({
    source: { type: 'media-url', url: sourceUrl },
    operation: buildTransformOperation(input.ops, createError),
  });
};

export {
  asLegacyImageProcessingPayload,
  buildImageProcessingRequestFromLegacyPayload,
  buildTransformOperation,
};
