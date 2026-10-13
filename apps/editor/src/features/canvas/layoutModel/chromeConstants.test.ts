import { describe, expect, it } from "vitest";

import {
  CHROME_CONSTANTS_TABLE,
  DEFAULT_CHROME_OVERHEAD,
  resolveChromeOverhead,
} from "./chromeConstants";

describe("chromeConstants / resolveChromeOverhead", () => {
  describe("纯函数性", () => {
    it("相同输入产出相同输出（多次调用结果 deep equal）", () => {
      const a = resolveChromeOverhead("model", undefined);
      const b = resolveChromeOverhead("model", undefined);
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // 不同调用产出新对象字面量
    });

    it("每种节点类型查表结果稳定", () => {
      const nodeTypes = [
        "model",
        "imageInput",
        "videoInput",
        "textInput",
        "audioInput",
        "group",
      ] as const;
      for (const nodeType of nodeTypes) {
        const first = resolveChromeOverhead(nodeType, undefined);
        const second = resolveChromeOverhead(nodeType, undefined);
        expect(first).toEqual(second);
      }
    });
  });

  describe("常数表覆盖全部节点类型", () => {
    it("model 节点：18 / 54（迁移自 DEFAULT_CHROME_OVERHEAD_X/Y）", () => {
      const result = resolveChromeOverhead("model", undefined);
      expect(result.overheadX).toBe(18);
      expect(result.overheadY).toBe(54);
    });

    it("imageInput / videoInput：0 / 0（noPadding 媒体卡片 fill 模式，无 chrome overhead）", () => {
      expect(resolveChromeOverhead("imageInput", undefined)).toEqual({
        overheadX: 0,
        overheadY: 0,
      });
      expect(resolveChromeOverhead("videoInput", undefined)).toEqual({
        overheadX: 0,
        overheadY: 0,
      });
    });

    it("textInput（static，不消费 chrome）：16 / 32（死值保留）", () => {
      expect(resolveChromeOverhead("textInput", undefined)).toEqual({
        overheadX: 16,
        overheadY: 32,
      });
    });

    it("audioInput（layoutModel）：26 / 26（ContentNodeCard border 1px each side + p-3 padding 12/12）", () => {
      expect(resolveChromeOverhead("audioInput", undefined)).toEqual({
        overheadX: 26,
        overheadY: 26,
      });
    });

    it("group 节点在表中（占位 0/0；computeLayoutModel 不通过 chromeConstants 查 group）", () => {
      expect(CHROME_CONSTANTS_TABLE.group).toEqual({
        overheadX: 0,
        overheadY: 0,
      });
    });

    it("DEFAULT_CHROME_OVERHEAD 兜底档存在且为静态节点值", () => {
      expect(DEFAULT_CHROME_OVERHEAD).toEqual({ overheadX: 16, overheadY: 32 });
    });
  });

  describe("variant 参数预留扩展点", () => {
    it("传入 variant 不影响当前查表结果（未按 variant 分档）", () => {
      const noVariant = resolveChromeOverhead("model", undefined);
      const withVariant = resolveChromeOverhead("model", "embedded");
      expect(noVariant).toEqual(withVariant);
    });
  });
});
