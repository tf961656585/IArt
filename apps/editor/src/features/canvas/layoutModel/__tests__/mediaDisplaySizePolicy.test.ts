import { describe, expect, it } from "vitest";

import {
  MAX_DISPLAY_DIMENSION,
  MIN_WIDTH,
  computeMediaDisplaySize,
} from "../mediaDisplaySizePolicy";

/**
 * 媒体展示尺寸策略单元测试（Layout Model 唯一口径）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md「媒体尺寸层」
 *
 * 这些用例锚定本策略函数的钳制语义，是渲染层删除 CSS clamp 后的保护网：
 * 任何对公式或常量数值的回归改动都会让对应用例变红。
 *
 * 默认宽高比取自 ImageNodeSurface.DEFAULT_IMAGE_ASPECT_RATIO = 3/2（image）、
 * video 默认 16/9。本测试直接用字面量避免跨模块耦合。
 */
const DEFAULT_IMAGE_ASPECT_RATIO = 3 / 2;
const DEFAULT_VIDEO_ASPECT_RATIO = 16 / 9;

describe("computeMediaDisplaySize / 媒体展示尺寸策略", () => {
  describe("常量", () => {
    it("MIN_WIDTH 与 MAX_DISPLAY_DIMENSION 为正数且上限不小于下限", () => {
      expect(MIN_WIDTH).toBeGreaterThan(0);
      expect(MAX_DISPLAY_DIMENSION).toBeGreaterThanOrEqual(MIN_WIDTH);
    });
  });

  describe("null / 缺失 meta", () => {
    it("meta === null 返回 null（调用方回落 defaultSize）", () => {
      expect(computeMediaDisplaySize(null, DEFAULT_IMAGE_ASPECT_RATIO)).toBeNull();
    });

    it("meta === undefined 返回 null", () => {
      expect(computeMediaDisplaySize(undefined, DEFAULT_IMAGE_ASPECT_RATIO)).toBeNull();
    });

    it("meta.width 或 meta.height 为 0 返回 null", () => {
      expect(
        computeMediaDisplaySize(
          { width: 0, height: 100, aspectRatio: 0.5 },
          DEFAULT_IMAGE_ASPECT_RATIO,
        ),
      ).toBeNull();
      expect(
        computeMediaDisplaySize(
          { width: 100, height: 0, aspectRatio: 0.5 },
          DEFAULT_IMAGE_ASPECT_RATIO,
        ),
      ).toBeNull();
    });
  });

  describe("钳制语义", () => {
    it("横图 1774×887 (aspect 2) → 320×160（长边命中 MAX_DISPLAY_DIMENSION）", () => {
      // bug 样本同期场景：原 desired producer 公式产出该结果，统一后布局模型应输出同值 + chrome{0,0}。
      const result = computeMediaDisplaySize(
        { width: 1774, height: 887, aspectRatio: 2 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 320, height: 160 });
    });

    it("横图 1774×887 不传 aspectRatio 时用 width/height 推导，结果一致", () => {
      const result = computeMediaDisplaySize(
        { width: 1774, height: 887, aspectRatio: 0 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 320, height: 160 });
    });

    it("竖图 3972×6356 (aspect ≈0.6249) → 200×320（bug 样本回验）", () => {
      // bug 样本：旧布局模型无钳制公式对同输入算出 256×424，wrapper 与 CSS-clamp 卡片分裂。
      // 新策略函数保证宽高均 ≤ MAX_DISPLAY_DIMENSION，handle 与卡片对齐。
      const result = computeMediaDisplaySize(
        { width: 3972, height: 6356, aspectRatio: 3972 / 6356 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 200, height: 320 });
      // 显式断言上限约束（防回归）
      expect(result?.width).toBeLessThanOrEqual(MAX_DISPLAY_DIMENSION);
      expect(result?.height).toBeLessThanOrEqual(MAX_DISPLAY_DIMENSION);
    });

    it("小尺寸图 150×200 (aspect 0.75) → 180×240（MIN_WIDTH 下限抬升生效）", () => {
      // fitted.width=150 < MIN_WIDTH=180；抬升后 desiredHeight=180/0.75=240 ≤ 320 → MIN_WIDTH 生效
      const result = computeMediaDisplaySize(
        { width: 150, height: 200, aspectRatio: 150 / 200 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 180, height: 240 });
    });

    it("超极端竖图 100×300 (aspect ≈0.333) → 100×300（上限优先于 MIN_WIDTH）", () => {
      // fitted.width=100 < MIN_WIDTH，但抬升到 180 后高度 540 > 320 → withinBounds=false
      // → 退回 fitted 结果，保上限优先
      const result = computeMediaDisplaySize(
        { width: 100, height: 300, aspectRatio: 100 / 300 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 100, height: 300 });
      expect(result?.height).toBeLessThanOrEqual(MAX_DISPLAY_DIMENSION);
    });

    it("方图 320×320 (aspect 1) → 320×320（恰好等于上限，withinBounds）", () => {
      const result = computeMediaDisplaySize(
        { width: 320, height: 320, aspectRatio: 1 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 320, height: 320 });
    });

    it("小方图 100×100 (aspect 1) → 180×180（MIN_WIDTH 抬升，高度未超上限）", () => {
      const result = computeMediaDisplaySize(
        { width: 100, height: 100, aspectRatio: 1 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 180, height: 180 });
    });

    it("aspectRatio 缺失/非法时优先用 width/height 推导（defaultAspectRatio 仅在 width/height 也失效时兜底，但该路径已被 null guard 拦截）", () => {
      // 实现：meta.aspectRatio || meta.width / meta.height || defaultAspectRatio
      // 传入 aspectRatio=0 → 0 falsy → 走 width/height → 800/800=1（不是 defaultAspectRatio）
      // fitted={320,320}; desiredWidth=320, desiredHeight=320/1=320 → {320, 320}
      const result = computeMediaDisplaySize(
        { width: 800, height: 800, aspectRatio: 0 },
        DEFAULT_IMAGE_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 320, height: 320 });
    });
  });

  describe("video 默认宽高比", () => {
    it("横视频 1920×1080 (aspect 16/9) → 320×180", () => {
      const result = computeMediaDisplaySize(
        { width: 1920, height: 1080, aspectRatio: 16 / 9 },
        DEFAULT_VIDEO_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 320, height: 180 });
    });

    it("竖视频 1080×1920 (aspect 9/16) → 180×320", () => {
      // fitted(1080,1920,320) ratio=min(0.296, 0.1667)=0.1667 → {180, 320}
      // desiredWidth=max(180,180)=180, desiredHeight=180/(9/16)=320 → withinBounds → {180, 320}
      const result = computeMediaDisplaySize(
        { width: 1080, height: 1920, aspectRatio: 9 / 16 },
        DEFAULT_VIDEO_ASPECT_RATIO,
      );
      expect(result).toEqual({ width: 180, height: 320 });
    });
  });

  describe("纯函数性", () => {
    it("相同输入两次调用结果 deep equal", () => {
      const meta = { width: 1774, height: 887, aspectRatio: 2 };
      const a = computeMediaDisplaySize(meta, DEFAULT_IMAGE_ASPECT_RATIO);
      const b = computeMediaDisplaySize(meta, DEFAULT_IMAGE_ASPECT_RATIO);
      expect(a).toEqual(b);
    });
  });
});
