// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * window chrome 主题同步 IPC handler 测试（spec docs/hub/window-chrome.md §7.4/§7.5）。
 *
 * 覆盖 2026-10-16 实证缺陷的边界回归：
 * - overlay 载荷必须是 sRGB hex，oklch 载荷被 schema 拒绝（Electron 解析器静默回落白条）；
 * - themeSource 直写接受 system（跟随系统不自锁）；非法载荷不改主进程外观且留痕。
 *
 * handler 是可注入单元（window/window-chrome-ipc-handlers.cts），经 dist 产物加载、
 * 注入假窗口与假 nativeTheme 测试，无需 mock electron 模块。范式对齐
 * main-window-open-coordinator.test.mts（createRequire + dist 产物 + 手写类型断言）。
 */

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const handlersEntry = `${workspaceRoot}/apps/desktop-shell/dist/window/window-chrome-ipc-handlers.cjs`;

const ensureDesktopShellBuild = (): void => {
  if (existsSync(handlersEntry)) return;
  execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

beforeAll(ensureDesktopShellBuild);

type ThemeSource = "light" | "dark" | "system";
type OverlayWindow = {
  setTitleBarOverlay: (options: { color: string; symbolColor: string }) => void;
  isDestroyed: () => boolean;
};
type HandlersModule = {
  createSetTitleBarOverlayHandler: (deps: {
    getMainWindow: () => OverlayWindow | null | undefined;
  }) => (event: unknown, payload: unknown) => void;
  createSetNativeThemeSourceHandler: (deps: {
    nativeTheme: { themeSource: ThemeSource };
  }) => (event: unknown, payload: unknown) => void;
};

const loadHandlers = (): HandlersModule => requireDesktop(handlersEntry) as HandlersModule;

describe("createSetNativeThemeSourceHandler", () => {
  it("writes the theme preference through to nativeTheme, including system", () => {
    const handlers = loadHandlers();
    const nativeTheme = { themeSource: "dark" as ThemeSource };
    const handler = handlers.createSetNativeThemeSourceHandler({ nativeTheme });
    handler(undefined, { theme: "system" });
    expect(nativeTheme.themeSource).toBe("system");
    handler(undefined, { theme: "light" });
    expect(nativeTheme.themeSource).toBe("light");
    handler(undefined, { theme: "dark" });
    expect(nativeTheme.themeSource).toBe("dark");
  });

  it("ignores invalid payloads without touching nativeTheme", () => {
    const handlers = loadHandlers();
    const nativeTheme = { themeSource: "dark" as ThemeSource };
    const handler = handlers.createSetNativeThemeSourceHandler({ nativeTheme });
    handler(undefined, { theme: "bogus" });
    handler(undefined, undefined);
    handler(undefined, { theme: "dark", extra: 1 });
    expect(nativeTheme.themeSource).toBe("dark");
  });
});

describe("createSetTitleBarOverlayHandler", () => {
  it("applies the parsed hex payload to the main window", () => {
    const handlers = loadHandlers();
    const setTitleBarOverlay = vi.fn();
    const win: OverlayWindow = { setTitleBarOverlay, isDestroyed: () => false };
    const handler = handlers.createSetTitleBarOverlayHandler({ getMainWindow: () => win });
    handler(undefined, { color: "#0d0e14", symbolColor: "#f4f5f7" });
    expect(setTitleBarOverlay).toHaveBeenCalledTimes(1);
    expect(setTitleBarOverlay).toHaveBeenCalledWith({ color: "#0d0e14", symbolColor: "#f4f5f7" });
  });

  it("rejects oklch payloads (Electron parser silently falls back to white)", () => {
    const handlers = loadHandlers();
    const setTitleBarOverlay = vi.fn();
    const win: OverlayWindow = { setTitleBarOverlay, isDestroyed: () => false };
    const handler = handlers.createSetTitleBarOverlayHandler({ getMainWindow: () => win });
    handler(undefined, {
      color: "oklch(0.165 0.012 277)",
      symbolColor: "oklch(0.97 0.003 277)",
    });
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("skips silently when the main window is gone", () => {
    const handlers = loadHandlers();
    const handler = handlers.createSetTitleBarOverlayHandler({ getMainWindow: () => null });
    expect(() =>
      handler(undefined, { color: "#0d0e14", symbolColor: "#f4f5f7" }),
    ).not.toThrow();
  });
});
