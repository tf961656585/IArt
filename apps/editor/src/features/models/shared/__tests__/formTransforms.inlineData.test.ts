import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { filesToInlineDataList, filesToInlineDataListWithMeta } from "@/features/models/shared/formTransforms";

declare global {
  interface Window {
    __IART_LOCAL_API_BASE__: string | undefined;
  }
}

type InlineData = { mime_type: string; data: string };

const getAt = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(`Expected item at index ${index}`);
  }
  return value;
};

const createFile = (name: string, content = "dummy", type = "image/png"): File => {
  return new File([content], name, { type });
};

describe("filesToInlineDataList", () => {
  const originalFileReader = globalThis.FileReader;
  const originalFetch = globalThis.fetch;

  const setupFileReaderSuccess = (dataUrl: string) => {
    class MockFileReader {
      public result: string | ArrayBuffer | null = null;
      public onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
      public onerror: ((ev: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL(_file: Blob) {
        this.result = dataUrl;
        this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
      }
    }

    globalThis.FileReader = MockFileReader as typeof FileReader;
  };

  const setupFetchSuccess = (blobType: string, blobContent = "image-data") => {
    const mockBlob = new Blob([blobContent], { type: blobType });
    const headers = new Headers({ "content-type": blobType });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers,
      blob: () => Promise.resolve(mockBlob),
    });
  };

  const setupFetchFailure = (status = 404) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
    });
  };

  const setupFetchNetworkError = () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.FileReader = originalFileReader;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("空数组返回空结果", async () => {
    const result = await filesToInlineDataList([], undefined);
    expect(result).toEqual([]);
  });

  it("有 file 对象时使用 FileReader 读取", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);

    const file = createFile("test.png", "image-data", "image/png");
    const items = [{ id: "1", file }];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(1);
    expect(getAt(result, 0).mime_type).toBe("image/png");
    expect(getAt(result, 0).data).toBe(base64);
  });

  it("无 file 但有 src URL 时 fetch 并转 base64", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:image/jpeg;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);
    setupFetchSuccess("image/jpeg");

    const items = [{ id: "1", src: "https://example.com/image.jpg" }];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(1);
    expect(getAt(result, 0).mime_type).toBe("image/jpeg");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/image.jpg",
      expect.any(Object)
    );
  });

  it("混合输入：部分有 file 部分只有 src", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);
    setupFetchSuccess("image/webp");

    const file = createFile("local.png", "image-data", "image/png");
    const items = [
      { id: "1", file },
      { id: "2", src: "https://example.com/remote.webp" },
    ];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(2);
    expect(getAt(result, 0).mime_type).toBe("image/png");
    expect(getAt(result, 1).mime_type).toBe("image/webp");
  });

  it("fetch 失败时 fail fast", async () => {
    setupFetchFailure(404);

    const items = [{ id: "1", src: "https://example.com/missing.png" }];

    await expect(filesToInlineDataList(items, undefined)).rejects.toThrow(
      "素材下载失败，请检查网络后重试"
    );
  });

  it("filesToInlineDataListWithMeta：下载失败时返回结构化 errors", async () => {
    setupFetchFailure(404);

    const result = await filesToInlineDataListWithMeta([
      { id: "1", src: "https://example.com/missing.png" },
    ], undefined);

    expect(result.inlineDataList).toHaveLength(0);
    expect(result.attachmentMetas).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(getAt(result.errors, 0).code).toBe("MEDIA_URL_HTTP_ERROR");
    expect(getAt(result.errors, 0).url).toBe("https://example.com/missing.png");
  });

  it("filesToInlineDataListWithMeta：File 输入返回 attachmentMetas", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);

    const file = createFile("test.png", "image-data", "image/png");
    const items = [{ id: "1", file }];

    const result = await filesToInlineDataListWithMeta(items, undefined);

    expect(result.inlineDataList).toHaveLength(1);
    expect(getAt(result.inlineDataList, 0).mime_type).toBe("image/png");
    expect(getAt(result.inlineDataList, 0).data).toBe(base64);
    expect(result.attachmentMetas).toHaveLength(1);
    expect(getAt(result.attachmentMetas, 0).sourceKind).toBe("file");
    expect(typeof getAt(result.attachmentMetas, 0).sizeBytes).toBe("number");
  });

  it("fetch 网络错误时 fail fast", async () => {
    setupFetchNetworkError();

    const items = [{ id: "1", src: "https://example.com/network-error.png" }];

    await expect(filesToInlineDataList(items, undefined)).rejects.toThrow(
      "素材下载失败，请检查网络后重试"
    );
  });

  it("limit 参数限制结果数量", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);

    const items = [
      { id: "1", file: createFile("1.png") },
      { id: "2", file: createFile("2.png") },
      { id: "3", file: createFile("3.png") },
    ];

    const result = await filesToInlineDataList(items, { limit: 2 });

    expect(result).toHaveLength(2);
  });

  it("data URL 输入直接解析为 inline_data 且不触发 fetch", async () => {
    const base64 = "bG9jYWwtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${base64}`;
    globalThis.fetch = vi.fn();

    const result = await filesToInlineDataList(dataUrl, undefined);

    expect(result).toEqual([{ mime_type: "image/png", data: base64 }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("裸 base64 字符串被识别为 inline_data 并跳过 fetch", async () => {
    const base64 = "aW1hZ2UtaW5saW5lLWRhdGEtdGVzdA==";
    globalThis.fetch = vi.fn();

    const result = await filesToInlineDataList(base64, undefined);

    expect(result).toEqual([{ mime_type: "application/octet-stream", data: base64 }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("JPEG 裸 base64 字符串会自动推断 mime_type 为 image/jpeg", async () => {
    const jpegBase64 = "/9j/4AAQSkZJRgABAQ==";
    globalThis.fetch = vi.fn();

    const result = await filesToInlineDataList(jpegBase64, undefined);

    expect(result).toEqual([{ mime_type: "image/jpeg", data: jpegBase64 }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("混合 data URL 与远程 URL 时仅远程项触发 fetch", async () => {
    const dataUrlBase64 = "bG9jYWwtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${dataUrlBase64}`;
    const remoteBase64 = "cmVtb3RlLWRhdGE=";
    const remoteDataUrl = `data:image/jpeg;base64,${remoteBase64}`;
    setupFileReaderSuccess(remoteDataUrl);
    setupFetchSuccess("image/jpeg");

    const result = await filesToInlineDataList([dataUrl, "https://example.com/photo.jpg"], undefined);

    expect(result).toHaveLength(2);
    expect(getAt(result, 0)).toEqual({ mime_type: "image/png", data: dataUrlBase64 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/photo.jpg",
      expect.any(Object)
    );
  });

  it("已含 inline_data 结构的输入直接透传", async () => {
    globalThis.fetch = vi.fn();
    const inlineItem = { inline_data: { mime_type: "image/png", data: "YWJj" } };

    const result = await filesToInlineDataList([inlineItem], undefined);

    expect(result).toEqual([{ mime_type: "image/png", data: "YWJj" }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("单个 inline_data 对象输入被接受", async () => {
    globalThis.fetch = vi.fn();
    const inlineData: InlineData = { mime_type: "image/jpeg", data: "ZGF0YQ==" };

    const result = await filesToInlineDataList(inlineData, undefined);

    expect(result).toEqual([inlineData]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("遗留 blob: URL 返回业务化错误（图片已失效）", async () => {
    globalThis.fetch = vi.fn();
    const items = [{ id: "1", src: "blob:https://example.com/uuid-1234" }];

    const result = await filesToInlineDataListWithMeta(items, undefined);

    expect(result.inlineDataList).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(getAt(result.errors, 0).code).toBe("MEDIA_SESSION_URL_INVALID");
    expect(getAt(result.errors, 0).message).toContain("这张图片已经失效");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("从 URL 扩展名推断 MIME 类型（当 blob.type 为空时）", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);
    // 模拟 blob.type 为空
    const mockBlob = new Blob(["image-data"]);
    Object.defineProperty(mockBlob, "type", { value: "" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: () => Promise.resolve(mockBlob),
    });

    const items = [{ id: "1", src: "https://example.com/photo.jpeg" }];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(1);
    expect(getAt(result, 0).mime_type).toBe("image/jpeg");
  });

  it("无扩展名且 blob.type 为空时使用兜底 MIME 类型", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);
    const mockBlob = new Blob(["image-data"]);
    Object.defineProperty(mockBlob, "type", { value: "" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: () => Promise.resolve(mockBlob),
    });

    const items = [{ id: "1", src: "https://example.com/image-no-ext" }];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(1);
    expect(getAt(result, 0).mime_type).toBe("application/octet-stream");
  });

  it("空 src 字符串被跳过", async () => {
    const items = [{ id: "1", src: "   " }];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(0);
  });

  it("既无 file 也无 src 的项被跳过", async () => {
    const items = [{ id: "1" }];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(0);
  });

  it("历史失真 file 但保留 src 时可回退到 URL 继续解析", async () => {
    const base64 = "aW1hZ2UtZGF0YQ==";
    const dataUrl = `data:image/png;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);
    setupFetchSuccess("image/png");

    const items = [
      {
        id: "1",
        file: { name: "broken-file-object" } as File,
        src: "https://example.com/recoverable.png",
      },
    ];

    const result = await filesToInlineDataList(items, undefined);

    expect(result).toHaveLength(1);
    expect(getAt(result, 0).mime_type).toBe("image/png");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/recoverable.png",
      expect.any(Object)
    );
  });

  it("历史失真 file 且无 src 时抛出业务可读错误，避免原始 TypeError", async () => {
    try {
      await filesToInlineDataList([
        {
          id: "1",
          file: { name: "broken-file-object" } as File,
        },
      ], undefined);
      throw new Error("should throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("参考素材读取失败");
      expect(message).not.toContain("readAsDataURL");
    }
  });

  // 画布连线输入场景测试
  describe("画布连线输入场景", () => {
    it("纯 URL 字符串输入正确转换为 inline_data", async () => {
      const base64 = "aW1hZ2UtZGF0YQ==";
      const dataUrl = `data:image/png;base64,${base64}`;
      setupFileReaderSuccess(dataUrl);
      setupFetchSuccess("image/png");

      // 模拟画布连线输入：单张图片以纯 URL 字符串形式传入
      const result = await filesToInlineDataList("https://example.com/edge-input.png", undefined);

      expect(result).toHaveLength(1);
      expect(getAt(result, 0).mime_type).toBe("image/png");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/edge-input.png",
        expect.any(Object)
      );
    });

    it("Hub 模式下 /files/... 输入会路由到本地 Hub base 再下载", async () => {
      const base64 = "aW1hZ2UtZGF0YQ==";
      const dataUrl = `data:image/png;base64,${base64}`;
      setupFileReaderSuccess(dataUrl);
      setupFetchSuccess("image/png");

      const prev = window.__IART_LOCAL_API_BASE__;
      window.__IART_LOCAL_API_BASE__ = "http://localhost:4000";
      try {
        const result = await filesToInlineDataList("/files/canvas-output.png?t=123", undefined);

        expect(result).toHaveLength(1);
        expect(getAt(result, 0).mime_type).toBe("image/png");
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "http://localhost:4000/files/canvas-output.png?t=123",
          expect.any(Object)
        );
      } finally {
        window.__IART_LOCAL_API_BASE__ = prev;
      }
    });

    it("URL 字符串数组输入正确转换为多个 inline_data", async () => {
      const base64 = "aW1hZ2UtZGF0YQ==";
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      setupFileReaderSuccess(dataUrl);
      setupFetchSuccess("image/jpeg");

      // 模拟画布多连线输入：多张图片以 URL 字符串数组形式传入
      const urls = [
        "https://example.com/image-a.jpg",
        "https://example.com/image-b.jpg",
      ];

      const result = await filesToInlineDataList(urls, undefined);

      expect(result).toHaveLength(2);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/image-a.jpg",
        expect.any(Object)
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/image-b.jpg",
        expect.any(Object)
      );
    });

    it("混合数组（URL 字符串 + 对象）正确处理", async () => {
      const base64 = "aW1hZ2UtZGF0YQ==";
      const dataUrl = `data:image/png;base64,${base64}`;
      setupFileReaderSuccess(dataUrl);
      setupFetchSuccess("image/webp");

      const file = createFile("local.png", "image-data", "image/png");
      // 混合数组：包含对象和纯字符串
      const mixed = [
        { id: "1", file },
        "https://example.com/remote.webp",
      ];

      const result = await filesToInlineDataList(mixed, undefined);

      expect(result).toHaveLength(2);
      expect(getAt(result, 0).mime_type).toBe("image/png");
      expect(getAt(result, 1).mime_type).toBe("image/webp");
    });

    it("空字符串输入返回空数组", async () => {
      const result = await filesToInlineDataList("", undefined);
      expect(result).toEqual([]);
    });

    it("对象的 src 为 data URL 时不产生重复", async () => {
      // 这是画布节点输出经过 normalizeUploadItems 后的典型格式
      // 关键：{ src: "data:..." } 同时能被 coerceInlineData 和 normalizeMediaInput 识别
      // 修复后应该只产生一份 inline_data
      const base64 = "aW1hZ2UtZGF0YQ==";
      const dataUrl = `data:image/png;base64,${base64}`;
      globalThis.fetch = vi.fn();

      const items = [{ id: "canvas-image-1", src: dataUrl }];

      const result = await filesToInlineDataList(items, undefined);

      // 修复前：返回 2 个相同的 inline_data（重复）
      // 修复后：返回 1 个 inline_data（正确）
      expect(result).toHaveLength(1);
      expect(getAt(result, 0)).toEqual({ mime_type: "image/png", data: base64 });
      // 不应该触发 fetch（data URL 不需要下载）
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("多个对象的 src 为 data URL 时各只产生一份", async () => {
      const base64A = "aW1hZ2UtYQ==";
      const base64B = "aW1hZ2UtYg==";
      globalThis.fetch = vi.fn();

      const items = [
        { id: "1", src: `data:image/png;base64,${base64A}` },
        { id: "2", src: `data:image/jpeg;base64,${base64B}` },
      ];

      const result = await filesToInlineDataList(items, undefined);

      expect(result).toHaveLength(2);
      expect(getAt(result, 0)).toEqual({ mime_type: "image/png", data: base64A });
      expect(getAt(result, 1)).toEqual({ mime_type: "image/jpeg", data: base64B });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("仅空白字符串输入返回空数组", async () => {
      const result = await filesToInlineDataList("   ", undefined);
      expect(result).toEqual([]);
    });

    it("字符串数组中的空字符串被跳过", async () => {
      const base64 = "aW1hZ2UtZGF0YQ==";
      const dataUrl = `data:image/png;base64,${base64}`;
      setupFileReaderSuccess(dataUrl);
      setupFetchSuccess("image/png");

      const urls = [
        "https://example.com/valid.png",
        "",
        "   ",
      ];

      const result = await filesToInlineDataList(urls, undefined);

      expect(result).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
