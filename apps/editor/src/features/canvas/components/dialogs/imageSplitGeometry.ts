import {
  clientPointToImageNorm,
  type ImageContentFrame,
} from "../../utils/imageGeometry";

// ─── 公共类型 ──────────────────────────────────────────────

export type LineAxis = "vertical" | "horizontal";

export type LineItem = { id: string; pos: number }; // pos: 0~1

// ─── 常量 ─────────────────────────────────────────────────

export const MAX_LINES_PER_AXIS = 4; // 5x5 blocks => lines <= 4

// ─── 基础数学辅助 ──────────────────────────────────────────

export const clamp01 = (value: number): number => {
  return Math.max(0, Math.min(1, value));
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

// ─── 纯计算函数 ────────────────────────────────────────────

export const sortByPos = (a: LineItem, b: LineItem): number => a.pos - b.pos;

export const fromPercent = (percent: number): number => clamp01(percent / 100);

export const createLineId = (axis: LineAxis): string =>
  `${axis}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export const computeBestInsertPos = (lines: LineItem[]): number => {
  const sorted = [...lines].sort(sortByPos).map((l) => l.pos);
  const stops: number[] = [0, ...sorted, 1];
  let bestMid = 0.5;
  let bestGap = -1;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a === undefined || b === undefined) continue;
    const gap = b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = a + gap / 2;
    }
  }
  return clamp01(bestMid);
};

export const buildEvenLines = (count: number, axis: LineAxis): LineItem[] => {
  if (count <= 0) return [];
  const safeCount = Math.max(0, Math.min(MAX_LINES_PER_AXIS, Math.round(count)));
  const items: LineItem[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    const pos = (i + 1) / (safeCount + 1);
    items.push({ id: createLineId(axis), pos });
  }
  return items;
};

export const resolveMinGap = (
  axis: LineAxis,
  naturalSize: { width: number; height: number } | null,
): number => {
  const px =
    axis === "vertical"
      ? naturalSize !== null && naturalSize !== undefined
        ? naturalSize.width
        : undefined
      : naturalSize !== null && naturalSize !== undefined
        ? naturalSize.height
        : undefined;
  if (px !== undefined && px > 1) return 1 / px;
  return 0.002;
};

export const clampLineWithNeighbors = (
  axis: LineAxis,
  lines: LineItem[],
  lineId: string,
  nextPos: number,
  naturalSize: { width: number; height: number } | null,
): number => {
  const sorted = [...lines].sort(sortByPos);
  const idx = sorted.findIndex((l) => l.id === lineId);
  if (idx < 0) return clamp01(nextPos);

  const minGap = resolveMinGap(axis, naturalSize);
  const prevItem = idx > 0 ? sorted[idx - 1] : undefined;
  const nextItem = idx < sorted.length - 1 ? sorted[idx + 1] : undefined;
  const prev = prevItem !== undefined ? prevItem.pos : 0;
  const next = nextItem !== undefined ? nextItem.pos : 1;
  return clamp(clamp01(nextPos), prev + minGap, next - minGap);
};

export const hasDuplicateInt = (values: number[]): boolean => {
  const seen = new Set<number>();
  for (const v of values) {
    if (seen.has(v)) return true;
    seen.add(v);
  }
  return false;
};

// ─── 百分比 / 坐标转换 ────────────────────────────────────

export const toImageSplitPercent = (pos01: number): number => {
  return Math.round(clamp01(pos01) * 10000) / 100;
};

export const getSplitAxisPositionFromClientPoint = (params: {
  axis: "vertical" | "horizontal";
  clientX: number;
  clientY: number;
  frame: ImageContentFrame;
}): number | null => {
  const point = clientPointToImageNorm(
    { x: params.clientX, y: params.clientY },
    params.frame,
  );
  if (point === null) {
    return null;
  }
  return params.axis === "vertical" ? point.x : point.y;
};

// ─── 网格预设 ─────────────────────────────────────────────

export const buildGridPreset = (
  rows: number,
  cols: number,
): { verticalLines: LineItem[]; horizontalLines: LineItem[] } => {
  return {
    verticalLines: buildEvenLines(cols - 1, "vertical"),
    horizontalLines: buildEvenLines(rows - 1, "horizontal"),
  };
};

// ─── 瓦片矩形计算 ──────────────────────────────────────────

export type TileRect = {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const computeTileRects = (params: {
  verticalLines: LineItem[];
  horizontalLines: LineItem[];
  naturalSize: { width: number; height: number };
}): TileRect[] => {
  const { verticalLines, horizontalLines, naturalSize } = params;
  const sortedV = [...verticalLines].sort(sortByPos);
  const sortedH = [...horizontalLines].sort(sortByPos);

  const xStops: number[] = [0, ...sortedV.map((l) => l.pos), 1];
  const yStops: number[] = [0, ...sortedH.map((l) => l.pos), 1];

  const tiles: TileRect[] = [];

  for (let row = 0; row < yStops.length - 1; row += 1) {
    for (let col = 0; col < xStops.length - 1; col += 1) {
      const y0 = yStops[row];
      const y1 = yStops[row + 1];
      const x0 = xStops[col];
      const x1 = xStops[col + 1];
      if (
        y0 === undefined || y1 === undefined ||
        x0 === undefined || x1 === undefined
      ) {
        continue;
      }
      tiles.push({
        row: row + 1,
        col: col + 1,
        x: Math.round(x0 * naturalSize.width),
        y: Math.round(y0 * naturalSize.height),
        width: Math.round((x1 - x0) * naturalSize.width),
        height: Math.round((y1 - y0) * naturalSize.height),
      });
    }
  }

  return tiles;
};
