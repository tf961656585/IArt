import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeMediaInput,
  resolveAllMediaItems,
  isUploadFileItem,
  type NormalizedMediaItem,
} from "../mediaDataContract";

vi.mock("@/client/utils/hubFetch", () => ({
  fetchBlobWithHub: vi.fn(),
}));

const must = <T,>(value: T | null | undefined): T => {
  if (value == null) throw new Error("expected value");
  return value;
};

describe("媒体数据契约", () => {
  const createObjectURLMock = vi.fn(() => "blob:mock-url");

  describe("isUploadFileItem", () => {
    it("应识别包含 file 的对象", () => {
      expect(isUploadFileItem({ file: new Blob() })).toBe(true);
    });

    it("应识别包含 src 的对象", () => {
      expect(isUploadFileItem({ src: "https://example.com/image.png" })).toBe(true);
    });

    it("应拒绝无效的对象", () => {
      expect(isUploadFileItem(null)).toBe(false);
      expect(isUploadFileItem(undefined)).toBe(false);
      expect(isUploadFileItem("string")).toBe(false);
      expect(isUploadFileItem([])).toBe(false);
    });

    it("应忽略仅包含 cacheRef 的旧数据", () => {
      expect(isUploadFileItem({ cacheRef: { cacheId: "abc", status: "cached" } })).toBe(
        false
      );
    });
  });

  describe("normalizeMediaInput", () => {
    it("应规范化 URL 字符串", () => {
      const result = normalizeMediaInput("https://example.com/image.png", undefined);
      expect(result).toHaveLength(1);
      expect(must(result.at(0)).source.type).toBe("url");
    });

    it("应规范化 File 对象", () => {
      const file = new File(["test"], "test.png", { type: "image/png" });
      const result = normalizeMediaInput(file, undefined);
      expect(result).toHaveLength(1);
      expect(must(result.at(0)).source.type).toBe("file");
    });

    it("应规范化 Blob 对象", () => {
      const blob = new Blob(["test"], { type: "image/png" });
      const result = normalizeMediaInput(blob, undefined);
      expect(result).toHaveLength(1);
      expect(must(result.at(0)).source.type).toBe("file");
    });

    it("应规范化 UploadFileItem 数组", () => {
      const items = [
        { id: "1", file: new Blob() },
        { id: "2", src: "https://example.com/image.png" },
      ];
      const result = normalizeMediaInput(items, undefined);
      expect(result).toHaveLength(2);
      expect(must(result.at(0)).source.type).toBe("file");
      expect(must(result.at(1)).source.type).toBe("url");
    });

    it("应尊重 maxItems 限制", () => {
      const items = ["url1", "url2", "url3"];
      const result = normalizeMediaInput(items, 2);
      expect(result).toHaveLength(2);
    });

    it("应忽略空字符串", () => {
      const result = normalizeMediaInput("", undefined);
      expect(result).toHaveLength(0);
    });
  });

  describe("resolveAllMediaItems", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      (globalThis.URL as { createObjectURL?: unknown }).createObjectURL = createObjectURLMock;
    });

    it("应解析 file 类型", async () => {
      const blob = new Blob(["test"], { type: "image/png" });
      const items: NormalizedMediaItem[] = [
        { id: "1", source: { type: "file", file: blob } },
      ];
      const result = await resolveAllMediaItems(items, undefined);
      expect(result).toHaveLength(1);
      expect(must(result.at(0)).file).toBe(blob);
      expect(must(result.at(0)).mimeType).toBe("image/png");
    });

    it("应解析 url 类型（不下载）", async () => {
      const items: NormalizedMediaItem[] = [
        { id: "1", source: { type: "url", url: "https://example.com/image.png" } },
      ];
      const result = await resolveAllMediaItems(items, undefined);
      expect(result).toHaveLength(1);
      expect(must(result.at(0)).url).toBe("https://example.com/image.png");
      expect(must(result.at(0)).file).toBeUndefined();
    });
    it("应支持下载 url 为 Blob", async () => {
      const { fetchBlobWithHub } = await import("@/client/utils/hubFetch");
      const mockBlob = new Blob(["downloaded"], { type: "image/png" });
      (fetchBlobWithHub as ReturnType<typeof vi.fn>).mockResolvedValue({
        blob: mockBlob,
        mimeType: "image/png",
      });

      const items: NormalizedMediaItem[] = [
        { id: "1", source: { type: "url", url: "https://example.com/image.png" } },
      ];
      const result = await resolveAllMediaItems(items, { downloadUrls: true, concurrency: undefined });
      expect(result).toHaveLength(1);
      expect(must(result.at(0)).file).toBe(mockBlob);
      expect(must(result.at(0)).mimeType).toBe("image/png");
    });
  });
});
