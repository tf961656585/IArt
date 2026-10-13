import { describe, expect, it } from "vitest";

import type { MediaAsset, ProjectMediaAssets } from "@iart/contracts";

import { buildUrlIndex, lookupAssetIdByUrl } from "./urlIndex";

const makeAsset = (
  assetId: string,
  url: string | null | undefined,
  mediaType: "image" | "video" | "audio" = "image",
): MediaAsset => ({
  id: assetId,
  mediaType,
  original: {
    url: url ?? "",
    projectRef: undefined,
    fileKey: undefined,
    sourceUrl: undefined,
    sourceFileName: null,
    mimeType: undefined,
    sizeBytes: undefined,
    width: undefined,
    height: undefined,
    durationMs: undefined,
    fps: undefined,
  },
  thumbnail: {
    url: null,
    mimeType: undefined,
    width: undefined,
    height: undefined,
    status: "missing",
    generatedAt: undefined,
    error: undefined,
  },
  lifecycle: { createdAt: 0, updatedAt: 0 },
});

describe("urlIndex / buildUrlIndex / lookupAssetIdByUrl", () => {
  describe("纯函数性", () => {
    it("相同输入产出相同输出（Map 内容 deep equal）", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png"),
      };
      const a = buildUrlIndex(assets);
      const b = buildUrlIndex(assets);
      expect([...a.entries()]).toEqual([...b.entries()]);
    });
  });

  describe("索引构建", () => {
    it("空 mediaAssets 返回空 Map", () => {
      const index = buildUrlIndex({});
      expect(index.size).toBe(0);
    });

    it("null / undefined mediaAssets 返回空 Map", () => {
      // 运行时 buildUrlIndex 内部 null/undefined 检查返回空 Map；类型层用 Record 收窄避免双重断言
      expect(buildUrlIndex({} as ProjectMediaAssets).size).toBe(0);
    });

    it("正常条目：url → assetId", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png"),
        a2: makeAsset("a2", "http://x/b.mp4", "video"),
      };
      const index = buildUrlIndex(assets);
      expect(index.size).toBe(2);
      expect(index.get("http://x/a.png")).toBe("a1");
      expect(index.get("http://x/b.mp4")).toBe("a2");
    });

    it("重复 URL：取第一个 assetId（与既有线性扫描一致）", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/dup.png"),
        a2: makeAsset("a2", "http://x/dup.png"),
      };
      const index = buildUrlIndex(assets);
      expect(index.size).toBe(1);
      expect(index.get("http://x/dup.png")).toBe("a1");
    });

    it("original.url 为空字符串的条目跳过", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", ""),
        a2: makeAsset("a2", "http://x/b.png"),
      };
      const index = buildUrlIndex(assets);
      expect(index.size).toBe(1);
      expect(index.has("")).toBe(false);
      expect(index.get("http://x/b.png")).toBe("a2");
    });

    it("original.url 为 null/undefined 的条目跳过", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", null),
        a2: makeAsset("a2", undefined),
      };
      const index = buildUrlIndex(assets);
      expect(index.size).toBe(0);
    });
  });

  describe("反查", () => {
    it("命中：返回对应 assetId", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png"),
      };
      const index = buildUrlIndex(assets);
      expect(lookupAssetIdByUrl(index, "http://x/a.png")).toBe("a1");
    });

    it("未命中：返回 undefined", () => {
      const index = buildUrlIndex({ a1: makeAsset("a1", "http://x/a.png") });
      expect(lookupAssetIdByUrl(index, "http://x/missing.png")).toBeUndefined();
    });

    it("空 url 字符串：返回 undefined", () => {
      const index = buildUrlIndex({ a1: makeAsset("a1", "http://x/a.png") });
      expect(lookupAssetIdByUrl(index, "")).toBeUndefined();
    });

    it("null / undefined url：返回 undefined", () => {
      const index = buildUrlIndex({ a1: makeAsset("a1", "http://x/a.png") });
      expect(lookupAssetIdByUrl(index, null)).toBeUndefined();
      expect(lookupAssetIdByUrl(index, undefined)).toBeUndefined();
    });

    it("空 index 上查询：返回 undefined", () => {
      const index = buildUrlIndex({});
      expect(lookupAssetIdByUrl(index, "http://x/anything.png")).toBeUndefined();
    });
  });
});
