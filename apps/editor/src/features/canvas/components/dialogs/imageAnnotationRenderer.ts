import {
  clamp,
  type Stroke,
  type TextBox,
} from "./imageAnnotateDialogTypes";

export interface AnnotationCanvasContext {
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  stroke: () => void;
  fillText: (text: string, x: number, y: number) => void;
  measureText: (text: string) => TextMetrics;
  save: () => void;
  restore: () => void;
  translate: (x: number, y: number) => void;
  rotate: (angle: number) => void;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  font: string;
}

type WrappedText = {
  lines: string[];
  lineHeightPx: number;
  widthPx: number;
  heightPx: number;
};

const resolveAnnotationText = (
  item: TextBox,
  editingTextId: string | null,
  editingValue: string,
): string => {
  if (item.id === editingTextId) {
    return editingValue.replace(/\r\n/g, "\n");
  }
  return item.text;
};

export const wrapAnnotationText = (
  ctx: AnnotationCanvasContext,
  text: string,
  maxWidth: number,
): string[] => {
  const paragraphs = text.split("\n");
  const output: string[] = [];
  const safeWidth = Math.max(1, maxWidth);
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    let line = "";
    for (let index = 0; index < paragraph.length; index += 1) {
      const nextChar = paragraph[index];
      if (nextChar === undefined) {
        continue;
      }
      const test = `${line}${nextChar}`;
      if (line.length === 0 || ctx.measureText(test).width <= safeWidth) {
        line = test;
        continue;
      }
      output.push(line);
      line = nextChar;
    }
    output.push(line);
  }
  return output;
};

const buildWrappedText = (params: {
  ctx: AnnotationCanvasContext;
  text: string;
  fontSizePx: number;
  boxWidthPx: number;
}): WrappedText => {
  const { ctx, text, fontSizePx, boxWidthPx } = params;
  const lines = wrapAnnotationText(ctx, text, boxWidthPx);
  const widthPx = lines.reduce((maxWidth, line) => {
    return Math.max(maxWidth, ctx.measureText(line).width);
  }, 0);
  const lineHeightPx = fontSizePx * 1.2;
  return {
    lines,
    lineHeightPx,
    widthPx,
    heightPx: lines.length * lineHeightPx,
  };
};

export const measureTextBoxInImageSpace = (params: {
  ctx: AnnotationCanvasContext;
  targetWidth: number;
  targetHeight: number;
  textBox: TextBox;
  editingTextId: string | null;
  editingValue: string;
}): {
  widthPx: number;
  heightPx: number;
  lineHeightPx: number;
  lines: string[];
  fontSizePx: number;
  boxWidthPx: number;
} => {
  const { ctx, targetWidth, targetHeight, textBox, editingTextId, editingValue } =
    params;
  const basis = Math.max(1, Math.min(targetWidth, targetHeight));
  const fontSizePx = clamp(textBox.fontSizeRatio * basis, 8, 256);
  const boxWidthPx = clamp(textBox.widthRatio * targetWidth, 1, targetWidth);
  ctx.save();
  ctx.font = `${fontSizePx}px sans-serif`;
  const measured = buildWrappedText({
    ctx,
    text: resolveAnnotationText(textBox, editingTextId, editingValue),
    fontSizePx,
    boxWidthPx,
  });
  ctx.restore();
  return {
    widthPx: measured.widthPx,
    heightPx: measured.heightPx,
    lineHeightPx: measured.lineHeightPx,
    lines: measured.lines,
    fontSizePx,
    boxWidthPx,
  };
};

export const renderImageAnnotationToCanvas = (params: {
  ctx: AnnotationCanvasContext;
  targetWidth: number;
  targetHeight: number;
  strokes: Stroke[];
  texts: TextBox[];
  editingTextId: string | null;
  editingValue: string;
}): void => {
  const {
    ctx,
    targetWidth,
    targetHeight,
    strokes,
    texts,
    editingTextId,
    editingValue,
  } = params;
  const basis = Math.max(1, Math.min(targetWidth, targetHeight));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.points.length < 1) {
      continue;
    }
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.widthRatio * basis;
    ctx.beginPath();
    const first = stroke.points[0];
    if (first === undefined) {
      continue;
    }
    ctx.moveTo(first.x * targetWidth, first.y * targetHeight);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      if (point === undefined) {
        continue;
      }
      ctx.lineTo(point.x * targetWidth, point.y * targetHeight);
    }
    ctx.stroke();
  }

  for (const textBox of texts) {
    const text = resolveAnnotationText(textBox, editingTextId, editingValue);
    if (!text.trim()) {
      continue;
    }
    const measured = measureTextBoxInImageSpace({
      ctx,
      targetWidth,
      targetHeight,
      textBox,
      editingTextId,
      editingValue,
    });
    ctx.save();
    ctx.translate(textBox.x * targetWidth, textBox.y * targetHeight);
    ctx.rotate(textBox.rotation);
    ctx.fillStyle = textBox.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${measured.fontSizePx}px sans-serif`;
    const startX = -measured.boxWidthPx / 2;
    let currentY = -measured.heightPx / 2;
    for (const line of measured.lines) {
      ctx.fillText(line, startX, currentY);
      currentY += measured.lineHeightPx;
    }
    ctx.restore();
  }
};
