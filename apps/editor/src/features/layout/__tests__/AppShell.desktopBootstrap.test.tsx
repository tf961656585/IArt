import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "../AppShell";
import { useRuntimeStore } from "@/client/store/runtimeStore";
import type * as HubFetchNS from "@/client/utils/hubFetch";
import type * as ElectronBridgeNS from "@/client/utils/electronBridge";
import type { ElectronBridge } from "@/client/utils/electronBridge";

const { isHubRuntimeMock } = vi.hoisted(() => ({
  isHubRuntimeMock: vi.fn(() => false),
}));

vi.mock("@/features/hooks/useBootstrapClient", () => ({
  default: vi.fn(),
}));

vi.mock("@/client/utils/hubFetch", async () => {
  const actual = await vi.importActual<typeof HubFetchNS>(
    "@/client/utils/hubFetch",
  );
  return {
    ...actual,
    isHubRuntime: isHubRuntimeMock,
  };
});

vi.mock("@/client/components/AnnouncementBanner", () => ({
  default: () => null,
}));

vi.mock("@/client/utils/electronBridge", async () => {
  const actual = await vi.importActual<typeof ElectronBridgeNS>(
    "@/client/utils/electronBridge",
  );
  return {
    ...actual,
    fetchAppVersionFromElectron: vi.fn(async () => null),
  };
});

const setWindowElectron = (
  bridge: Partial<ElectronBridge> | undefined,
): void => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: bridge,
  });
};

describe("AppShell desktop bootstrap gate", () => {
  beforeEach(() => {
    isHubRuntimeMock.mockReturnValue(false);
    useRuntimeStore.setState({
      bootstrapStatus: "idle",
      bootstrapError: null,
      desktopBootstrap: null,
      backendBaseUrl: null,
      projectPath: null,
    });
    setWindowElectron({});
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "electron");
  });

  it("桌面 bootstrap 失败时显示错误态，而不是直接放行子内容", () => {
    useRuntimeStore.setState({
      bootstrapStatus: "error",
      bootstrapError: "Desktop Shell 未提供有效的 editor bootstrap",
    });

    render(
      <AppShell>
        <div>editor-content</div>
      </AppShell>,
    );

    expect(screen.getByText("项目打开失败")).toBeInTheDocument();
    expect(
      screen.getByText("项目打开失败，请重新打开项目。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("editor-content")).not.toBeInTheDocument();
  });

  it("桌面 bootstrap 就绪后放行正式 editor 内容", () => {
    useRuntimeStore.setState({
      bootstrapStatus: "ready",
      bootstrapError: null,
      desktopBootstrap: {
        runtime: "desktop",
        backendBaseUrl: "http://127.0.0.1:39000",
        projectPath: "/tmp/demo.iartproj",
        projectRef: "prj_0123456789abcdef0123456789abcdef",
        stableProjectId: "stable-abc123",
        sessionToken: "desktop:test-session",
        locale: "zh-CN",
        windowContext: {
          entry: "editor",
        },
      },
      backendBaseUrl: "http://127.0.0.1:39000",
      projectPath: "/tmp/demo.iartproj",
      projectRef: "prj_0123456789abcdef0123456789abcdef",
    });

    render(
      <AppShell>
        <div>editor-content</div>
      </AppShell>,
    );

    expect(screen.getByText("editor-content")).toBeInTheDocument();
    expect(screen.queryByText("项目打开失败")).not.toBeInTheDocument();
  });

  it("packaged Electron 下仍使用同一诊断边界捕获 editor 子树异常", () => {
    useRuntimeStore.setState({
      bootstrapStatus: "ready",
      bootstrapError: null,
      desktopBootstrap: {
        runtime: "desktop",
        backendBaseUrl: "http://127.0.0.1:39000",
        projectPath: "/tmp/demo.iartproj",
        projectRef: "prj_0123456789abcdef0123456789abcdef",
        stableProjectId: "stable-abc123",
        sessionToken: "desktop:test-session",
        locale: "zh-CN",
        windowContext: {
          entry: "editor",
        },
      },
      backendBaseUrl: "http://127.0.0.1:39000",
      projectPath: "/tmp/demo.iartproj",
      projectRef: "prj_0123456789abcdef0123456789abcdef",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setWindowElectron({});

    const BrokenEditorChild = () => {
      throw new Error("packaged render boom");
    };

    render(
      <AppShell>
        <BrokenEditorChild />
      </AppShell>,
    );

    expect(screen.getByText("编辑器遇到了问题")).toBeInTheDocument();
    expect(screen.getAllByText(/packaged render boom/).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByRole("button", { name: "复制错误详情" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新加载编辑器" }),
    ).toBeInTheDocument();

    errorSpy.mockRestore();
  });

  it("Hub runtime 下挂载时不再打印登录状态同步失败警告", () => {
    isHubRuntimeMock.mockReturnValue(true);
    useRuntimeStore.setState({
      bootstrapStatus: "ready",
      bootstrapError: null,
      desktopBootstrap: {
        runtime: "desktop",
        backendBaseUrl: "http://127.0.0.1:39000",
        projectPath: "/tmp/demo.iartproj",
        projectRef: "prj_0123456789abcdef0123456789abcdef",
        stableProjectId: "stable-abc123",
        sessionToken: "desktop:test-session",
        locale: "zh-CN",
        windowContext: {
          entry: "editor",
        },
      },
      backendBaseUrl: "http://127.0.0.1:39000",
      projectPath: "/tmp/demo.iartproj",
      projectRef: "prj_0123456789abcdef0123456789abcdef",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <AppShell>
        <div>editor-content</div>
      </AppShell>,
    );

    expect(screen.getByText("editor-content")).toBeInTheDocument();
    expect(
      warnSpy.mock.calls.some(
        ([message]) => message === "AppShell: Hub 登录状态同步失败",
      ),
    ).toBe(false);

    warnSpy.mockRestore();
  });
});
