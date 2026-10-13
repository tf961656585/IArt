import type { CSSProperties } from "react";
import { normalizedRectToNaturalRect, type NormalizedRect, type NormalizedPoint } from "../../utils/imageGeometry";

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

export const buildImageCropRect = (
  selection: NormalizedRect,
  naturalSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } => {
  return normalizedRectToNaturalRect(selection, naturalSize);
};

export const buildImageCropPreviewStyle = (params: {
  localUrl: string;
  selection: NormalizedRect;
  naturalSize: { width: number; height: number };
  maxBoxWidth: number;
  maxBoxHeight: number;
}): CSSProperties | null => {
  const { localUrl, selection, naturalSize, maxBoxWidth, maxBoxHeight } = params;
  const cropWidth = selection.w * naturalSize.width;
  const cropHeight = selection.h * naturalSize.height;
  if (cropWidth <= 0 || cropHeight <= 0) return null;
  const aspect = cropWidth / cropHeight;
  let boxWidth = maxBoxWidth;
  let boxHeight = Math.round(boxWidth / aspect);
  if (boxHeight > maxBoxHeight) {
    boxHeight = maxBoxHeight;
    boxWidth = Math.round(boxHeight * aspect);
  }
  const denomX = Math.max(1e-6, 1 - selection.w);
  const denomY = Math.max(1e-6, 1 - selection.h);
  const posX = clamp((selection.x / denomX) * 100, 0, 100);
  const posY = clamp((selection.y / denomY) * 100, 0, 100);
  return {
    width: boxWidth,
    height: boxHeight,
    backgroundImage: `url(${localUrl})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${100 / selection.w}% auto`,
    backgroundPosition: `${posX}% ${posY}%`,
  };
};

export const constrainToRatio = (params: {
  selection: NormalizedRect;
  anchor: NormalizedPoint;
  ratio: number;
  imageRatio: number;
}): NormalizedRect => {
  const { selection, anchor, ratio, imageRatio } = params;

  // 在归一化坐标系中，x 和 y 的实际像素比不同
  // 选区的归一化宽高比 = (selection.w / selection.h) * imageRatio
  // 我们需要调整选区使得 (newW / newH) * imageRatio = ratio
  const normalizedRatio = ratio / imageRatio;

  let newW = selection.w;
  let newH = selection.h;

  // 以 anchor 为锚点，调整宽或高
  if (newW / newH > normalizedRatio) {
    // 太宽，收窄宽度
    newW = newH * normalizedRatio;
  } else {
    // 太高，收窄高度
    newH = newW / normalizedRatio;
  }

  // 根据 anchor 定位
  let newX: number;
  let newY: number;

  if (anchor.x <= selection.x + selection.w / 2) {
    // anchor 在左侧，选区右对齐
    newX = selection.x + selection.w - newW;
  } else {
    // anchor 在右侧，选区左对齐
    newX = selection.x;
  }

  if (anchor.y <= selection.y + selection.h / 2) {
    // anchor 在上侧，选区下对齐
    newY = selection.y + selection.h - newH;
  } else {
    // anchor 在下侧，选区上对齐
    newY = selection.y;
  }

  // clamp to [0, 1]
  newX = Math.max(0, Math.min(1 - newW, newX));
  newY = Math.max(0, Math.min(1 - newH, newY));

  return { x: newX, y: newY, w: newW, h: newH };
};

export const buildRuleOfThirdsLines = (selection: NormalizedRect): {
  horizontal: [number, number];
  vertical: [number, number];
} => {
  return {
    horizontal: [
      selection.y + selection.h / 3,
      selection.y + (2 * selection.h) / 3,
    ],
    vertical: [
      selection.x + selection.w / 3,
      selection.x + (2 * selection.w) / 3,
    ],
  };
};

export type AspectRatioPreset = "free" | "1:1" | "4:3" | "16:9" | "3:2";

export const ASPECT_RATIOS: ReadonlyArray<{
  preset: AspectRatioPreset;
  label: string;
  ratio: number | null;
}> = [
  { preset: "free", label: "自由", ratio: null },
  { preset: "1:1", label: "1:1", ratio: 1 },
  { preset: "4:3", label: "4:3", ratio: 4 / 3 },
  { preset: "16:9", label: "16:9", ratio: 16 / 9 },
  { preset: "3:2", label: "3:2", ratio: 3 / 2 },
];

export const getAspectRatioValue = (preset: AspectRatioPreset): number | null => {
  const entry = ASPECT_RATIOS.find((r) => r.preset === preset);
  return entry !== undefined ? entry.ratio : null;
};
