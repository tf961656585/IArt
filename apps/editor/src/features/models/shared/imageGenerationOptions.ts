import { type StaticSelectOption } from '@/features/models/shared/schemaFieldBuilders';

export type ImageGenerationAspectRatio =
  | '1:1'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:3'
  | '4:5'
  | '5:4'
  | '9:16'
  | '16:9'
  | '21:9';

const staticSelectOption = (value: string, labelKey: string): StaticSelectOption => ({
  value,
  labelKey,
  descriptionKey: undefined,
  labelParams: undefined,
});

export const IMAGE_GENERATION_ASPECT_RATIO_OPTIONS: StaticSelectOption[] = [
  staticSelectOption('1:1', 'pages:imageGeneration.fields.aspectRatio.options.1_1'),
  staticSelectOption('2:3', 'pages:imageGeneration.fields.aspectRatio.options.2_3'),
  staticSelectOption('3:2', 'pages:imageGeneration.fields.aspectRatio.options.3_2'),
  staticSelectOption('3:4', 'pages:imageGeneration.fields.aspectRatio.options.3_4'),
  staticSelectOption('4:3', 'pages:imageGeneration.fields.aspectRatio.options.4_3'),
  staticSelectOption('4:5', 'pages:imageGeneration.fields.aspectRatio.options.4_5'),
  staticSelectOption('5:4', 'pages:imageGeneration.fields.aspectRatio.options.5_4'),
  staticSelectOption('9:16', 'pages:imageGeneration.fields.aspectRatio.options.9_16'),
  staticSelectOption('16:9', 'pages:imageGeneration.fields.aspectRatio.options.16_9'),
  staticSelectOption('21:9', 'pages:imageGeneration.fields.aspectRatio.options.21_9'),
];

export const DEFAULT_IMAGE_GENERATION_ASPECT_RATIO: ImageGenerationAspectRatio = '1:1';

const ASPECT_RATIO_VALUE_SET = new Set(
  IMAGE_GENERATION_ASPECT_RATIO_OPTIONS.map((option) => option.value),
);

export const ensureImageGenerationAspectRatio = (value: unknown): ImageGenerationAspectRatio => {
  if (typeof value !== 'string') return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  const trimmed = value.trim();
  if (ASPECT_RATIO_VALUE_SET.has(trimmed)) {
    return trimmed as ImageGenerationAspectRatio;
  }
  return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
};

export type ImageGenerationSize = '1K' | '2K' | '4K';

export const IMAGE_GENERATION_SIZE_OPTIONS: StaticSelectOption[] = [
  staticSelectOption('1K', 'pages:imageGeneration.fields.imageSize.options.1K'),
  staticSelectOption('2K', 'pages:imageGeneration.fields.imageSize.options.2K'),
  staticSelectOption('4K', 'pages:imageGeneration.fields.imageSize.options.4K'),
];

export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = '1K';

const IMAGE_SIZE_VALUE_SET = new Set(
  IMAGE_GENERATION_SIZE_OPTIONS.map((option) => option.value),
);

export const ensureImageGenerationSize = (value: unknown): ImageGenerationSize => {
  if (typeof value !== 'string') return DEFAULT_IMAGE_GENERATION_SIZE;
  const trimmed = value.trim();
  if (IMAGE_SIZE_VALUE_SET.has(trimmed)) {
    return trimmed as ImageGenerationSize;
  }
  return DEFAULT_IMAGE_GENERATION_SIZE;
};

export const IMAGE_GENERATION_SIZE_MAX_DIMENSION_PX: Record<ImageGenerationSize, number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

export const parseAspectRatio = (value: string): { width: number; height: number } | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = raw.match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) return null;
  const w = Number.parseInt(match[1] ?? '', 10);
  const h = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: w, height: h };
};

export const computeImageGenerationTargetDimensions = (
  aspectRatio: ImageGenerationAspectRatio,
  imageSize: ImageGenerationSize,
): { width: number; height: number } => {
  const parsed = parseAspectRatio(aspectRatio) ?? { width: 1, height: 1 };
  const maxDim = IMAGE_GENERATION_SIZE_MAX_DIMENSION_PX[imageSize] ?? 1024;
  const ratio = parsed.width / parsed.height;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { width: maxDim, height: maxDim };
  }
  if (ratio >= 1) {
    return { width: maxDim, height: Math.max(1, Math.round(maxDim / ratio)) };
  }
  return { width: Math.max(1, Math.round(maxDim * ratio)), height: maxDim };
};
