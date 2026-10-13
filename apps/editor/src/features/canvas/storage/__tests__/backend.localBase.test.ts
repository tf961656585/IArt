import { beforeEach, describe, expect, it, vi } from "vitest";
import { cast } from "@/lib/utils";
import type { ElectronBridge } from "@/client/utils/electronBridge";

const _storageMock = vi.fn();
const createStorageChannelMock = () => {
  const channels: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    getChannel: (channel: string) => {
      if (!channels[channel]) {
        channels[channel] = vi.fn();
      }
      return channels[channel];
    },
    install: () => {
      cast<Window & { electron: ElectronBridge }>(window).electron = cast<ElectronBridge>({
        storage: new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
          get: (_target, prop: string) => {
            if (!channels[prop]) {
              channels[prop] = vi.fn();
            }
            return channels[prop];
          },
        }),
        getCurrentProjectPath: vi.fn(async () => "/tmp/mock.iartproj"),
        setCurrentProjectPath: vi.fn(async () => undefined),
      });
    },
    channels,
  };
};

const electronBridgeMock = {
  getCurrentProjectPathFromElectron: vi.fn<() => Promise<string | null>>(async () => null),
  setCurrentProjectPathToElectron: vi.fn<(path: string | null) => Promise<void>>(async () => undefined),
};

vi.mock("@/client/utils/electronBridge", () => electronBridgeMock);

const loadModules = async () => {
  vi.resetModules();
  vi.doMock("@/client/utils/electronBridge", () => electronBridgeMock);
  const backend = await import("../backend");
  // projectPath 状态所有权在 runtimeStore，backend 经由同一模块实例读取
  const { useRuntimeStore } = await import("@/client/store/runtimeStore");
  useRuntimeStore.setState({ projectPath: "/tmp/mock.iartproj" });
  return backend;
};

describe("canvas storage backend IPC 模式", () => {
  let storageHelper: ReturnType<typeof createStorageChannelMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    storageHelper = createStorageChannelMock();
    storageHelper.install();
    electronBridgeMock.getCurrentProjectPathFromElectron.mockResolvedValue(
      "/tmp/mock.iartproj",
    );
    electronBridgeMock.setCurrentProjectPathToElectron.mockResolvedValue(
      undefined,
    );
  });

  it("listProjects 应通过 IPC 调 storage:list-projects", async () => {
    const { listProjects } = await loadModules();
    storageHelper.getChannel("storage:list-projects").mockResolvedValue({
      projects: [
        { path: "/tmp/demo.iartproj", name: "demo", nodeGraphId: "graph-1" },
      ],
    });

    const projects = await listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ path: "/tmp/demo.iartproj" });
    expect(storageHelper.getChannel("storage:list-projects")).toHaveBeenCalledTimes(1);
  });

  it("getProject 应通过 IPC 调 storage:get-project", async () => {
    const { getProject } = await loadModules();
    storageHelper.getChannel("storage:get-project").mockResolvedValue({
      project: {
        id: "demo",
        name: "demo",
        nodeGraph: { id: "graph-1", nodes: [] },
        mediaAssets: {},
      },
    });

    const project = await getProject("/tmp/demo.iartproj", undefined);

    expect(project).not.toBeNull();
    expect(storageHelper.getChannel("storage:get-project")).toHaveBeenCalledWith({
      projectPath: "/tmp/demo.iartproj",
      allowEmpty: false,
    });
  });

  it("getProject 传空路径返回 null", async () => {
    const { getProject } = await loadModules();

    const project = await getProject("", undefined);

    expect(project).toBeNull();
    expect(storageHelper.getChannel("storage:get-project")).not.toHaveBeenCalled();
  });

  it("createProject 应通过 IPC 调 storage:create-project 并设置项目路径", async () => {
    const { createProject } = await loadModules();
    storageHelper.getChannel("storage:create-project").mockResolvedValue({
      projectPath: "/tmp/created.iartproj",
      project: {
        id: "created",
        name: "new-project",
        nodeGraph: null,
        mediaAssets: {},
      },
    });

    const result = await createProject("/tmp", "new-project", undefined, {});

    expect(result.projectPath).toBe("/tmp/created.iartproj");
    expect(electronBridgeMock.setCurrentProjectPathToElectron).toHaveBeenCalledWith(
      "/tmp/created.iartproj",
    );
  });

  it("saveProjectDelta 应通过 IPC 调 storage:save-delta", async () => {
    const { saveProjectDelta } = await loadModules();
    const mockPersistenceState = {
      hasPendingWrite: true,
      lastPersistedAt: Date.now(),
    };
    storageHelper.getChannel("storage:save-delta").mockResolvedValue({
      persistenceState: mockPersistenceState,
    });

    const result = await saveProjectDelta("/tmp/demo.iartproj", {
      nodeGraphId: "graph-1",
      fullReplace: undefined,
      graph: undefined,
      nodes: { upsert: undefined, remove: ["node-1"] },
    });

    expect(result.ok).toBe(true);
    expect(result.persistenceState).toEqual(mockPersistenceState);
    expect(storageHelper.getChannel("storage:save-delta")).toHaveBeenCalledWith({
      projectPath: "/tmp/demo.iartproj",
      delta: {
        nodeGraphId: "graph-1",
        fullReplace: undefined,
        graph: undefined,
        nodes: { upsert: undefined, remove: ["node-1"] },
        },
    });
  });

  it("flushProject 应通过 IPC 调 storage:flush", async () => {
    const { flushProject } = await loadModules();
    storageHelper.getChannel("storage:flush").mockResolvedValue({
      persistenceState: { hasPendingWrite: false },
    });

    const result = await flushProject("/tmp/demo.iartproj");

    expect(result.ok).toBe(true);
    expect(storageHelper.getChannel("storage:flush")).toHaveBeenCalledWith({
      projectPath: "/tmp/demo.iartproj",
    });
  });

  it("deleteProject 应通过 IPC 调 storage:delete-project", async () => {
    const { deleteProject } = await loadModules();
    storageHelper.getChannel("storage:delete-project").mockResolvedValue({});

    await deleteProject("/tmp/demo.iartproj");

    expect(storageHelper.getChannel("storage:delete-project")).toHaveBeenCalledWith({
      projectPath: "/tmp/demo.iartproj",
    });
  });

  it("discardPendingNodeChanges 应通过 IPC 调 storage:discard-pending", async () => {
    const { discardPendingNodeChanges } = await loadModules();
    storageHelper.getChannel("storage:discard-pending").mockResolvedValue({
      project: {
        id: "demo",
        name: "demo",
        nodeGraph: { id: "graph-1", nodes: [] },
        mediaAssets: {},
      },
    });

    const project = await discardPendingNodeChanges();

    expect(project).not.toBeNull();
    expect(storageHelper.getChannel("storage:discard-pending")).toHaveBeenCalledWith({
      projectPath: "/tmp/mock.iartproj",
    });
  });

  it("getPendingNodeChangesSnapshot 应通过 IPC 调 storage:get-pending-snapshot", async () => {
    const { getPendingNodeChangesSnapshot } = await loadModules();
    storageHelper.getChannel("storage:get-pending-snapshot").mockResolvedValue({
      snapshot: {
        key: "current",
        nodeGraph: { id: "graph-1", nodes: [] },
        savedAt: "2026-03-17T10:00:00.000Z",
        hasUnsavedChanges: false,
      },
    });

    const snapshot = await getPendingNodeChangesSnapshot();

    expect(snapshot).not.toBeNull();
    expect(snapshot?.key).toBe("current");
    expect(storageHelper.getChannel("storage:get-pending-snapshot")).toHaveBeenCalledWith({
      projectPath: "/tmp/mock.iartproj",
    });
  });

  it("openProjectSession 返回 { status: 'ok' }（空壳兼容）", async () => {
    const { openProjectSession } = await loadModules();

    const result = await openProjectSession("/tmp/demo.iartproj");

    expect(result).toEqual({ status: "ok" });
  });

  it("reportProjectPresence 返回 { status: 'ok' }（空壳兼容）", async () => {
    const { reportProjectPresence } = await loadModules();

    const result = await reportProjectPresence("/tmp/demo.iartproj", "open");

    expect(result).toEqual({ status: "ok" });
  });

  it("IPC channel 不可用时应抛出错误", async () => {
    const { listProjects } = await loadModules();
    // 不设置 mock 返回值，channel 函数不存在
    Reflect.deleteProperty(
      (window as Window & { electron?: unknown }).electron as Record<string, unknown>,
      "storage",
    );

    await expect(listProjects()).rejects.toThrow("无法读写本地数据，请重启应用后再试。");
  });
});
