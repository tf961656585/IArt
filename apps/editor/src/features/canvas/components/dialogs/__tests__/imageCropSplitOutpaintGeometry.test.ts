import { describe, expect, it } from "vitest";

import { buildImageCropPreviewStyle, buildImageCropRect, constrainToRatio, buildRuleOfThirdsLines } from "../imageCropGeometry";
import { getSplitAxisPositionFromClientPoint, toImageSplitPercent, buildGridPreset, computeTileRects } from "../imageSplitGeometry";
import {
  buildOutpaintInitialPreview,
  projectOutpaintExportPlacement,
  resizeOutpaintSelectionFromPoint,
} from "../imageOutpaintGeometry";

describe("crop / split / outpaint geometry", () => {
  it("crop preview style and natural rect stay aligned", () => {
    const selection = { x: 0.125, y: 0.25, w: 0.5, h: 0.5 };
    const naturalSize = { width: 1600, height: 900 };
    const rect = buildImageCropRect(selection, naturalSize);
    const style = buildImageCropPreviewStyle({
      localUrl: "/files/source.png",
      selection,
      naturalSize,
      maxBoxWidth: 220,
      maxBoxHeight: 240,
    });
    expect(rect).toEqual({ x: 200, y: 225, width: 800, height: 450 });
    expect(style).not.toBeNull();
    expect(style?.backgroundSize).toBe("200% auto");
    expect(style?.backgroundPosition).toBe("25% 50%");
  });

  it("split drag position and submitted percents keep expected precision", () => {
    const frame = { left: 100, top: 200, width: 1024, height: 576, scale: 1 };
    const vertical = getSplitAxisPositionFromClientPoint({
      axis: "vertical",
      clientX: 356,
      clientY: 488,
      frame,
    });
    const horizontal = getSplitAxisPositionFromClientPoint({
      axis: "horizontal",
      clientX: 356,
      clientY: 488,
      frame,
    });
    expect(vertical).toBeCloseTo(0.25);
    expect(horizontal).toBeCloseTo(0.5);
    expect(toImageSplitPercent(vertical ?? 0)).toBe(25);
    expect(toImageSplitPercent(0.33337)).toBe(33.34);
    const naturalWidth = 1600;
    const naturalHeight = 900;
    expect(Math.round((vertical ?? 0) * naturalWidth)).toBe(400);
    expect(Math.round((horizontal ?? 0) * naturalHeight)).toBe(450);
  });

  it("outpaint preview selection and export placement keep original image landing consistent", () => {
    const preview = buildOutpaintInitialPreview({
      stage: { width: 1200, height: 800 },
      natural: { width: 1600, height: 900 },
      targetRatio: 1,
    });
    const resized = resizeOutpaintSelectionFromPoint({
      preview,
      point: { x: 0.9, y: 0.9 },
      targetRatio: 1,
    });
    const placement = projectOutpaintExportPlacement({
      preview: resized,
      outputWidth: 1024,
      outputHeight: 1024,
    });
    expect(resized.selection.w * resized.stage.width).toBeCloseTo(
      resized.selection.h * resized.stage.height,
    );
    expect(placement.outputWidth).toBe(1024);
    expect(placement.imageWidth / placement.outputWidth).toBeCloseTo(
      resized.image.w / resized.selection.w,
    );
    expect(placement.imageHeight / placement.outputHeight).toBeCloseTo(
      resized.image.h / resized.selection.h,
    );
    expect(placement.imageX / placement.outputWidth).toBeCloseTo(
      (resized.image.x - resized.selection.x) / resized.selection.w,
    );
    expect(placement.imageY / placement.outputHeight).toBeCloseTo(
      (resized.image.y - resized.selection.y) / resized.selection.h,
    );
  });
});

describe("buildGridPreset", () => {
  it("1x1 produces no lines", () => {
    const result = buildGridPreset(1, 1);
    expect(result.verticalLines).toHaveLength(0);
    expect(result.horizontalLines).toHaveLength(0);
  });

  it("2x2 produces 1 vertical + 1 horizontal line", () => {
    const result = buildGridPreset(2, 2);
    expect(result.verticalLines).toHaveLength(1);
    expect(result.horizontalLines).toHaveLength(1);
    const v0 = result.verticalLines[0];
    const h0 = result.horizontalLines[0];
    expect(v0).not.toBeUndefined();
    expect(h0).not.toBeUndefined();
    if (v0 !== undefined) expect(v0.pos).toBeCloseTo(0.5);
    if (h0 !== undefined) expect(h0.pos).toBeCloseTo(0.5);
  });

  it("3x3 produces 2 vertical + 2 horizontal lines at 1/3 intervals", () => {
    const result = buildGridPreset(3, 3);
    expect(result.verticalLines).toHaveLength(2);
    expect(result.horizontalLines).toHaveLength(2);
    const v0 = result.verticalLines[0];
    const v1 = result.verticalLines[1];
    if (v0 !== undefined) expect(v0.pos).toBeCloseTo(1 / 3);
    if (v1 !== undefined) expect(v1.pos).toBeCloseTo(2 / 3);
  });

  it("1x2 produces 1 vertical line, no horizontal", () => {
    const result = buildGridPreset(1, 2);
    expect(result.verticalLines).toHaveLength(1);
    expect(result.horizontalLines).toHaveLength(0);
  });

  it("2x1 produces no vertical line, 1 horizontal", () => {
    const result = buildGridPreset(2, 1);
    expect(result.verticalLines).toHaveLength(0);
    expect(result.horizontalLines).toHaveLength(1);
  });
});

describe("computeTileRects", () => {
  it("single row, single col (no lines) returns full image", () => {
    const result = computeTileRects({
      verticalLines: [],
      horizontalLines: [],
      naturalSize: { width: 1000, height: 500 },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ row: 1, col: 1, x: 0, y: 0, width: 1000, height: 500 });
  });

  it("2x2 grid with center lines", () => {
    const result = computeTileRects({
      verticalLines: [{ id: "v1", pos: 0.5 }],
      horizontalLines: [{ id: "h1", pos: 0.5 }],
      naturalSize: { width: 1000, height: 500 },
    });
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ row: 1, col: 1, x: 0, y: 0, width: 500, height: 250 });
    expect(result[1]).toEqual({ row: 1, col: 2, x: 500, y: 0, width: 500, height: 250 });
    expect(result[2]).toEqual({ row: 2, col: 1, x: 0, y: 250, width: 500, height: 250 });
    expect(result[3]).toEqual({ row: 2, col: 2, x: 500, y: 250, width: 500, height: 250 });
  });

  it("single horizontal line creates 2 rows", () => {
    const result = computeTileRects({
      verticalLines: [],
      horizontalLines: [{ id: "h1", pos: 0.4 }],
      naturalSize: { width: 1000, height: 500 },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ row: 1, col: 1, x: 0, y: 0, width: 1000, height: 200 });
    expect(result[1]).toEqual({ row: 2, col: 1, x: 0, y: 200, width: 1000, height: 300 });
  });
});

describe("constrainToRatio", () => {
  it("1:1 constraint on square image produces square selection", () => {
    const result = constrainToRatio({
      selection: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 },
      anchor: { x: 0.1, y: 0.1 },
      ratio: 1,
      imageRatio: 1,
    });
    // 归一化坐标中，1:1 + imageRatio=1 意味着 w == h
    expect(result.w).toBeCloseTo(result.h);
  });

  it("16:9 constraint produces correct ratio", () => {
    const result = constrainToRatio({
      selection: { x: 0, y: 0, w: 0.8, h: 0.8 },
      anchor: { x: 0, y: 0 },
      ratio: 16 / 9,
      imageRatio: 1,
    });
    const actualRatio = (result.w / result.h) * 1;
    expect(actualRatio).toBeCloseTo(16 / 9, 2);
  });

  it("4:3 constraint on wide image", () => {
    const result = constrainToRatio({
      selection: { x: 0, y: 0, w: 0.9, h: 0.5 },
      anchor: { x: 0, y: 0 },
      ratio: 4 / 3,
      imageRatio: 16 / 9,
    });
    // 选区归一化宽高比 = (w/h) * imageRatio = target ratio
    const actualRatio = (result.w / result.h) * (16 / 9);
    expect(actualRatio).toBeCloseTo(4 / 3, 2);
  });
});

describe("buildRuleOfThirdsLines", () => {
  it("full image selection", () => {
    const result = buildRuleOfThirdsLines({ x: 0, y: 0, w: 1, h: 1 });
    expect(result.horizontal[0]).toBeCloseTo(1 / 3);
    expect(result.horizontal[1]).toBeCloseTo(2 / 3);
    expect(result.vertical[0]).toBeCloseTo(1 / 3);
    expect(result.vertical[1]).toBeCloseTo(2 / 3);
  });

  it("partial selection", () => {
    const result = buildRuleOfThirdsLines({ x: 0.2, y: 0.3, w: 0.6, h: 0.4 });
    expect(result.horizontal[0]).toBeCloseTo(0.3 + 0.4 / 3);
    expect(result.horizontal[1]).toBeCloseTo(0.3 + (2 * 0.4) / 3);
    expect(result.vertical[0]).toBeCloseTo(0.2 + 0.6 / 3);
    expect(result.vertical[1]).toBeCloseTo(0.2 + (2 * 0.6) / 3);
  });
});
