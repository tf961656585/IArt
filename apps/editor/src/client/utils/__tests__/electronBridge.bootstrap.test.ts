import { afterEach, describe, expect, it } from "vitest";

import type { ElectronBridge } from "../electronBridge";
import {
  fetchEditorBootstrapFromElectron,
  openDevConsoleFromElectron,
} from "../electronBridge";

const setElectronBridge = (bridge: Partial<ElectronBridge>): void => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: bridge,
  });
};

describe("electronBridge.fetchEditorBootstrapFromElectron", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("returns null when electron bridge is missing", async () => {
    await expect(fetchEditorBootstrapFromElectron()).resolves.toBeNull();
  });

  it("returns validated desktop bootstrap from preload bridge", async () => {
    setElectronBridge({
      getEditorBootstrap: async () => ({
        runtime: "desktop",
        backendBaseUrl: "http://127.0.0.1:39000",
        projectPath: "/tmp/demo.iartproj",
        projectRef: "prj_0123456789abcdef0123456789abcdef",
        stableProjectId: "stable-abc123",
        sessionToken: null,
        locale: "zh-CN",
        windowContext: {
          entry: "editor",
        },
      }),
    });

    await expect(fetchEditorBootstrapFromElectron()).resolves.toEqual({
      runtime: "desktop",
      backendBaseUrl: "http://127.0.0.1:39000",
      projectPath: "/tmp/demo.iartproj",
      projectRef: "prj_0123456789abcdef0123456789abcdef",
      stableProjectId: "stable-abc123",
      sessionToken: null,
      locale: "zh-CN",
      windowContext: {
        entry: "editor",
      },
    });
  });
});

describe("electronBridge.openDevConsoleFromElectron", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("delegates DevConsole opening to the preload bridge for the current Electron window", async () => {
    const openDevConsole = async () => ({ ok: true, reason: undefined });
    setElectronBridge({ openDevConsole });

    await expect(openDevConsoleFromElectron()).resolves.toEqual({ ok: true });
  });

  it("normalizes unavailable bridge as not-in-electron", async () => {
    await expect(openDevConsoleFromElectron()).resolves.toEqual({
      ok: false,
      reason: "not-in-electron",
    });
  });
});
