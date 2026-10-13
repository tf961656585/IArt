// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const writeImageEntry = `${workspaceRoot}/apps/desktop-shell/dist/clipboard/writeImageFromUrlClipboard.cjs`;
const writeTextEntry = `${workspaceRoot}/apps/desktop-shell/dist/clipboard/writeTextClipboard.cjs`;

const ensureDesktopShellBuild = (): void => {
  if (existsSync(writeImageEntry) && existsSync(writeTextEntry)) return;
  execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

type NativeImageLike = {
  isEmpty: () => boolean;
};

type WriteImageFromUrlClipboardModule = {
  writeImageFromUrlClipboard: (params: {
    url: string | null | undefined;
    storedProjectPath: string | null | undefined;
    hintedProjectPath: string | null | undefined;
    clipboard: {
      writeImage: (image: NativeImageLike) => void;
    } | null;
    nativeImage: {
      createFromPath: (path: string) => NativeImageLike;
    } | null;
    urlResolverRegistry: {
      resolve: (
        url: string,
        ctx: { projectPath: string },
      ) => {
        ok: boolean;
        reason: string | undefined;
        fileKey: string | null;
      } | null;
    } | null;
  }) => Promise<{ ok: boolean; reason?: string; filePath?: string }>;
};

type WriteTextClipboardModule = {
  writeTextClipboard: (params: {
    text: string | null | undefined;
    clipboard: {
      writeText: (text: string) => void;
    } | null;
  }) => { ok: boolean; reason?: string };
};

const loadWriteImageModule = (): WriteImageFromUrlClipboardModule =>
  requireDesktop(writeImageEntry) as WriteImageFromUrlClipboardModule;

const loadWriteTextModule = (): WriteTextClipboardModule =>
  requireDesktop(writeTextEntry) as WriteTextClipboardModule;

/**
 * 构造一个合法 project 目录：必须含 project.sqlite 或 manifest.json（isValidProjectFolder 要求）。
 * 同时建立 media 子目录（getProjectFolderPaths 推导）。
 */
const createValidProject = (): string => {
  const project = mkdtempSync(`${tmpdir()}/iart-clipboard-test-`);
  writeFileSync(path.join(project, "project.sqlite"), "");
  mkdirSync(path.join(project, "media"), { recursive: true });
  return project;
};

describe("writeImageFromUrlClipboard", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  it("returns missing-url when url is empty", async () => {
    const mod = loadWriteImageModule();
    const result = await mod.writeImageFromUrlClipboard({
      url: "",
      storedProjectPath: null,
      hintedProjectPath: null,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: null,
    });
    expect(result).toEqual({ ok: false, reason: "missing-url" });
  });

  it("returns missing-project-path when both project paths empty", async () => {
    const mod = loadWriteImageModule();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/abc.png",
      storedProjectPath: null,
      hintedProjectPath: null,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: { resolve: () => null },
    });
    expect(result).toEqual({ ok: false, reason: "missing-project-path" });
  });

  it("returns missing-project-path when project folder is invalid (no sqlite/manifest)", async () => {
    const mod = loadWriteImageModule();
    const tmpProject = mkdtempSync(`${tmpdir()}/iart-clipboard-test-`);
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/abc.png",
      storedProjectPath: null,
      hintedProjectPath: tmpProject,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: { resolve: () => null },
    });
    expect(result).toEqual({ ok: false, reason: "missing-project-path" });
  });

  it("returns not-files-url when resolver returns null", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const result = await mod.writeImageFromUrlClipboard({
      url: "https://example.com/foo.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: { resolve: () => null },
    });
    expect(result).toEqual({ ok: false, reason: "not-files-url" });
  });

  it("returns resolve-failed when resolver.ok is false", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/abc.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: {
        resolve: () => ({ ok: false, reason: "some-error", fileKey: null }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "resolve-failed" });
  });

  it("returns invalid-file-key when resolver returns empty fileKey", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/abc.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "invalid-file-key" });
  });

  it("returns unsafe-file-key when fileKey contains ..", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/abc.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "../etc/passwd" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "unsafe-file-key" });
  });

  it("returns not-found when file does not exist in media dir", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/missing.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "missing.png" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("returns read-failed when nativeImage returns empty image (corrupted file)", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const filePath = path.join(project, "media", "corrupt.png");
    writeFileSync(filePath, "not-an-image");

    const writeImage = vi.fn();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/corrupt.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: { writeImage },
      nativeImage: {
        // 模拟 Electron 对损坏文件返回 empty image（不抛异常）
        createFromPath: () => ({ isEmpty: () => true }),
      },
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "corrupt.png" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "read-failed" });
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("returns read-failed when nativeImage.createFromPath throws", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const filePath = path.join(project, "media", "error.png");
    writeFileSync(filePath, "data");

    const writeImage = vi.fn();
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/error.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: { writeImage },
      nativeImage: {
        createFromPath: () => {
          throw new Error("disk error");
        },
      },
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "error.png" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "read-failed" });
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("returns read-failed when nativeImage/clipboard is null but file exists", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const filePath = path.join(project, "media", "valid.png");
    writeFileSync(filePath, "png-data");

    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/valid.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: null,
      nativeImage: null,
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "valid.png" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "read-failed" });
  });

  it("returns ok + filePath and calls clipboard.writeImage on success path", async () => {
    const mod = loadWriteImageModule();
    const project = createValidProject();
    const filePath = path.join(project, "media", "valid.png");
    writeFileSync(filePath, "png-data");

    const writeImage = vi.fn();
    const fakeImage: NativeImageLike = { isEmpty: () => false };
    const result = await mod.writeImageFromUrlClipboard({
      url: "local-media://__global__/valid.png",
      storedProjectPath: null,
      hintedProjectPath: project,
      clipboard: { writeImage },
      nativeImage: {
        createFromPath: () => fakeImage,
      },
      urlResolverRegistry: {
        resolve: () => ({ ok: true, reason: undefined, fileKey: "valid.png" }),
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filePath).toBe(filePath);
    }
    expect(writeImage).toHaveBeenCalledTimes(1);
    expect(writeImage).toHaveBeenCalledWith(fakeImage);
  });
});

describe("writeTextClipboard", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  it("returns empty-text when text is empty", () => {
    const mod = loadWriteTextModule();
    const writeText = vi.fn();
    const result = mod.writeTextClipboard({
      text: "",
      clipboard: { writeText },
    });
    expect(result).toEqual({ ok: false, reason: "empty-text" });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("returns ok and calls clipboard.writeText on success", () => {
    const mod = loadWriteTextModule();
    const writeText = vi.fn();
    const result = mod.writeTextClipboard({
      text: "hello world",
      clipboard: { writeText },
    });
    expect(result).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello world");
  });

  it("returns write-failed when clipboard.writeText throws", () => {
    const mod = loadWriteTextModule();
    const writeText = vi.fn(() => {
      throw new Error("clipboard locked");
    });
    const result = mod.writeTextClipboard({
      text: "hello",
      clipboard: { writeText },
    });
    expect(result).toEqual({ ok: false, reason: "write-failed" });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("returns write-failed when clipboard is null", () => {
    const mod = loadWriteTextModule();
    const result = mod.writeTextClipboard({
      text: "hello",
      clipboard: null,
    });
    expect(result).toEqual({ ok: false, reason: "write-failed" });
  });
});
