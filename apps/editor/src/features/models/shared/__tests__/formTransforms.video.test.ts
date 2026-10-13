import { describe, it, expect, vi, afterEach } from "vitest";
import { fileToBase64Video } from "@/features/models/shared/formTransforms";
import { cast } from '@/lib/utils';

const createFile = (name: string, content = "dummy", type = "video/mp4"): File => {
  return new File([content], name, { type });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});


describe("fileToBase64Video", () => {
  const originalFileReader = globalThis.FileReader;
  const setMockFileReader = (reader: typeof FileReader): void => {
    vi.stubGlobal("FileReader", reader);
  };

  const setupFileReaderSuccess = (dataUrl: string) => {
    class MockFileReader {
      public result: string | ArrayBuffer | null = null;
      public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      public onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

      readAsDataURL(_file: Blob) {
        this.result = dataUrl;
        if (this.onload) {
          this.onload.call(cast<FileReader>(this), {} as ProgressEvent<FileReader>);
        }
      }
    }

    setMockFileReader(MockFileReader as never);
  };

  const setupFileReaderError = () => {
    class MockFileReader {
      public result: string | ArrayBuffer | null = null;
      public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      public onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

      readAsDataURL(_file: Blob) {
        if (this.onerror) {
          this.onerror.call(cast<FileReader>(this), {} as ProgressEvent<FileReader>);
        }
      }
    }

    setMockFileReader(MockFileReader as never);
  };

  afterEach(() => {
    vi.stubGlobal("FileReader", originalFileReader);
  });

  it("有效视频文件：返回 { mime_type, data } 且 data 为有效 Base64", async () => {
    const base64 = "Zm9vYmFy"; // foobar
    const dataUrl = `data:video/mp4;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);

    const file = createFile("video.mp4", "content", "video/mp4");
    const value = [{ file }];

    const result = await fileToBase64Video(value);

    expect(result).not.toBeNull();
    expect(result?.mime_type).toBe("video/mp4");
    expect(result?.data).toBe(base64);
    // 简单校验 Base64 可被解码
    const data = result?.data;
    expect(data).toBeDefined();
    if (!data) return;
    expect(() => atob(data)).not.toThrow();
  });

  it("空数组：返回 null", async () => {
    const result = await fileToBase64Video([]);

    expect(result).toBeNull();
  });

  it("无 file 字段：返回 null", async () => {
    const value = [{ id: "1" }];

    const result = await fileToBase64Video(value);

    expect(result).toBeNull();
  });

  it("历史失真 file 且无 src：返回 null 并输出业务可读错误", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fileToBase64Video([
      { id: "broken", file: { name: "broken-file-object" } as File },
    ]);

    expect(result).toBeNull();
    const messages = consoleErrorSpy.mock.calls.flatMap((call) => call.map((item) => String(item)));
    expect(messages.some((message) => message.includes("参考素材读取失败"))).toBe(true);
  });

  it("URL 输入：下载并转为 Base64", async () => {
    const base64 = "Zm9vYmFy"; // foobar
    const dataUrl = `data:video/mp4;base64,${base64}`;
    setupFileReaderSuccess(dataUrl);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["video"], { type: "video/mp4" }),
      headers: { get: () => "video/mp4" },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fileToBase64Video([
      { src: "https://example.com/video.mp4" },
    ]);

    expect(result).not.toBeNull();
    expect(result?.mime_type).toBe("video/mp4");
    expect(result?.data).toBe(base64);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("FileReader 失败：返回 null 并记录 console.error", async () => {
    setupFileReaderError();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const file = createFile("video.mp4", "content", "video/mp4");
    const value = [{ file }];

    const result = await fileToBase64Video(value);

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
