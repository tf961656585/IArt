import { describe, expect, it } from "vitest";

import {
  clampZoomScale,
  computeMouseAnchoredZoom,
  computeWheelZoomFactor,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
} from "../zoomableImageGeometry";
import type { ImageContentFrame } from "@/features/canvas/utils/imageGeometry";

const makeFrame = (overrides: Partial<ImageContentFrame> = {}): ImageContentFrame => ({
  left: 100,
  top: 100,
  width: 400,
  height: 300,
  scale: 1,
  ...overrides,
});

describe("clampZoomScale", () => {
  it("把值限制在 [ZOOM_SCALE_MIN, ZOOM_SCALE_MAX]", () => {
    expect(clampZoomScale(0.5)).toBe(0.5);
    expect(clampZoomScale(ZOOM_SCALE_MIN)).toBe(ZOOM_SCALE_MIN);
    expect(clampZoomScale(ZOOM_SCALE_MAX)).toBe(ZOOM_SCALE_MAX);
    expect(clampZoomScale(-5)).toBe(ZOOM_SCALE_MIN);
    expect(clampZoomScale(99)).toBe(ZOOM_SCALE_MAX);
  });

  it("非有限值（NaN/Infinity）统一退化为 Fit (1)", () => {
    expect(clampZoomScale(Number.NaN)).toBe(1);
    expect(clampZoomScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoomScale(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe("computeWheelZoomFactor", () => {
  it("deltaY > 0（向外滚）→ factor < 1（缩小）", () => {
    const factor = computeWheelZoomFactor(100, { base: 1.15, unit: 100 });
    expect(factor).toBeCloseTo(1 / 1.15, 5);
    expect(factor).toBeLessThan(1);
  });

  it("deltaY < 0（向内滚）→ factor > 1（放大）", () => {
    const factor = computeWheelZoomFactor(-100, { base: 1.15, unit: 100 });
    expect(factor).toBeCloseTo(1.15, 5);
    expect(factor).toBeGreaterThan(1);
  });

  it("deltaY = 0 → factor = 1（不缩放）", () => {
    expect(computeWheelZoomFactor(0, { base: 1.15, unit: 100 })).toBe(1);
  });

  it("连续滚动自动加速（指数关系）", () => {
    const once = computeWheelZoomFactor(-100, { base: 1.15, unit: 100 });
    const twice = computeWheelZoomFactor(-200, { base: 1.15, unit: 100 });
    expect(twice).toBeCloseTo(once * once, 5);
  });

  it("使用默认 base/unit", () => {
    expect(computeWheelZoomFactor(-100, { base: undefined, unit: undefined })).toBeCloseTo(1.15, 5);
  });
});

describe("computeMouseAnchoredZoom", () => {
  it("prevScale === nextScale 时直接返回原状态", () => {
    const frame = makeFrame();
    const prevPan = { x: 10, y: 20 };
    const result = computeMouseAnchoredZoom({
      prevScale: 1,
      nextScale: 1,
      mouseClient: { x: 200, y: 200 },
      frame,
      prevPan,
    });
    expect(result.scale).toBe(1);
    expect(result.pan).toEqual(prevPan);
  });

  it("鼠标在图片中心时，缩放后平移仍为 0（中心锚点保持不动）", () => {
    const frame = makeFrame(); // left=100, top=100, w=400, h=300 → 中心 (300, 250)
    const result = computeMouseAnchoredZoom({
      prevScale: 1,
      nextScale: 2,
      mouseClient: { x: 300, y: 250 },
      frame,
      prevPan: { x: 0, y: 0 },
    });
    expect(result.scale).toBe(2);
    expect(result.pan.x).toBeCloseTo(0, 5);
    expect(result.pan.y).toBeCloseTo(0, 5);
  });

  it("鼠标不在内容框内时，退化为以中心为锚点（平移按比例缩放）", () => {
    const frame = makeFrame();
    const prevPan = { x: 40, y: -30 };
    const result = computeMouseAnchoredZoom({
      prevScale: 1,
      nextScale: 2,
      mouseClient: { x: 9999, y: 9999 }, // 远离 frame
      frame,
      prevPan,
    });
    expect(result.scale).toBe(2);
    expect(result.pan.x).toBeCloseTo(80, 5);
    expect(result.pan.y).toBeCloseTo(-60, 5);
  });

  it("鼠标在左上角锚点时，缩放后该锚点屏幕坐标保持不变", () => {
    const frame = makeFrame(); // left=100, top=100, w=400, h=300
    // 鼠标落在图片内容框左上角 (100, 100)
    const mouseClient = { x: 100, y: 100 };
    const result = computeMouseAnchoredZoom({
      prevScale: 1,
      nextScale: 2,
      mouseClient,
      frame,
      prevPan: { x: 0, y: 0 },
    });
    expect(result.scale).toBe(2);
    // 锚点（frame 左上角）在 scale=1, pan=0 时屏幕坐标 = (100,100)。
    // 缩放到 2 后，要求仍落在 (100,100)：
    //   center = (300, 250)
    //   anchor - center = (-200, -150)
    //   P = center + (anchor-center)*2 + pan = 300 + (-400) + panX = -100 + panX
    //   要求 P = 100 → panX = 200
    expect(result.pan.x).toBeCloseTo(200, 5);
    expect(result.pan.y).toBeCloseTo(150, 5);
  });

  it("从非 1 的初始缩放继续缩放时，锚点保持不动", () => {
    const frame = makeFrame();
    const mouseClient = { x: 300, y: 250 }; // 中心
    const step1 = computeMouseAnchoredZoom({
      prevScale: 1,
      nextScale: 2,
      mouseClient,
      frame,
      prevPan: { x: 0, y: 0 },
    });
    // 以同锚点继续放大到 3
    const step2 = computeMouseAnchoredZoom({
      prevScale: step1.scale,
      nextScale: 3,
      mouseClient,
      frame,
      prevPan: step1.pan,
    });
    expect(step2.scale).toBe(3);
    // 中心锚点缩放保持中心不动，pan 仍为 0
    expect(step2.pan.x).toBeCloseTo(0, 5);
    expect(step2.pan.y).toBeCloseTo(0, 5);
  });
});
