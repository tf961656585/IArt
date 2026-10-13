import {
  computeImageGenerationTargetDimensions,
  type ImageGenerationAspectRatio,
  type ImageGenerationSize,
} from "@/features/models/shared/imageGenerationOptions";
import { projectOutpaintExportPlacement } from "./imageOutpaintGeometry";
import {
  hasValidRect,
  type OutpaintPreviewState,
} from "./imageOutpaintDialogTypes";

export async function exportOutpaintSourceBlob(params: {
  imageElement: HTMLImageElement | null;
  preview: OutpaintPreviewState | null;
  aspectRatio: ImageGenerationAspectRatio;
  imageSize: ImageGenerationSize;
}): Promise<Blob> {
  const { imageElement, preview, aspectRatio, imageSize } = params;
  if (!preview) throw new Error("预览状态缺失");
  if (!imageElement) throw new Error("图片尚未加载");
  if (!hasValidRect(preview.selection) || !hasValidRect(preview.image)) {
    throw new Error("选区/图片区域无效");
  }

  const { width: outW, height: outH } = computeImageGenerationTargetDimensions(
    aspectRatio,
    imageSize,
  );
  const placement = projectOutpaintExportPlacement({
    preview,
    outputWidth: outW,
    outputHeight: outH,
  });
  const canvas = document.createElement("canvas");
  canvas.width = placement.outputWidth;
  canvas.height = placement.outputHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, placement.outputWidth, placement.outputHeight);
  ctx.drawImage(
    imageElement,
    placement.imageX,
    placement.imageY,
    placement.imageWidth,
    placement.imageHeight,
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("CANVAS_TO_BLOB_FAILED"));
    }, "image/png");
  });
}
