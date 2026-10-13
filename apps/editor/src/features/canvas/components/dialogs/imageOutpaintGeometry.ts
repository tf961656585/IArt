import {
  MAX_EXPAND_MULTIPLIER_SAME_RATIO,
  SAME_RATIO_TOLERANCE,
  clamp01,
  clampRect,
  computeMinSelectionSizePx,
  type NormalizedRect,
  type OutpaintPreviewState,
} from "./imageOutpaintDialogTypes";

export type OutpaintStageSize = {
  width: number;
  height: number;
};

export type OutpaintExportPlacement = {
  outputWidth: number;
  outputHeight: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
};

const resolveSafeRatio = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
};

export const buildOutpaintInitialPreview = (params: {
  stage: OutpaintStageSize;
  natural: { width: number; height: number };
  targetRatio: number;
}): OutpaintPreviewState => {
  const { stage, natural } = params;
  const safeTargetRatio = resolveSafeRatio(
    params.targetRatio,
    natural.width / Math.max(1, natural.height),
  );
  const naturalRatio = natural.width / Math.max(1, natural.height);
  const safeNaturalRatio = resolveSafeRatio(naturalRatio, safeTargetRatio);
  const isSameRatio =
    Math.abs(safeNaturalRatio - safeTargetRatio) /
      Math.max(safeTargetRatio, safeNaturalRatio) <=
    SAME_RATIO_TOLERANCE;
  const stageFit = isSameRatio ? 1 / MAX_EXPAND_MULTIPLIER_SAME_RATIO : 0.78;
  const stageImageScale = Math.min(
    (stage.width * stageFit) / natural.width,
    (stage.height * stageFit) / natural.height,
  );
  const imageWidth = Math.max(1, Math.round(natural.width * stageImageScale));
  const imageHeight = Math.max(1, Math.round(natural.height * stageImageScale));
  const minSelectionPx = computeMinSelectionSizePx(
    imageWidth,
    imageHeight,
    safeTargetRatio,
  );
  const scaleToFitSelection = Math.min(
    stage.width / minSelectionPx.width,
    stage.height / minSelectionPx.height,
    1,
  );
  const finalImageWidth = Math.max(1, Math.round(imageWidth * scaleToFitSelection));
  const finalImageHeight = Math.max(
    1,
    Math.round(imageHeight * scaleToFitSelection),
  );
  const finalMinSelectionPx = computeMinSelectionSizePx(
    finalImageWidth,
    finalImageHeight,
    safeTargetRatio,
  );
  const selectionWidth = Math.min(stage.width, finalMinSelectionPx.width);
  const selectionHeight = Math.min(stage.height, finalMinSelectionPx.height);
  const selection: NormalizedRect = {
    x: (stage.width - selectionWidth) / 2 / stage.width,
    y: (stage.height - selectionHeight) / 2 / stage.height,
    w: selectionWidth / stage.width,
    h: selectionHeight / stage.height,
  };
  const image: NormalizedRect = {
    x: selection.x + (selection.w - finalImageWidth / stage.width) / 2,
    y: selection.y + (selection.h - finalImageHeight / stage.height) / 2,
    w: finalImageWidth / stage.width,
    h: finalImageHeight / stage.height,
  };
  return {
    stage,
    selection: clampRect(selection),
    image: clampRect(image),
  };
};

export const resizeOutpaintSelectionFromPoint = (params: {
  preview: OutpaintPreviewState;
  point: { x: number; y: number };
  targetRatio: number;
}): OutpaintPreviewState => {
  const { preview, point } = params;
  const { stage, image } = preview;
  const safeTargetRatio = resolveSafeRatio(params.targetRatio, 1);
  const stageCenterPx = { x: stage.width / 2, y: stage.height / 2 };
  const pointerPx = {
    x: point.x * stage.width,
    y: point.y * stage.height,
  };
  let halfW = Math.max(1, Math.abs(pointerPx.x - stageCenterPx.x));
  let halfH = Math.max(1, Math.abs(pointerPx.y - stageCenterPx.y));
  if (halfW / halfH > safeTargetRatio) {
    halfH = halfW / safeTargetRatio;
  } else {
    halfW = halfH * safeTargetRatio;
  }
  const imageWidthPx = image.w * stage.width;
  const imageHeightPx = image.h * stage.height;
  const minSelectionPx = computeMinSelectionSizePx(
    imageWidthPx,
    imageHeightPx,
    safeTargetRatio,
  );
  const minHalfW = minSelectionPx.width / 2;
  const minHalfH = minSelectionPx.height / 2;
  if (halfW < minHalfW || halfH < minHalfH) {
    halfW = minHalfW;
    halfH = minHalfH;
  }
  const maxWidth = Math.min(stage.width, stage.height * safeTargetRatio);
  const maxHalfW = maxWidth / 2;
  const maxHalfH = maxHalfW / safeTargetRatio;
  if (halfW > maxHalfW) {
    halfW = maxHalfW;
    halfH = maxHalfH;
  }
  const width = Math.max(1, Math.round(halfW * 2));
  const height = Math.max(1, Math.round(halfH * 2));
  const selection = clampRect({
    x: (stage.width - width) / 2 / stage.width,
    y: (stage.height - height) / 2 / stage.height,
    w: width / stage.width,
    h: height / stage.height,
  });
  const nextImage = clampRect({
    ...image,
    x: clamp01(
      Math.min(
        Math.max(image.x, selection.x),
        selection.x + selection.w - image.w,
      ),
    ),
    y: clamp01(
      Math.min(
        Math.max(image.y, selection.y),
        selection.y + selection.h - image.h,
      ),
    ),
  });
  return { stage, selection, image: nextImage };
};

export const projectOutpaintExportPlacement = (params: {
  preview: OutpaintPreviewState;
  outputWidth: number;
  outputHeight: number;
}): OutpaintExportPlacement => {
  const { preview } = params;
  const selectionWidthPx = preview.selection.w * preview.stage.width;
  const safeSelectionWidth = Math.max(1, selectionWidthPx);
  const scale = params.outputWidth / safeSelectionWidth;
  const imageX =
    (preview.image.x - preview.selection.x) * preview.stage.width * scale;
  const imageY =
    (preview.image.y - preview.selection.y) * preview.stage.height * scale;
  return {
    outputWidth: params.outputWidth,
    outputHeight: params.outputHeight,
    imageX,
    imageY,
    imageWidth: preview.image.w * preview.stage.width * scale,
    imageHeight: preview.image.h * preview.stage.height * scale,
  };
};
