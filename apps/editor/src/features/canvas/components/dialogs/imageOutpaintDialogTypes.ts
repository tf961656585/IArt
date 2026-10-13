import type {
  ImageGenerationAspectRatio,
  ImageGenerationSize,
} from "@/features/models/shared/imageGenerationOptions";

export type NormalizedRect = { x: number; y: number; w: number; h: number };

export type OutpaintPreviewState = {
  stage: { width: number; height: number };
  selection: NormalizedRect;
  image: NormalizedRect;
};

export type OutpaintRectPx = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageOutpaintDialogConfirmPayload = {
  sourceImage: Blob;
  modelId: string;
  aspectRatio: ImageGenerationAspectRatio;
  imageSize: ImageGenerationSize;
  userPrompt: string;
  count: number;
};

export interface ImageOutpaintModelOption {
  modelId: string;
  label: string;
}

export interface ImageOutpaintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  initialModelId: string | undefined;
  modelOptions: ImageOutpaintModelOption[];
  onConfirm: (
    payload: ImageOutpaintDialogConfirmPayload,
  ) => Promise<void> | void;
}

export const OUTPAINT_COUNT_STORAGE_KEY = "iarts.canvas.outpaint.count";
export const DEFAULT_OUTPAINT_COUNT = 1;
export const MAX_EXPAND_MULTIPLIER_SAME_RATIO = 3;
export const SAME_RATIO_TOLERANCE = 0.02;

export const normalizeOutpaintCount = (
  value: unknown,
  fallback = DEFAULT_OUTPAINT_COUNT,
): number => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

export const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, value));

export const clampRect = (rect: NormalizedRect): NormalizedRect => {
  const w = clamp01(rect.w);
  const h = clamp01(rect.h);
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h };
};

export const hasValidRect = (
  rect: NormalizedRect | null | undefined,
): rect is NormalizedRect => {
  if (!rect) return false;
  return rect.w > 0 && rect.h > 0;
};

export const computeMinSelectionSizePx = (
  imgW: number,
  imgH: number,
  ratio: number,
): { width: number; height: number } => {
  const safeImgW = Math.max(1, imgW);
  const safeImgH = Math.max(1, imgH);
  const safeRatio =
    Number.isFinite(ratio) && ratio > 0 ? ratio : safeImgW / safeImgH;
  const minHeight = Math.max(safeImgH, safeImgW / safeRatio);
  const minWidth = minHeight * safeRatio;
  return { width: Math.ceil(minWidth), height: Math.ceil(minHeight) };
};

export const isPointInRect = (
  point: { x: number; y: number },
  rect: NormalizedRect,
): boolean => {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
};

export const getOutpaintPreviewRects = (
  preview: OutpaintPreviewState | null,
): { selectionPx: OutpaintRectPx | null; imagePx: OutpaintRectPx | null } => {
  if (!preview) return { selectionPx: null, imagePx: null };
  const { stage, selection, image } = preview;
  return {
    selectionPx: {
      x: selection.x * stage.width,
      y: selection.y * stage.height,
      width: selection.w * stage.width,
      height: selection.h * stage.height,
    },
    imagePx: {
      x: image.x * stage.width,
      y: image.y * stage.height,
      width: image.w * stage.width,
      height: image.h * stage.height,
    },
  };
};
