import { describe, expect, it } from "vitest";

import {
  clientPointToImageNorm,
  computeContainContentFrame,
  imageNormToFramePoint,
  normalizedRectToNaturalRect,
  cssPxToShortSideRatio,
  shortSideRatioToCssPx,
  shortSideRatioToNaturalPx,
} from "../imageGeometry";

describe("imageGeometry", () => {
  it("computes contain frame for 16:9 image inside square box", () => {
    const frame = computeContainContentFrame(
      { width: 1600, height: 900 },
      { left: 0, top: 0, width: 1024, height: 1024 },
    );
    expect(frame.width).toBe(1024);
    expect(frame.height).toBe(576);
    expect(frame.left).toBe(0);
    expect(frame.top).toBe(224);
  });

  it("maps center point to normalized center and back", () => {
    const frame = computeContainContentFrame(
      { width: 1600, height: 900 },
      { left: 100, top: 40, width: 1024, height: 1024 },
    );
    const normalized = clientPointToImageNorm(
      { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 },
      frame,
    );
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    const client = imageNormToFramePoint({ x: 0.5, y: 0.5 }, frame);
    expect(client).toEqual({
      x: frame.left + frame.width / 2,
      y: frame.top + frame.height / 2,
    });
  });

  it("returns null for letterbox region", () => {
    const frame = computeContainContentFrame(
      { width: 1600, height: 900 },
      { left: 0, top: 0, width: 1024, height: 1024 },
    );
    expect(
      clientPointToImageNorm({ x: 512, y: 100 }, frame),
    ).toBeNull();
  });

  it("projects normalized rect to stable natural pixels", () => {
    expect(
      normalizedRectToNaturalRect(
        { x: 0.125, y: 0.25, w: 0.5, h: 0.5 },
        { width: 1600, height: 900 },
      ),
    ).toEqual({
      x: 200,
      y: 225,
      width: 800,
      height: 450,
    });
  });

  it("keeps short-side ratio consistent across css and natural spaces", () => {
    const frame = computeContainContentFrame(
      { width: 1600, height: 900 },
      { left: 0, top: 0, width: 1024, height: 1024 },
    );
    const ratio = cssPxToShortSideRatio(24, frame);
    expect(shortSideRatioToCssPx(ratio, frame)).toBeCloseTo(24);
    expect(shortSideRatioToNaturalPx(ratio, { width: 1600, height: 900 })).toBeCloseTo(37.5);
  });
});
