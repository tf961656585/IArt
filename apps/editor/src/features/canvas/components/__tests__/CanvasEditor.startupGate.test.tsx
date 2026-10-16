import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasEditor } from "../CanvasEditor";
import type { CanvasTaskSyncStatus } from "../../hooks/useCanvasTaskIndexSync";
import type { EditorProjectStateSyncStatus } from "../../hooks/useEditorProjectStateSync";

const {
  mockUseAutoSave,
  mockUseCanvasHotkeys,
  mockOpenProjectSession,
  mockReportProjectPresence,
  mockGetPendingNodeChangesSnapshot,
  mockGetProject,
  mockDiscardPendingNodeChanges,
  mockEnqueuePendingNodeChanges,
  mockFlushPendingNodeChanges,
  mockListVisibleModelConfigs,
  mockFetch,
  mockUseCanvasTaskIndexSync,
  mockUseEditorProjectStateSync,
  mockSendBeacon,
  mockStartupProbeReady,
} = vi.hoisted(() => ({
  mockUseAutoSave: vi.fn(),
  mockUseCanvasHotkeys: vi.fn(),
  mockOpenProjectSession: vi.fn(
    async (): Promise<unknown> => ({
      status: "ok",
      sessionToken: "session-attached",
      project: null,
    }),
  ),
  mockReportProjectPresence: vi.fn(
    async (): Promise<unknown> => ({
      status: "ok",
      sessionToken: "session-attached",
      project: {
        name: "mock-project",
        nodeGraph: { id: "graph-1", nodes: [], edges: [] },
        mediaAssets: {},
        nodeGraphId: "graph-1",
        savedAt: 1,
        createdAt: 1,
        hasUnsavedChanges: false,
        path: "/tmp/mock.iartproj",
        nodeStateAuthority: {
          owner: "backend",
          nodeGraphId: "graph-1",
          formalState: "backend_persisted",
          hasPendingWrite: false,
          canResumePendingChanges: false,
          pendingChangeCount: 0,
        },
      },
    }),
  ),
  mockGetPendingNodeChangesSnapshot: vi.fn(async (): Promise<unknown> => null),
  mockGetProject: vi.fn(async (): Promise<unknown> => null),
  mockDiscardPendingNodeChanges: vi.fn(async (): Promise<unknown> => null),
  mockEnqueuePendingNodeChanges: vi.fn(async (): Promise<unknown> => undefined),
  mockFlushPendingNodeChanges: vi.fn(async (): Promise<unknown> => undefined),
  mockListVisibleModelConfigs: vi.fn(() => [
    { modelId: "mock-model", visible: true },
  ]),
  mockFetch: vi.fn(async () => ({ ok: true, status: 200 })),
  mockUseCanvasTaskIndexSync: vi.fn(),
  mockUseEditorProjectStateSync: vi.fn(),
  mockSendBeacon: vi.fn(() => true),
  mockStartupProbeReady: vi.fn(),
}));

type MockCanvasState = {
  nodeGraph: { id: string; nodes: unknown[]; edges: unknown[] } | null;
  loadNodeGraph: ReturnType<typeof vi.fn>;
  setProjectMediaAssets: ReturnType<typeof vi.fn>;
  syncPersistenceState: ReturnType<typeof vi.fn>;
  commitDeferredHistoryBaseline: ReturnType<typeof vi.fn>;
  pendingMediaMigrationNotice: string | null;
  clearPendingMediaMigrationNotice: ReturnType<typeof vi.fn>;
};

let mockCanvasState: MockCanvasState;
let mockTaskSyncStatus: CanvasTaskSyncStatus;
let mockProjectStateSyncStatus: EditorProjectStateSyncStatus;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
type MockGraphSnapshot = { id: string; nodes: unknown[]; edges: unknown[] };

vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../hooks", () => ({
  useAutoSave: () => {
    mockUseAutoSave();
  },
  useCanvasHotkeys: () => {
    mockUseCanvasHotkeys();
  },
}));

vi.mock("../../hooks/useCanvasTaskIndexSync", () => ({
  useCanvasTaskIndexSync: (...args: unknown[]) => {
    mockUseCanvasTaskIndexSync(...args);
    return mockTaskSyncStatus;
  },
}));

vi.mock("../../hooks/useCanvasLocateRequest", () => ({
  useCanvasLocateRequestListener: vi.fn(),
}));

vi.mock("../../hooks/useEditorProjectStateSync", () => ({
  useEditorProjectStateSync: (...args: unknown[]) => {
    mockUseEditorProjectStateSync(...args);
    return mockProjectStateSyncStatus;
  },
}));

vi.mock("@/client/utils/hubFetch", () => ({
  isHubRuntime: () => true,
}));

vi.mock("@/client/utils/apiConfig", () => ({
  resolveApiEndpoint: (value: string) => `http://127.0.0.1:49454${value}`,
}));

vi.mock("@/client/store/runtimeStore", () => {
  const runtimeState = {
    desktopBootstrap: { sessionToken: "session-attached" },
    locale: "zh-CN",
  };
  const useRuntimeStore = <T,>(
    selector: (state: typeof runtimeState) => T,
  ): T => selector(runtimeState);
  useRuntimeStore.getState = () => runtimeState;
  return {
    useRuntimeStore,
    getRuntimeLocale: () => "zh-CN",
    getRuntimeBackendBaseUrl: () => "http://127.0.0.1:49454",
    getRuntimeProjectPath: () => "/tmp/mock.iartproj",
    getRuntimeProjectRef: () => null,
    getRuntimeSessionToken: () => "session-attached",
  };
});

vi.mock("@/client/config/models.config", () => ({
  listVisibleModelConfigs: () => mockListVisibleModelConfigs(),
}));

vi.mock("../../store/canvasStore", () => {
  const useCanvasStore = <T,>(selector: (state: MockCanvasState) => T) =>
    selector(mockCanvasState);
  useCanvasStore.getState = () => mockCanvasState;
  useCanvasStore.setState = (partial: Partial<MockCanvasState>) => {
    mockCanvasState = {
      ...mockCanvasState,
      ...partial,
    };
  };
  return {
    useCanvasStore,
    buildProjectDelta: () => ({ delta: null, expectedDirtyRevision: 0 }),
  };
});

vi.mock("../../storage", () => ({
  getCurrentProjectPath: vi.fn(async () => "/tmp/mock.iartproj"),
  getPendingNodeChangesSnapshot: mockGetPendingNodeChangesSnapshot,
  getProject: mockGetProject,
  discardPendingNodeChanges: mockDiscardPendingNodeChanges,
  enqueuePendingNodeChanges: mockEnqueuePendingNodeChanges,
  flushPendingNodeChanges: mockFlushPendingNodeChanges,
  openProjectSession: mockOpenProjectSession,
  reportProjectPresence: mockReportProjectPresence,
}));

vi.mock("../canvas/NodeCanvas", () => ({
  NodeCanvas: ({
    markStartupInteractiveReady,
  }: {
    markStartupInteractiveReady: (() => void) | undefined;
  }) => (
    <div data-testid="node-canvas">
      {markStartupInteractiveReady ? (
        <button
          type="button"
          data-testid="startup-readiness-trigger"
          onClick={() => {
            mockStartupProbeReady();
            markStartupInteractiveReady();
          }}
        >
          trigger-ready
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("../toolbar/CanvasToolbar", () => ({
  CanvasToolbar: ({ rightSlot }: { rightSlot?: React.ReactNode }) => (
    <div data-testid="canvas-toolbar">{rightSlot}</div>
  ),
}));

vi.mock("@/features/rightworkspace/RightWorkspace", () => ({
  RightWorkspace: () => <div data-testid="right-workspace" />,
}));

vi.mock("@/features/rightworkspace/PackageAreaToggleButton", () => ({
  PackageAreaToggleButton: () => null,
}));


vi.mock("../character", () => ({
  SaveCharacterDialog: () => null,
  CharacterLibraryDialog: () => null,
}));

vi.mock("@/client/components/AppQuickControls", () => ({
  AppQuickControls: () => null,
}));

const createGraph = () => ({
  id: "graph-1",
  nodes: [],
  edges: [],
});

const createOpenedPresenceResult = (
  overrides: Record<string, unknown> = {},
) => ({
  status: "ok" as const,
  sessionToken: "session-attached",
  project: {
    name: "mock-project",
    nodeGraph: createGraph(),
    mediaAssets: {},
    nodeGraphId: "graph-1",
    savedAt: 1,
    createdAt: 1,
    hasUnsavedChanges: false,
    path: "/tmp/mock.iartproj",
    nodeStateAuthority: {
      owner: "backend" as const,
      nodeGraphId: "graph-1",
      formalState: "backend_persisted" as const,
      hasPendingWrite: false,
      canResumePendingChanges: false,
      pendingChangeCount: 0,
    },
    ...overrides,
  },
});

const _createOpenedSessionResult = (
  overrides: Record<string, unknown> = {},
) => ({
  status: "ok" as const,
  sessionToken: "session-attached",
  project: createOpenedPresenceResult(overrides).project,
});

const _createPendingNodeStateAuthority = (nodeGraphId = "graph-1") => ({
  owner: "backend" as const,
  nodeGraphId,
  formalState: "backend_pending_write" as const,
  hasPendingWrite: true,
  canResumePendingChanges: true,
  pendingChangeCount: 1,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const settle = async (passes = 4) => {
  for (let index = 0; index < passes; index += 1) {
    await flush();
  }
};

const releaseEditorFromStartupProbe = async (
  view: ReturnType<typeof render>,
) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("startup-readiness-trigger"));
    view.rerender(<CanvasEditor />);
    vi.runAllTimers();
    await settle();
  });
};

describe("CanvasEditor - startup gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockTaskSyncStatus = { level: "idle", code: null, message: null, wsEventType: null };
    mockProjectStateSyncStatus = {
      level: "connected",
      code: "connected",
      message: "项目正式状态服务已连接。",
      wsEventType: null,
    };
    mockCanvasState = {
      nodeGraph: null,
      loadNodeGraph: vi.fn(async (graph: MockGraphSnapshot) => {
        mockCanvasState.nodeGraph = graph;
      }),
      setProjectMediaAssets: vi.fn(),
      syncPersistenceState: vi.fn(),
      commitDeferredHistoryBaseline: vi.fn(),
      pendingMediaMigrationNotice: null,
      clearPendingMediaMigrationNotice: vi.fn(),
    };
    mockGetPendingNodeChangesSnapshot.mockResolvedValue({
      key: "current",
      nodeGraph: createGraph(),
      savedAt: "2026-03-17T10:00:00.000Z",
      hasUnsavedChanges: false,
      nodeStateAuthority: {
        owner: "backend",
        nodeGraphId: "graph-1",
        formalState: "backend_persisted",
        hasPendingWrite: false,
        canResumePendingChanges: false,
        pendingChangeCount: 0,
      },
    });
    mockGetProject.mockResolvedValue({
      nodeGraph: createGraph(),
      nodeStateAuthority: {
        owner: "backend",
        nodeGraphId: "graph-1",
        formalState: "backend_persisted",
        hasPendingWrite: false,
        canResumePendingChanges: false,
        pendingChangeCount: 0,
      },
    });
    mockDiscardPendingNodeChanges.mockResolvedValue({
      nodeGraph: createGraph(),
      nodeStateAuthority: {
        owner: "backend",
        nodeGraphId: "graph-1",
        formalState: "backend_persisted",
        hasPendingWrite: false,
        canResumePendingChanges: false,
        pendingChangeCount: 0,
      },
    });
    mockReportProjectPresence.mockResolvedValue(createOpenedPresenceResult());
    mockOpenProjectSession.mockResolvedValue({
      status: "ok",
      sessionToken: "session-attached",
      project: null,
    });
    mockListVisibleModelConfigs.mockReturnValue([
      { modelId: "mock-model", visible: true },
    ]);
    vi.stubGlobal("fetch", mockFetch);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: mockSendBeacon,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
    consoleErrorSpy.mockRestore();
  });

  it("会先完成建链和项目 open，准备阶段和 waiting-interactive 都不挂正式 editor，直到 startupReady 才放出 editor", async () => {
    const view = render(<CanvasEditor />);

    await act(async () => {
      await settle();
    });

    expect(screen.getByText("正在同步任务状态")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("node-canvas")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-workspace")).not.toBeInTheDocument();
    expect(mockGetProject).toHaveBeenCalledWith(
      "/tmp/mock.iartproj",
      undefined,
    );
    expect(mockUseCanvasHotkeys).not.toHaveBeenCalled();
    expect(mockUseCanvasTaskIndexSync).toHaveBeenLastCalledWith(
      "graph-1",
      expect.objectContaining({ enabled: true }),
    );

    mockTaskSyncStatus = {
      level: "connected",
      code: "connected",
      message: "任务状态服务已连接。",
      wsEventType: null,
    };
    view.rerender(<CanvasEditor />);

    await act(async () => {
      await settle();
    });

    expect(mockGetProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在完成最后检查")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-shell")).not.toBeInTheDocument();
    // waiting-interactive 阶段会挂载一个隐藏的 NodeCanvas 用于启动自检（spec：
    // layout-model-driven 启动收敛）。它暴露 startup-readiness-trigger，但还没有点击。
    expect(
      screen.getByTestId("startup-readiness-trigger"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("canvas-toolbar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-workspace")).not.toBeInTheDocument();
    expect(mockStartupProbeReady).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(30000);
      await settle();
    });

    expect(screen.getByText("正在完成最后检查")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-shell")).not.toBeInTheDocument();
    expect(mockStartupProbeReady).not.toHaveBeenCalled();

    await releaseEditorFromStartupProbe(view);

    expect(screen.getByTestId("editor-shell")).toBeInTheDocument();
    expect(screen.getByTestId("node-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("right-workspace")).toBeInTheDocument();
    expect(mockUseAutoSave).toHaveBeenCalled();
    expect(mockUseCanvasHotkeys).toHaveBeenCalled();
  });
  // 旧用例「只有当前启动探针回报匹配 token 时才能放行」已下线：
  // markStartupInteractiveReady 是无参回调，控制器内部从 store / runtime 镜像注入
  // graphId / sessionToken，不再有外部注入伪造 token 的入口（spec：layout-model-driven 启动收敛）。

});
