// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const desktopCoordinatorEntry = `${workspaceRoot}/apps/desktop-shell/dist/window/main-window-open-coordinator.cjs`;
const desktopDevToolsShortcutsEntry = `${workspaceRoot}/apps/desktop-shell/dist/window/devtools-shortcuts.cjs`;
const desktopShellWindowsSource = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-windows.cts`;
const desktopShellIpcSource = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-ipc.cts`;
const desktopShellUtilsSource = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-utils.cts`;
const desktopShellPreloadSource = `${workspaceRoot}/apps/desktop-shell/src/preload.cts`;

const ensureDesktopShellBuild = () => {
  if (
    existsSync(desktopCoordinatorEntry) &&
    existsSync(desktopDevToolsShortcutsEntry)
  ) {
    return;
  }
  execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

type MainWindowOpenCoordinatorModule = {
  createMainWindowOpenCoordinator: (options: {
    openMainWindow: (startUrl: string) => void;
  }) => {
    requestOpen: () => void;
    markStartupReady: (
      startUrl: string,
      options?: { openNow?: boolean },
    ) => void;
    hasPendingOpenRequest: () => boolean;
  };
};

type DevToolsShortcutsModule = {
  isDevToolsShortcutInput: (input: {
    type?: unknown;
    key?: unknown;
    code?: unknown;
    control?: unknown;
    meta?: unknown;
    shift?: unknown;
  }) => boolean;
};

const loadCoordinatorModule = () =>
  requireDesktop(desktopCoordinatorEntry) as MainWindowOpenCoordinatorModule;
const loadDevToolsShortcutsModule = () =>
  requireDesktop(desktopDevToolsShortcutsEntry) as DevToolsShortcutsModule;

describe("main window open coordinator", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  it("defers early open requests until startup has a resolved URL", () => {
    const { createMainWindowOpenCoordinator } = loadCoordinatorModule();
    const openedUrls: string[] = [];
    const coordinator = createMainWindowOpenCoordinator({
      openMainWindow: (startUrl) => {
        openedUrls.push(startUrl);
      },
    });

    coordinator.requestOpen();

    expect(openedUrls).toEqual([]);
    expect(coordinator.hasPendingOpenRequest()).toBe(true);

    coordinator.markStartupReady("app://hub");

    expect(openedUrls).toEqual(["app://hub"]);
    expect(coordinator.hasPendingOpenRequest()).toBe(false);
  });

  it("opens immediately after startup is ready and normalizes blank startup URL", () => {
    const { createMainWindowOpenCoordinator } = loadCoordinatorModule();
    const openedUrls: string[] = [];
    const coordinator = createMainWindowOpenCoordinator({
      openMainWindow: (startUrl) => {
        openedUrls.push(startUrl);
      },
    });

    coordinator.markStartupReady("   ");
    coordinator.requestOpen();

    expect(openedUrls).toEqual(["about:blank"]);
  });

  it("supports the initial startup open without a separate pending request", () => {
    const { createMainWindowOpenCoordinator } = loadCoordinatorModule();
    const openedUrls: string[] = [];
    const coordinator = createMainWindowOpenCoordinator({
      openMainWindow: (startUrl) => {
        openedUrls.push(startUrl);
      },
    });

    coordinator.markStartupReady("file://hub.html", { openNow: true });

    expect(openedUrls).toEqual(["file://hub.html"]);
    expect(coordinator.hasPendingOpenRequest()).toBe(false);
  });
});

describe("desktop diagnostics and DevConsole policy", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  it("recognizes F12 and Ctrl/Cmd+Shift+I as current-window DevConsole shortcuts", () => {
    const { isDevToolsShortcutInput } = loadDevToolsShortcutsModule();

    expect(isDevToolsShortcutInput({ type: "keyDown", key: "F12" })).toBe(true);
    expect(
      isDevToolsShortcutInput({
        type: "keyDown",
        key: "i",
        code: "KeyI",
        control: true,
        shift: true,
      }),
    ).toBe(true);
    expect(
      isDevToolsShortcutInput({
        type: "keyDown",
        key: "i",
        code: "KeyI",
        meta: true,
        shift: true,
      }),
    ).toBe(true);
    expect(
      isDevToolsShortcutInput({ type: "keyDown", key: "i", control: true }),
    ).toBe(false);
  });

  it("keeps Hub and Editor BrowserWindow devTools explicitly enabled", () => {
    const source = readFileSync(desktopShellWindowsSource, "utf8");

    expect(source).toContain("devTools: true");
    expect(source).toContain("webPreferences: buildWindowWebPreferences()");
  });

  it("wires static failure pages for load failures, renderer exits and unresponsive windows", () => {
    const source = readFileSync(desktopShellWindowsSource, "utf8");

    expect(source).toContain("did-fail-load");
    expect(source).toContain("did-fail-provisional-load");
    expect(source).toContain("render-process-gone");
    expect(source).toContain("unresponsive");
    expect(source).toContain("resolveStaticErrorPageUrl");
  });

  it("opens DevConsole only for the IPC sender window", () => {
    const source = readFileSync(desktopShellIpcSource, "utf8");
    const preloadSource = readFileSync(desktopShellPreloadSource, "utf8");

    expect(source).toContain('ipcMain.handle("open-dev-console"');
    expect(source).toContain("BrowserWindow.fromWebContents(event.sender)");
    expect(source).not.toContain(
      "BrowserWindow.getFocusedWindow()?.webContents.openDevTools",
    );
    expect(preloadSource).toContain(
      'openDevConsole: () => ipcRenderer.invoke("open-dev-console")',
    );
  });

  it("static error page contains copyable diagnostics and DevConsole shortcut guidance", () => {
    const source = readFileSync(desktopShellUtilsSource, "utf8");

    expect(source).toContain("复制错误详情");
    expect(source).toContain("F12");
    expect(source).toContain("Ctrl+Shift+I");
    expect(source).toContain("Cmd+Shift+I");
    expect(source).toContain("currentUrl");
    expect(source).toContain("reloadUrl");
  });
});
