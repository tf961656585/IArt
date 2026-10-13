import { describe, expect, it } from "vitest";

import {
  AUDIO_AREA_HEIGHT,
  AUDIO_CONTENT_GAP_Y,
  AUDIO_EDIT_BUTTON_HEIGHT,
  AUDIO_MIN_WIDTH,
  SEGMENT_GAP_Y,
  SEGMENT_HEADER_HEIGHT,
  SEGMENT_LIST_MARGIN_TOP,
  SEGMENT_ROW_HEIGHT,
  computeAudioInputSize,
} from "../audioInputSizePolicy";
import type { ChromeOverhead } from "../chromeConstants";

/**
 * 音频输入节点尺寸策略单元测试（Layout Model 唯一口径）。
 *
 * spec: docs/runtime/画布节点尺寸管理架构.md「节点尺寸策略分类」audioInput 行
 * （分段全量渲染不做内部滚动，高度由 Layout Model 按 AUDIO_AREA_HEIGHT 与分段行高派生）。
 *
 * 这些用例锚定本策略函数的公式与常量数值，是渲染层删除分段列表 max-h 滚动封顶后的保护网：
 * 任何对公式或常量数值的回归改动都会让对应用例变红。
 *
 * chrome 默认取 CHROME_CONSTANTS_TABLE.audioInput 真实值 {26, 26}
 * （ContentNodeCard border 1px each side + p-3 padding 12/12）。
 */
const AUDIO_CHROME: ChromeOverhead = { overheadX: 26, overheadY: 26 };

/** 分段列表块高度：SEGMENT_LIST_MARGIN_TOP + HEADER + N*ROW + max(0,N-1)*GAP */
const segmentListHeight = (count: number): number =>
  SEGMENT_LIST_MARGIN_TOP +
  SEGMENT_HEADER_HEIGHT +
  count * SEGMENT_ROW_HEIGHT +
  Math.max(0, count - 1) * SEGMENT_GAP_Y;

describe("computeAudioInputSize / 音频输入节点尺寸策略", () => {
  describe("常量", () => {
    it("常量均为非负且关键高度为正", () => {
      expect(AUDIO_AREA_HEIGHT).toBeGreaterThan(0);
      expect(AUDIO_MIN_WIDTH).toBeGreaterThan(0);
      expect(SEGMENT_HEADER_HEIGHT).toBeGreaterThan(0);
      expect(SEGMENT_ROW_HEIGHT).toBeGreaterThan(0);
      expect(SEGMENT_GAP_Y).toBeGreaterThanOrEqual(0);
      expect(SEGMENT_LIST_MARGIN_TOP).toBeGreaterThanOrEqual(0);
      expect(AUDIO_EDIT_BUTTON_HEIGHT).toBeGreaterThan(0);
      expect(AUDIO_CONTENT_GAP_Y).toBeGreaterThanOrEqual(0);
    });

    it("AUDIO_CONTENT_GAP_Y 对齐 ContentNodeCard 内容区 gap-2 = 8", () => {
      // ContentNodeCard.tsx:383 `flex flex-col gap-2` → gap: 0.5rem = 8px
      expect(AUDIO_CONTENT_GAP_Y).toBe(8);
    });
  });

  describe("高度：基础结构", () => {
    it("0 段 + segmentModeEnabled=false + 无 audioUrl → chrome + AUDIO_AREA_HEIGHT", () => {
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: false,
        segmentsCount: 0,
        hasAudioUrl: false,
      });
      expect(result.height).toBe(AUDIO_CHROME.overheadY + AUDIO_AREA_HEIGHT);
      expect(result.height).toBe(90);
    });

    it("0 段 + 有 audioUrl → chrome + 音频区 + 编辑按钮高度 + 1 gap（偏大方向恒含）", () => {
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: false,
        segmentsCount: 0,
        hasAudioUrl: true,
      });
      expect(result.height).toBe(
        AUDIO_CHROME.overheadY +
          AUDIO_AREA_HEIGHT +
          AUDIO_EDIT_BUTTON_HEIGHT +
          AUDIO_CONTENT_GAP_Y,
      );
      expect(result.height).toBe(134);
    });

    it("有分段但 segmentModeEnabled=false → 不渲染分段列表（与渲染条件一致）", () => {
      const off = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: false,
        segmentsCount: 5,
        hasAudioUrl: true,
      });
      const zero = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: false,
        segmentsCount: 0,
        hasAudioUrl: true,
      });
      expect(off).toEqual(zero);
    });
  });

  describe("高度：分段列表按分段数线性派生", () => {
    it("N 段 + segmentModeEnabled=true + 有 audioUrl → chrome + 音频区 + 分段块 + 编辑按钮 + 2 gap", () => {
      const N = 3;
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: N,
        hasAudioUrl: true,
      });
      expect(result.height).toBe(
        AUDIO_CHROME.overheadY +
          AUDIO_AREA_HEIGHT +
          segmentListHeight(N) +
          AUDIO_EDIT_BUTTON_HEIGHT +
          2 * AUDIO_CONTENT_GAP_Y,
      );
      // 26 + 64 + (8+20+60+4) + 36 + 2*8
      expect(result.height).toBe(234);
    });

    it("N 段无 audioUrl → 不含编辑按钮高度，含 1 gap（音频-SegmentList）", () => {
      const N = 2;
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: N,
        hasAudioUrl: false,
      });
      expect(result.height).toBe(
        AUDIO_CHROME.overheadY +
          AUDIO_AREA_HEIGHT +
          segmentListHeight(N) +
          AUDIO_CONTENT_GAP_Y,
      );
      // 26 + 64 + (8+20+40+2) + 8
      expect(result.height).toBe(168);
    });

    it("分段数 +1 → 高度增加恰好 SEGMENT_ROW_HEIGHT + SEGMENT_GAP_Y（逐段线性）", () => {
      const base = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: 2,
        hasAudioUrl: true,
      });
      const next = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: 3,
        hasAudioUrl: true,
      });
      expect(next.height - base.height).toBe(SEGMENT_ROW_HEIGHT + SEGMENT_GAP_Y);
    });

    it("非正 / 非有限分段数按 0 处理", () => {
      const zero = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: 0,
        hasAudioUrl: true,
      });
      for (const bad of [NaN, Infinity, -3]) {
        const result = computeAudioInputSize({
          chrome: AUDIO_CHROME,
          segmentModeEnabled: true,
          segmentsCount: bad,
          hasAudioUrl: true,
        });
        expect(result).toEqual(zero);
      }
    });
  });

  describe("高度：内容块间 gap 计入（方向锁定，只许偏大不许偏小）", () => {
    it("gap 计入：多块场景 height ≥ chrome + 各块之和 + 各条件块引入的 gap（偏大方向硬要求）", () => {
      const N = 2;
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: N,
        hasAudioUrl: true,
      });
      const blocksSum = AUDIO_AREA_HEIGHT + segmentListHeight(N) + AUDIO_EDIT_BUTTON_HEIGHT;
      // 分段列表与编辑按钮各引入 1 个与前一 block 的 gap（音频区恒在）
      const expectedGapHeight = 2 * AUDIO_CONTENT_GAP_Y;
      expect(result.height).toBe(AUDIO_CHROME.overheadY + blocksSum + expectedGapHeight);
      // 方向不变量：含 gap 的估算不得小于各块之和（缺口会被 gap 撑大）
      expect(result.height).toBeGreaterThanOrEqual(AUDIO_CHROME.overheadY + blocksSum);
      expect(result.height).toBeGreaterThanOrEqual(
        AUDIO_CHROME.overheadY + blocksSum + expectedGapHeight,
      );
    });

    it("无分段有 URL → 1 gap（音频区-编辑按钮），flex gap 与块内 mt-2 叠加", () => {
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: 0,
        hasAudioUrl: true,
      });
      // 编辑按钮自带 mt-2（已含在 AUDIO_EDIT_BUTTON_HEIGHT=36），容器 gap-2 另计 8
      expect(result.height).toBe(
        AUDIO_CHROME.overheadY + AUDIO_AREA_HEIGHT + AUDIO_EDIT_BUTTON_HEIGHT + AUDIO_CONTENT_GAP_Y,
      );
    });

    it("有分段无 URL → 1 gap（音频区-SegmentList）", () => {
      const N = 1;
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: N,
        hasAudioUrl: false,
      });
      expect(result.height).toBe(
        AUDIO_CHROME.overheadY + AUDIO_AREA_HEIGHT + segmentListHeight(N) + AUDIO_CONTENT_GAP_Y,
      );
    });

    it("有分段有 URL → 2 gap（音频-SegmentList、SegmentList-按钮），gap 数量 = 渲染块数 - 1", () => {
      const N = 2;
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: N,
        hasAudioUrl: true,
      });
      expect(result.height).toBe(
        AUDIO_CHROME.overheadY +
          AUDIO_AREA_HEIGHT +
          segmentListHeight(N) +
          AUDIO_EDIT_BUTTON_HEIGHT +
          2 * AUDIO_CONTENT_GAP_Y,
      );
    });
  });

  describe("宽度下限", () => {
    it("chrome.overheadX + 内容最小宽 低于 AUDIO_MIN_WIDTH 时取 AUDIO_MIN_WIDTH", () => {
      const result = computeAudioInputSize({
        chrome: AUDIO_CHROME, // overheadX=26
        segmentModeEnabled: false,
        segmentsCount: 0,
        hasAudioUrl: false,
      });
      expect(result.width).toBe(AUDIO_MIN_WIDTH);
      expect(result.width).toBe(200);
    });

    it("chrome.overheadX 超过 AUDIO_MIN_WIDTH 时宽度跟随 chrome（max 语义）", () => {
      const result = computeAudioInputSize({
        chrome: { overheadX: 300, overheadY: 26 },
        segmentModeEnabled: false,
        segmentsCount: 0,
        hasAudioUrl: false,
      });
      expect(result.width).toBe(300);
    });
  });

  describe("纯函数性", () => {
    it("相同输入两次调用结果 deep equal", () => {
      const input = {
        chrome: AUDIO_CHROME,
        segmentModeEnabled: true,
        segmentsCount: 4,
        hasAudioUrl: true,
      };
      const a = computeAudioInputSize(input);
      const b = computeAudioInputSize(input);
      expect(a).toEqual(b);
    });
  });
});
