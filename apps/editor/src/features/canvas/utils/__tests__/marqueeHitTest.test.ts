import { describe, expect, it } from "vitest";

import {
  marqueeHitTest,
  type MarqueeRect,
  type MarqueeHitTarget,
} from "../marqueeHitTest";

describe("marqueeHitTest", () => {
  it("returns empty result for empty target list", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const result = marqueeHitTest(rect, []);
    expect(result.nodeIds).toEqual([]);
    expect(result.annotationIds).toEqual([]);
  });

  it("hits when marquee fully contains node", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 200, y2: 200 };
    const targets: MarqueeHitTarget[] = [
      { id: "node-1", kind: 'node', position: { x: 50, y: 50 }, width: 100, height: 80 },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual(["node-1"]);
    expect(result.annotationIds).toEqual([]);
  });

  it("hits when marquee partially overlaps node", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const targets: MarqueeHitTarget[] = [
      { id: "node-1", kind: 'node', position: { x: 50, y: 50 }, width: 100, height: 100 },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual(["node-1"]);
  });

  it("does not hit when marquee does not overlap node", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const targets: MarqueeHitTarget[] = [
      { id: "node-1", kind: 'node', position: { x: 200, y: 200 }, width: 50, height: 50 },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual([]);
  });

  it("skips node when width is undefined", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 200, y2: 200 };
    const targets: MarqueeHitTarget[] = [
      { id: "node-1", kind: 'node', position: { x: 50, y: 50 }, width: undefined, height: 80 },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual([]);
  });

  it("skips node when height is undefined", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 200, y2: 200 };
    const targets: MarqueeHitTarget[] = [
      { id: "node-1", kind: 'node', position: { x: 50, y: 50 }, width: 100, height: undefined },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual([]);
  });

  it("returns only hit node IDs from multiple targets", () => {
    const rect: MarqueeRect = { x1: 0, y1: 0, x2: 150, y2: 150 };
    const targets: MarqueeHitTarget[] = [
      { id: "hit-1", kind: 'node', position: { x: 10, y: 10 }, width: 50, height: 50 },
      { id: "hit-2", kind: 'node', position: { x: 100, y: 100 }, width: 80, height: 80 },
      { id: "miss-1", kind: 'node', position: { x: 300, y: 300 }, width: 50, height: 50 },
      { id: "skip-1", kind: 'node', position: { x: 20, y: 20 }, width: undefined, height: 40 },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual(["hit-1", "hit-2"]);
  });

  it("does not hit when marquee rect has zero area", () => {
    const rect: MarqueeRect = { x1: 50, y1: 50, x2: 50, y2: 50 };
    const targets: MarqueeHitTarget[] = [
      { id: "node-1", kind: 'node', position: { x: 0, y: 0 }, width: 100, height: 100 },
    ];
    const result = marqueeHitTest(rect, targets);
    expect(result.nodeIds).toEqual([]);
  });

  describe("annotation 维度命中", () => {
    it("自由注释：框选与注释包围盒相交时命中", () => {
      const rect: MarqueeRect = { x1: 0, y1: 0, x2: 200, y2: 200 };
      const targets: MarqueeHitTarget[] = [
        { id: "ann-1", kind: 'annotation', position: { x: 50, y: 50 }, width: 100, height: 60 },
      ];
      const result = marqueeHitTest(rect, targets);
      expect(result.annotationIds).toEqual(["ann-1"]);
      expect(result.nodeIds).toEqual([]);
    });

    it("绑定注释：按派生位置（已由调用方解析后传入）参与判定", () => {
      // 派生位置 = 节点底部 + gap，由调用方经 resolveAnnotationPosition + resolveEffectiveSize 解析
      // 这里直接传入已解析的派生位置，验证 marqueeHitTest 的几何判定
      const rect: MarqueeRect = { x1: 0, y1: 100, x2: 300, y2: 300 };
      const targets: MarqueeHitTarget[] = [
        { id: "ann-bound", kind: 'annotation', position: { x: 100, y: 150 }, width: 200, height: 60 },
      ];
      const result = marqueeHitTest(rect, targets);
      expect(result.annotationIds).toEqual(["ann-bound"]);
    });

    it("未相交的注释不命中", () => {
      const rect: MarqueeRect = { x1: 0, y1: 0, x2: 100, y2: 100 };
      const targets: MarqueeHitTarget[] = [
        { id: "ann-far", kind: 'annotation', position: { x: 500, y: 500 }, width: 200, height: 60 },
      ];
      const result = marqueeHitTest(rect, targets);
      expect(result.annotationIds).toEqual([]);
    });

    it("节点与注释混选：返回各自的命中集合", () => {
      const rect: MarqueeRect = { x1: 0, y1: 0, x2: 300, y2: 300 };
      const targets: MarqueeHitTarget[] = [
        { id: "node-1", kind: 'node', position: { x: 10, y: 10 }, width: 80, height: 50 },
        { id: "ann-1", kind: 'annotation', position: { x: 100, y: 100 }, width: 200, height: 60 },
        { id: "node-2", kind: 'node', position: { x: 500, y: 500 }, width: 80, height: 50 },
      ];
      const result = marqueeHitTest(rect, targets);
      expect(result.nodeIds).toEqual(["node-1"]);
      expect(result.annotationIds).toEqual(["ann-1"]);
    });
  });
});
