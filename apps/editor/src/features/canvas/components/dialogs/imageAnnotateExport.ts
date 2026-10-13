import {
  toBlob,
} from "./imageAnnotateDialogTypes";
import { renderImageAnnotationToCanvas } from "./imageAnnotationRenderer";
import type { Stroke, TextBox } from "./imageAnnotateDialogTypes";

export async function exportAnnotatedImageBlob(params: {
  image: HTMLImageElement;
  strokes: Stroke[];
  texts: TextBox[];
  editingTextId: string | null;
  editingValue: string;
}): Promise<Blob> {
  const { image, strokes, texts, editingTextId, editingValue } = params;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("图片尺寸无效");

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(image, 0, 0, width, height);
  renderImageAnnotationToCanvas({
    ctx,
    targetWidth: width,
    targetHeight: height,
    strokes,
    texts,
    editingTextId,
    editingValue,
  });

  return toBlob(out, "image/png", undefined);
}
