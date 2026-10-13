import type { NormalizedPoint } from "../../utils/imageGeometry";

export type { NormalizedPoint };

export type Stroke = {
  color: string;
  widthRatio: number;
  points: NormalizedPoint[];
};

export type TextBox = {
  id: string;
  x: number;
  y: number;
  widthRatio: number;
  rotation: number;
  fontSizeRatio: number;
  color: string;
  text: string;
};

export type AnnotationSnapshot = {
  strokes: Stroke[];
  texts: TextBox[];
};

export interface ImageAnnotateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  onConfirm: (blob: Blob) => Promise<void>;
}

export type TextTransformType =
  | "move"
  | "rotate"
  | "scale"
  | "resize-l"
  | "resize-r";

export const DEFAULT_BRUSH_COLOR = "#ff3b30";
export const DEFAULT_BRUSH_SIZE_PX = 8;
export const DEFAULT_TEXT_FONT_SIZE_PX = 24;
export const TEXT_FONT_SIZE_STORAGE_KEY =
  "iarts.canvas.imageAnnotate.textFontSize";

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const createId = (): string => {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    void 0;
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!target) return false;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
};

export const toBlob = (
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality: number | undefined,
): Promise<Blob> => {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("导出失败：无法生成图片 Blob"));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
};
