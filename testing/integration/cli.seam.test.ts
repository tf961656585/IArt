// @vitest-environment node
// @spec: CLI-005, CLI-007, CLI-008, CLI-010, CLI-012, CLI-014, CLI-020, CLI-021, CLI-027, CLI-030
//
// CLI 与本地 Agent 集成 · 主链接缝测试（spec docs/integrations/CLI与本地Agent集成.md
// §4 架构 / §6 通道契约 / §10 边界条件）。
//
// 使命：在没有真实 Electron 运行时的前提下，把「CLI 客户端 → 本地控制服务 → 执行器 →
// 代理执行通道 → 画布窗口接收器 → 程序化提交」主链首尾真实跑通一遍。两端都是真实实现：
// - CLI 客户端 / 控制服务 / 执行器 / 代理分发器：desktop-shell 编译产物 dist/cli/*.cjs
//   （经 createRequire 加载；源码 .cts 的内部 import 指向 .cjs 构建产物，无法直接 import 源码，
//   与 apps/desktop-shell/src/__tests__/cli-*.test.mts 同口径）；
// - Editor 接收器 / 程序化提交 / canvasStore / promptDockStore / runtimeStore：apps/editor 源码
//   经 vitest `@` alias 直接 import（node 环境可用，已探针核实）。
//
// 只在最外层挡掉真实边界（假替身清单）：
// - Electron 窗口传输层（webContents.send / ipcMain.on）：假传输层直通——捕获分发器发出的
//   命令载荷喂给真实 handleCliProxyPayload，接收器的 send 回调原样回注真实
//   dispatcher.consumeResponsePayload（红→绿断链注入点就在这一腿）；
// - promptDockApi HTTP 边界（submitGenerationBatch / cancelTask）：vi.mock，受理响应按
//   PromptDockBatchSubmitResponseSchema 字段构造并当场 parse（真实响应喂消费端同一份契约
//   schema 的合法形态：字段从 schema 产生、边界 parse 为真）；
// - 主进程存储服务与 recent-projects 注册表：临时目录 fixture + 假存储适配（创建链重名守卫
//   属存储服务职责，此处按其契约抛 PROJECT_NAME_CONFLICT）。
//
// 输入从真实链路源头产生：建组成员 id 经真实 canvasStore.addNode action 创建后从 store 读回，
// 不手工捏造 id 直塞断言层。

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CliCommandResponseSchema,
  PromptDockBatchSubmitResponseSchema,
  TaskCancelAcceptedResponseSchema,
  type CliCommandResponse,
  type CliProxyCommandResponse,
} from '@iart/contracts';

// promptDockApi 是 Editor 侧的 HTTP 边界（submitGenerationBatch / cancelTask）：本接缝在这条
// 边界上用替身承载「真实形状的受理/取消响应」，其余（前置校验、受理回执投影、画布 action）
// 全部走真实实现。工厂只提供被消费的两个导出（沿 cliProxyReceiver.generate.test.ts 惯例）。
// guard-seam-mock-exempt: 外部 HTTP 边界替身——被测主链两端真实，仅 HTTP facade 按 schema 真实形态替身；消除条件：promptDockApi 改为可注入 fetch 上游后移除本替身
vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  cancelTask: vi.fn(),
  submitGenerationBatch: vi.fn(),
}));

import { cancelTask, submitGenerationBatch } from '@/client/api/promptDockApi';
import { useRuntimeStore } from '@/client/store/runtimeStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { TaskNodeData } from '@/features/canvas/types/node';
import { handleCliProxyPayload } from '@/features/canvas/services/cliProxyReceiver';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';

// ---------------------------------------------------------------------------
// desktop-shell 侧真实实现（dist 编译产物）
// ---------------------------------------------------------------------------

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const clientEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client.cjs`;
const serviceEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-control-service.cjs`;
const dispatcherEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-proxy-dispatcher.cjs`;

type CliClientRunResult = { exitCode: number; stdout: string; stderr: string };
type ClientModule = {
  runCliClient: (
    argv: readonly string[],
    deps?: { discoveryFilePath?: string; fetchImpl?: typeof fetch; pollIntervalMs?: number },
  ) => Promise<CliClientRunResult>;
};
type ServiceHandle = {
  port: number;
  discoveryFilePath: string;
  stop: () => Promise<void>;
  getCommandLog: () => readonly unknown[];
};
type ServiceModule = {
  startCliControlService: (options: Record<string, unknown>) => Promise<ServiceHandle>;
};
type ProxyDispatchOutcome =
  | { ok: true; response: CliProxyCommandResponse }
  | { ok: false; reason: 'no_window' | 'invalid_command' | 'duplicate_request_id'; detail: string };
type DispatcherModule = {
  createCliProxyDispatcher: (deps: {
    getWindow: (projectPath: string) => {
      sendCommand: (payload: unknown) => void;
      onClosed: (listener: () => void) => void;
    } | null;
    newRequestId?: () => string;
  }) => {
    dispatch: (
      projectPath: string,
      candidate: Record<string, unknown>,
    ) => Promise<ProxyDispatchOutcome>;
    consumeResponsePayload: (payload: unknown) => void;
  };
};

const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;
const loadServiceModule = (): ServiceModule => requireDesktop(serviceEntry) as ServiceModule;
const loadDispatcherModule = (): DispatcherModule =>
  requireDesktop(dispatcherEntry) as DispatcherModule;

// ---------------------------------------------------------------------------
// 假 Electron 传输层（webContents.send / ipcMain.on 的替身，含断链注入点）
// ---------------------------------------------------------------------------

type TransportMode = 'pass' | 'drop' | 'wrong_request_id';

type ProxyWiring = {
  /** 真实分发器（desktop-shell dist 产物）。 */
  dispatcher: ReturnType<DispatcherModule['createCliProxyDispatcher']>;
  /** 主进程 → 画布窗口方向捕获的命令载荷（webContents.send 的替身捕获）。 */
  capturedRequests: unknown[];
  /** 画布窗口 → 主进程方向捕获的响应载荷（sendCliProxyResponse 的替身捕获）。 */
  capturedResponses: unknown[];
  setMode: (mode: TransportMode) => void;
};

const createProxyWiring = (isOpenProject: (projectPath: string) => boolean): ProxyWiring => {
  const capturedRequests: unknown[] = [];
  const capturedResponses: unknown[] = [];
  let mode: TransportMode = 'pass';
  const dispatcherModule = loadDispatcherModule();
  const dispatcher = dispatcherModule.createCliProxyDispatcher({
    getWindow: (projectPath) => {
      if (!isOpenProject(projectPath)) return null;
      return {
        // 假 webContents.send：捕获载荷 → 直通喂给真实 Editor 接收器
        sendCommand: (payload) => {
          capturedRequests.push(payload);
          void handleCliProxyPayload(payload, (response) => {
            capturedResponses.push(response);
            if (mode === 'drop') return; // 断链注入点 1：响应不回注主进程
            const outbound =
              mode === 'wrong_request_id'
                ? // 断链注入点 2：request_id 改错（配对失败）
                  { ...response, request_id: 'seam-wrong-request-id' }
                : response;
            // 假 ipcMain.on(CLI_PROXY_RESPONSE_CHANNEL)：响应回注真实分发器配对
            dispatcher.consumeResponsePayload(outbound);
          });
        },
        onClosed: () => undefined,
      };
    },
  });
  return { dispatcher, capturedRequests, capturedResponses, setMode: (next) => (mode = next) };
};

// ---------------------------------------------------------------------------
// 临时数据根：recent-projects 注册表 fixture + 项目目录
// ---------------------------------------------------------------------------

interface FixtureEntry {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt?: number | null;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-seam-'));
const registryFixturePath = path.join(tempRoot, 'recent-projects.json');
const projectsRoot = path.join(tempRoot, 'projects');
const openProjectDir = path.join(projectsRoot, 'opened-project');
const closedProjectDir = path.join(projectsRoot, 'closed-project');
const OPEN_PROJECT_NAME = '接缝打开项目';
const CLOSED_PROJECT_NAME = '接缝关闭项目';
const baseRegistryEntries = (): FixtureEntry[] => [
  {
    nodeGraphId: 'ng-seam-open',
    name: OPEN_PROJECT_NAME,
    path: openProjectDir,
    createdAt: 1,
    savedAt: 2,
    lastOpenedAt: 1700000000000,
  },
  {
    nodeGraphId: 'ng-seam-closed',
    name: CLOSED_PROJECT_NAME,
    path: closedProjectDir,
    createdAt: 3,
    savedAt: 4,
    lastOpenedAt: null,
  },
];

const writeRegistryFixture = (entries: FixtureEntry[]): void => {
  fs.writeFileSync(registryFixturePath, JSON.stringify(entries, null, 2), 'utf-8');
};
const readRegistryFixture = (): FixtureEntry[] =>
  JSON.parse(fs.readFileSync(registryFixturePath, 'utf-8')) as FixtureEntry[];

/**
 * 项目「已打开」状态（executor 的 hasOpenWindow 与分发器 getWindow 共用）。
 * app status（链路 D）扩展：多项目并存集合、查询时点焦点与画布加载态。
 */
const seamState: {
  openWindowProjectPath: string | null;
  extraOpenProjectPaths: string[];
  canvasLoading: boolean;
  focusedProjectPath: string | null;
} = {
  openWindowProjectPath: null,
  extraOpenProjectPaths: [],
  canvasLoading: false,
  focusedProjectPath: null,
};

// ---------------------------------------------------------------------------
// 执行器依赖（数据源与执行后端注入面）
// ---------------------------------------------------------------------------

const buildExecutorDeps = (proxyWiring: ProxyWiring): Record<string, unknown> => ({
  // 注册表数据源：临时 recent-projects.json fixture（真实文件 IO 往返）
  readProjects: () => readRegistryFixture(),
  windows: {
    openOrFocus: async () => ({ ok: true as const }),
    hasOpenWindow: (projectPath: string) => seamState.openWindowProjectPath === projectPath,
    closeByProjectPath: () => {
      seamState.openWindowProjectPath = null;
      return true;
    },
    // app status 数据源（CLI-020/021）：枚举已打开项目快照；焦点与加载态按查询时点由
    // seamState 承载（真实 BrowserWindow.isFocused/isLoading 的替身事实源）。
    listOpenEditorProjects: () => {
      const paths = [seamState.openWindowProjectPath, ...seamState.extraOpenProjectPaths].filter(
        (candidate): candidate is string => candidate !== null,
      );
      return paths.map((projectPath) => ({
        projectPath,
        focused: seamState.focusedProjectPath === projectPath,
        canvasLoading: seamState.canvasLoading,
      }));
    },
  },
  // 运行域转发端点：本接缝三条链路都不触达（有窗取消走代理通道；status/wait 不在范围），
  // 注入恒失败并留痕，若被意外触达会在断言中显形。
  forwarder: {
    getJson: async (pathname: string) => ({
      ok: false as const,
      reason: 'network_error',
      detail: `seam: forwarder not wired (${pathname})`,
    }),
    postJson: async (pathname: string, body: unknown) => {
      console.debug('[cli-seam] forwarder.postJson unexpectedly called', { pathname, body });
      return {
        ok: false as const,
        reason: 'network_error',
        detail: `seam: forwarder not wired (${pathname})`,
      };
    },
  },
  storage: {
    // 既有创建链的重名守卫契约：目标位置已存在同名项目目录时抛 PROJECT_NAME_CONFLICT
    // （守卫实现属主进程存储服务，单层归其测试；本接缝验证 CLI 面的错误映射与目录不变性）。
    createProject: (params: { parentDir: string; name: string }) => {
      const target = path.join(params.parentDir, params.name);
      if (fs.existsSync(target)) {
        throw new Error('PROJECT_NAME_CONFLICT');
      }
      fs.mkdirSync(target);
      const entries = readRegistryFixture();
      entries.unshift({
        nodeGraphId: `ng-${Date.now()}`,
        name: params.name,
        path: target,
        createdAt: Date.now(),
        savedAt: Date.now(),
        lastOpenedAt: null,
      });
      writeRegistryFixture(entries);
      return { projectPath: target };
    },
    deleteProject: (params: { projectPath: string }) => {
      writeRegistryFixture(readRegistryFixture().filter((entry) => entry.path !== params.projectPath));
    },
    touchProjectOpenedAt: (projectPath: string, openedAt: number) => {
      const entries = readRegistryFixture();
      const entry = entries.find((candidate) => candidate.path === projectPath);
      if (entry) entry.lastOpenedAt = openedAt;
      writeRegistryFixture(entries);
    },
    readMediaAssets: () => [],
    readMediaAssetById: () => null,
    readAssetTaskIndex: () => new Map<string, string>(),
    readTaskOutputAssets: () => [],
    readCanvasNodePayloads: () => [],
  },
  proxy: {
    dispatch: (projectPath: string, candidate: Record<string, unknown>) =>
      proxyWiring.dispatcher.dispatch(projectPath, candidate),
  },
  pollIntervalMs: 10,
});

// ---------------------------------------------------------------------------
// 生命周期与种床
// ---------------------------------------------------------------------------

let service: ServiceHandle;
let client: ClientModule;
let sharedWiring: ProxyWiring;

const runCli = (argv: readonly string[]): Promise<CliClientRunResult> =>
  client.runCliClient(argv, {
    discoveryFilePath: service.discoveryFilePath,
    pollIntervalMs: 10,
  });

/** CLI --json 成功输出 = 完整 CliCommandResponse，逐条过契约 schema（CLI-014 客户端侧断言口径）。 */
const parseCliResponse = (result: CliClientRunResult): CliCommandResponse => {
  // JSON.parse 按 TS lib 返回 any：先显式收窄为 unknown，形状由下方契约 schema parse 验证
  //（仓库类型纪律：JSON.parse 结果不经断言直接使用会静默放行非法形状）。
  const raw: unknown = JSON.parse(result.stdout);
  const parsed = CliCommandResponseSchema.parse(raw);
  expect(parsed).toEqual(raw);
  return parsed;
};

/**
 * CLI --json 失败输出形状（沿 apps/desktop-shell/src/__tests__/cli-client.test.mts 口径）：
 * { ok:false, error:{code,message} }（不带 command 字段）。完整 CliCommandResponse 的两端
 * schema 校验由真实链路内嵌承载：服务端出站 safeParse（非法即 500 兜底）+ 客户端响应
 * safeParse（非法即退出码 2）——错误码能出现在 stdout 即已穿过两层真实契约校验。
 */
const parseCliFailure = (result: CliClientRunResult): { code: string; message: string } => {
  const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
  expect(body.ok).toBe(false);
  return body.error;
};

const cancelTaskMock = vi.mocked(cancelTask);
const submitGenerationBatchMock = vi.mocked(submitGenerationBatch);

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-seam',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStores = async (): Promise<void> => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
  });
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
  useCanvasStore.setState((state) => {
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
  usePromptDockStore.setState({
    form: 'generate',
    catalog: [],
    catalogLoaded: true,
    submitting: false,
    preflightIssues: null,
    draft: {
      modelId: null,
      modelVersion: null,
      prompt: '',
      arguments: {},
      references: [],
      promptPresetSnapshots: undefined,
      taskCount: 1,
    },
  });
  useRuntimeStore.setState({
    backendBaseUrl: 'http://127.0.0.1:51999',
    projectPath: openProjectDir,
  });
};

/** 真实链路源头造成员节点：经真实 addNode action 创建，id 从 store 读回。 */
const createMemberNodeViaStoreAction = (x: number, y: number): string => {
  const created = useCanvasStore.getState().addNode('asset', { x, y }, undefined, undefined);
  if (created === null) throw new Error('addNode failed to create asset node');
  const graph = useCanvasStore.getState().nodeGraph;
  const node = graph?.nodes.find((candidate) => candidate.id === created.id);
  if (!node) throw new Error('created node missing from store');
  return node.id;
};

const groupNodes = () =>
  (useCanvasStore.getState().nodeGraph?.nodes ?? []).filter((node) => node.type === 'group');

const findTaskNodeData = (taskId: string): TaskNodeData | null => {
  const node = (useCanvasStore.getState().nodeGraph?.nodes ?? []).find(
    (candidate) => candidate.type === 'task' && (candidate.data as TaskNodeData).taskId === taskId,
  );
  return node ? (node.data as TaskNodeData) : null;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 有限等待观察分发器是否收口：断链时 pending 永不 resolve（内部通信不设超时，测试用有限等待观察）。 */
const settleWithin = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<'settled' | 'pending'> =>
  Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    sleep(ms).then(() => 'pending' as const),
  ]);

beforeAll(async () => {
  fs.mkdirSync(openProjectDir, { recursive: true });
  fs.mkdirSync(closedProjectDir, { recursive: true });
  writeRegistryFixture(baseRegistryEntries());

  client = loadClientModule();
  // 开窗判据含多项目并存集合（链路 D）：主开窗项目 + extraOpenProjectPaths
  sharedWiring = createProxyWiring(
    (projectPath) =>
      seamState.openWindowProjectPath === projectPath || seamState.extraOpenProjectPaths.includes(projectPath),
  );
  const serviceModule = loadServiceModule();
  service = await serviceModule.startCliControlService({
    port: 0,
    discoveryFilePath: path.join(tempRoot, 'cli-discovery.json'),
    version: 'seam-test',
    executorDeps: buildExecutorDeps(sharedWiring),
  });
});

afterAll(async () => {
  await service.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  writeRegistryFixture(baseRegistryEntries());
  seamState.openWindowProjectPath = openProjectDir;
  seamState.extraOpenProjectPaths = [];
  seamState.canvasLoading = false;
  seamState.focusedProjectPath = openProjectDir;
  cancelTaskMock.mockReset();
  submitGenerationBatchMock.mockReset();
  await resetStores();
});

// ---------------------------------------------------------------------------
// 链路 A：Main 直链（项目生命周期 + 重名守卫）
// ---------------------------------------------------------------------------

describe('链路 A：CLI 客户端 → 真实控制服务 → 项目生命周期执行器', () => {
  it('project create 目标目录已存在同名项目目录 → project_name_conflict 且既有目录内容与注册表不变（CLI-005 主链）', async () => {
    const conflictDir = path.join(projectsRoot, '重名项目');
    fs.mkdirSync(conflictDir, { recursive: true });
    fs.writeFileSync(path.join(conflictDir, '既有内容.txt'), 'must-survive', 'utf-8');
    const registryBefore = readRegistryFixture();

    const result = await runCli(['project', 'create', '--name', '重名项目', '--path', projectsRoot, '--json']);

    expect(result.exitCode).toBe(1);
    const error = parseCliFailure(result);
    expect(error.code).toBe('project_name_conflict');
    expect(error.message).toContain('同名项目');
    // 既有目录内容不变：marker 原样、无新增文件；注册表 fixture 无新增条目
    expect(fs.readdirSync(conflictDir)).toEqual(['既有内容.txt']);
    expect(fs.readFileSync(path.join(conflictDir, '既有内容.txt'), 'utf-8')).toBe('must-survive');
    expect(readRegistryFixture()).toEqual(registryBefore);
  });

  it('project create 无冲突 → 创建成功且出现在注册表 fixture（CLI-005 成功半边）', async () => {
    const result = await runCli(['project', 'create', '--name', '全新项目', '--path', projectsRoot, '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'project.create') {
      throw new Error(`expected project.create success response, got ${result.stdout}`);
    }
    expect(response.project).toEqual({ name: '全新项目', path: path.join(projectsRoot, '全新项目') });
    expect(fs.existsSync(path.join(projectsRoot, '全新项目'))).toBe(true);
    expect(readRegistryFixture().some((entry) => entry.name === '全新项目')).toBe(true);
  });

  it('project list → 响应含 fixture 项目，两端 schema 校验（服务端出站校验 + 客户端响应 parse）', async () => {
    const result = await runCli(['project', 'list', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'project.list') {
      throw new Error(`expected project.list success response, got ${result.stdout}`);
    }
    const openEntry = response.projects.find((project) => project.name === OPEN_PROJECT_NAME);
    expect(openEntry).toMatchObject({ path: openProjectDir, last_opened_at: 1700000000000 });
    // 客户端侧契约校验是真实实现的内嵌行为：响应非法时 runCliClient 以退出码 2 拒绝，
    // 走不到这里——上面的 parseCliResponse 断言 stdout 本身就是契约形状。
  });
});

// ---------------------------------------------------------------------------
// 链路 B：代理执行链（CLI → 控制服务 → 执行器 → 分发器 → 假传输层 → 真实接收器 → 回注）
// ---------------------------------------------------------------------------

describe('链路 B：代理执行通道断链敏感性（红→绿自证）', () => {
  it('假传输层丢弃响应回注 → 分发器 pending 永不收口；request_id 改错被丢弃且留痕', async () => {
    // 专用分发器/传输层：悬挂的 pending 不影响共享接缝
    const brokenWiring = createProxyWiring((projectPath) => seamState.openWindowProjectPath === projectPath);
    brokenWiring.setMode('drop');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const first = brokenWiring.dispatcher
        .dispatch(openProjectDir, { command: 'canvas.group.create', name: '红证组', members: ['ghost-node'] })
        .catch(() => undefined);
      // Editor 接收器真实执行并产出了响应（成员不存在 → node_not_found），但回注腿被掐断
      await sleep(50);
      expect(brokenWiring.capturedResponses).toHaveLength(1);
      expect(brokenWiring.capturedResponses[0]).toMatchObject({
        command: 'canvas.group.create',
        error: { code: 'node_not_found' },
      });
      await expect(settleWithin(first, 250)).resolves.toBe('pending');

      // 断链注入点 2：响应回注但 request_id 改错 → 无配对挂起命令，丢弃 + debug 留痕
      brokenWiring.setMode('wrong_request_id');
      const second = brokenWiring.dispatcher
        .dispatch(openProjectDir, { command: 'canvas.group.create', name: '红证组二', members: ['ghost-node'] })
        .catch(() => undefined);
      await sleep(50);
      expect(brokenWiring.capturedResponses).toHaveLength(2);
      await expect(settleWithin(second, 250)).resolves.toBe('pending');
      expect(
        debugSpy.mock.calls.some((call) =>
          String(call[0]).includes('响应 request_id 无配对挂起命令，丢弃'),
        ),
      ).toBe(true);

      // 清理：用捕获到的真实响应（正确 request_id）收口两条悬挂 pending，避免跨用例悬挂
      brokenWiring.setMode('pass');
      for (const response of brokenWiring.capturedResponses) {
        brokenWiring.dispatcher.consumeResponsePayload(response);
      }
      await expect(first).resolves.toMatchObject({
        ok: true,
        response: { command: 'canvas.group.create', error: { code: 'node_not_found' } },
      });
      await expect(second).resolves.toMatchObject({
        ok: true,
        response: { command: 'canvas.group.create', error: { code: 'node_not_found' } },
      });
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe('链路 B：画布命令 / 任务取消全链', () => {
  it('canvas group create 全链：真实 store 建成员 → CLI → 控制服务 → 分发器 → 接收器建组 → 响应回 CLI（CLI-010 主链）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10);
    const requestsBefore = sharedWiring.capturedRequests.length;

    const result = await runCli([
      'canvas',
      'group',
      'create',
      '--project',
      OPEN_PROJECT_NAME,
      '--name',
      '接缝组',
      '--members',
      `${memberA},${memberB}`,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.group.create') {
      throw new Error(`expected canvas.group.create success response, got ${result.stdout}`);
    }
    // 分发器真实发出了命令载荷（主进程 → 画布窗口腿）
    expect(sharedWiring.capturedRequests.length).toBe(requestsBefore + 1);
    // 新组 id 即真实 store 中创建的组节点 id；成员归属指向新组
    const graph = useCanvasStore.getState().nodeGraph;
    const groupNode = graph?.nodes.find((candidate) => candidate.id === response.group_node_id);
    expect(groupNode?.type).toBe('group');
    expect(groupNodes()).toHaveLength(1);
    expect(graph?.nodes.find((candidate) => candidate.id === memberA)?.groupId).toBe(
      response.group_node_id,
    );
    expect(graph?.nodes.find((candidate) => candidate.id === memberB)?.groupId).toBe(
      response.group_node_id,
    );
    // 组名经 renameGroup 落到组节点（CLI-010 与画布节点组 spec 同语义）
    expect((groupNode?.data as { name?: string }).name).toBe('接缝组');
  });

  it('canvas group dissolve 全链：CLI 建组 → CLI 解散 → 组节点删除、成员保留原位且归属解除（CLI-027 主链）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10);
    const created = await runCli([
      'canvas', 'group', 'create',
      '--project', OPEN_PROJECT_NAME,
      '--name', '待解散组',
      '--members', `${memberA},${memberB}`,
      '--json',
    ]);
    expect(created.exitCode).toBe(0);
    const createdResponse = parseCliResponse(created);
    if (!createdResponse.ok || createdResponse.command !== 'canvas.group.create') {
      throw new Error(`expected canvas.group.create success response, got ${created.stdout}`);
    }
    const groupId = createdResponse.group_node_id;
    expect(useCanvasStore.getState().nodeGraph?.nodes.find((c) => c.id === memberA)?.groupId).toBe(groupId);
    // 解散走真实全链：CLI → 控制服务 → 分发器 → 接收器 → 删除咽喉 removeNodes
    const dissolved = await runCli([
      'canvas', 'group', 'dissolve',
      '--project', OPEN_PROJECT_NAME,
      '--group', groupId,
      '--json',
    ]);
    expect(dissolved.exitCode).toBe(0);
    const response = parseCliResponse(dissolved);
    if (!response.ok || response.command !== 'canvas.group.dissolve') {
      throw new Error(`expected canvas.group.dissolve success response, got ${dissolved.stdout}`);
    }
    expect(response.dissolved).toBe(true);
    expect(response.group_node_id).toBe(groupId);
    expect(response.member_ids).toEqual([memberA, memberB]);
    // 解散语义（画布节点组 spec「解散」）：组节点删除，成员保留原位、归属解除
    const graph = useCanvasStore.getState().nodeGraph;
    expect(graph?.nodes.find((c) => c.id === groupId)).toBeUndefined();
    expect(groupNodes()).toHaveLength(0);
    expect(graph?.nodes.find((c) => c.id === memberA)).toMatchObject({ groupId: undefined, position: { x: 10, y: 10 } });
    expect(graph?.nodes.find((c) => c.id === memberB)).toMatchObject({ groupId: undefined, position: { x: 300, y: 10 } });
  });

  it('canvas layout --order 全链：CLI 建组建员 → 显式顺序整理组内 → 成员按指定序占格（CLI-030 主链）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10), memberC = createMemberNodeViaStoreAction(600, 10);
    const created = await runCli([
      'canvas', 'group', 'create',
      '--project', OPEN_PROJECT_NAME,
      '--name', '顺序组',
      '--members', `${memberA},${memberB},${memberC}`,
      '--json',
    ]);
    expect(created.exitCode).toBe(0);
    const createdResponse = parseCliResponse(created);
    if (!createdResponse.ok || createdResponse.command !== 'canvas.group.create') {
      throw new Error(`expected canvas.group.create success response, got ${created.stdout}`);
    }
    const groupId = createdResponse.group_node_id;
    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--scope', `group:${groupId}`,
      '--order', `${memberC},${memberA}`,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }
    const graph = useCanvasStore.getState().nodeGraph;
    const yOf = (id: string): number => {
      const node = graph?.nodes.find((c) => c.id === id);
      if (!node) throw new Error(`node missing: ${id}`);
      return node.position.y;
    };
    // order 首位 memberC 占第一行（y 最小），其次 memberA；未指定的 memberB 跟排最后
    expect(Object.keys(response.positions).sort()).toEqual([memberA, memberB, memberC].sort());
    expect(yOf(memberC)).toBeLessThan(yOf(memberA));
    expect(yOf(memberA)).toBeLessThan(yOf(memberB));
    for (const [nodeId, position] of Object.entries(response.positions)) {
      const node = graph?.nodes.find((c) => c.id === nodeId);
      expect(node?.position).toEqual(position);
    }
  });

  it('task cancel 有窗形态全链：CLI → 代理通道 → 真实接收器 → 用户取消链受理 → 响应回 CLI（CLI-012 有窗形态主链）', async () => {
    // 取消受理响应按 TaskCancelAcceptedResponseSchema 构造并当场 parse（真实 HTTP 边界语义）
    const accepted = TaskCancelAcceptedResponseSchema.parse({
      accepted: true,
      task_id: 'task-seam-cancel-1',
      cancelled_at: '2026-10-07T00:00:00.000Z',
    });
    cancelTaskMock.mockResolvedValue(accepted);

    const result = await runCli(['task', 'cancel', 'task-seam-cancel-1', '--project', OPEN_PROJECT_NAME, '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'task.cancel') {
      throw new Error(`expected task.cancel success response, got ${result.stdout}`);
    }
    expect(response.accepted).toBe(true);
    expect(response.task_id).toBe('task-seam-cancel-1');
    expect(response.cancelled_at).toBe('2026-10-07T00:00:00.000Z');
    // 走的是代理执行通道（用户取消链），不是运行域取消端点
    expect(cancelTaskMock).toHaveBeenCalledTimes(1);
    expect(cancelTaskMock.mock.calls[0]?.[0]).toBe('task-seam-cancel-1');
  });

  it('画布命令项目未打开守卫：CLI 收到 project_not_open，画布无任何写入、代理通道未被触达（CLI-007 主链）', async () => {
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;
    const requestsBefore = sharedWiring.capturedRequests.length;

    const result = await runCli([
      'canvas',
      'group',
      'create',
      '--project',
      closedProjectDir,
      '--name',
      '不该存在的组',
      '--members',
      'ghost-node',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    const error = parseCliFailure(result);
    expect(error.code).toBe('project_not_open');
    // 编辑域存储无任何写入、命令未进入代理执行通道
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
    expect(groupNodes()).toHaveLength(0);
    expect(sharedWiring.capturedRequests.length).toBe(requestsBefore);
  });
});

// ---------------------------------------------------------------------------
// 链路 C：generate 主链（程序化提交 → 受理回执 → 任务节点投影）
// ---------------------------------------------------------------------------

describe('链路 C：generate 主链（程序化提交）', () => {
  it('generate 全链：CLI → 代理通道 → 程序化提交 → 契约形状受理 → 任务节点投影落位 → 创作面草稿不变（CLI-008 主链可测部分）', async () => {
    // 媒体资产与模型目录种床（真实 store 状态；mediaAsset/catalogEntry 沿 cliProxyReceiver.generate.test.ts）
    const mediaAsset = {
      id: 'asset_seam_1',
      mediaType: 'image',
      original: {
        url: `local-media://seam/asset_seam_1.png`,
        projectRef: null,
        fileKey: 'asset_seam_1.png',
        sourceUrl: null,
        mimeType: 'image/png',
        sizeBytes: 10,
        width: 8,
        height: 8,
        durationMs: null,
        fps: null,
      },
      thumbnail: {
        url: null,
        mimeType: null,
        width: null,
        height: null,
        status: 'missing',
        generatedAt: null,
        error: null,
      },
      lifecycle: { createdAt: 1, updatedAt: 2 },
    };
    useCanvasStore.setState((state) => {
      state.mediaAssets = { asset_seam_1: mediaAsset };
    });
    usePromptDockStore.setState({
      catalog: [
        {
          model_id: 'seam-model-a',
          model_version: '1.0.0',
          default_task_type: 'image',
          capability: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
          parameter_schema: { fields: [], required_fields: [], default_values: {} },
          deployment: {
            has_active_deployment: true,
            active_deployment_id: 'dep_seam_1',
            deployable: true,
            failure_code: 'none',
          },
        },
      ],
    });
    // 用户正在编辑的草稿快照（CLI-008「草稿不变」断言基线）
    const draftBefore = usePromptDockStore.getState().draft;

    // 提交受理替身：响应按 PromptDockBatchSubmitResponseSchema 字段构造并当场 parse——
    // 真实 HTTP 边界（promptDockApi）正是这样把响应喂给下游的；字段从 schema 产生，
    // 构造漂移会在 parse 处立刻炸红而不是静默流入投影。
    const buildAcceptanceResponse = (batchId: string, taskIds: string[]) =>
      PromptDockBatchSubmitResponseSchema.parse({
        batch_id: batchId,
        intent_snapshot: {
          batch_id: batchId,
          model_id: 'seam-model-a',
          model_version: '1.0.0',
          prompt: '一只猫在窗台',
          params: {},
          task_count: taskIds.length,
          task_ids: taskIds,
          created_at: '2026-10-07T00:00:00.000Z',
        },
        tasks: taskIds.map((task_id, index) => ({ task_id, task_index: index })),
      });
    const submitRequests: unknown[] = [];
    submitGenerationBatchMock.mockImplementation(async (request) => {
      submitRequests.push(request);
      return buildAcceptanceResponse('batch-seam-1', ['task_seam_1', 'task_seam_2']);
    });

    const result = await runCli([
      'generate',
      '--project',
      OPEN_PROJECT_NAME,
      '--prompt',
      '一只猫在窗台',
      '--model',
      'seam-model-a',
      '--count',
      '2',
      '--ref',
      'asset_seam_1',
      '--arg',
      'size=1024x1024',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'generate') {
      throw new Error(`expected generate success response, got ${result.stdout}`);
    }
    expect(response.batch_id).toBe('batch-seam-1');
    expect(response.tasks.map((task) => task.task_id)).toEqual(['task_seam_1', 'task_seam_2']);
    // 受理回执是任务节点投影的唯一创建触发事实：画布出现任务节点投影（与界面提交一致）
    expect(findTaskNodeData('task_seam_1')?.batchId).toBe('batch-seam-1');
    expect(findTaskNodeData('task_seam_2')?.batchId).toBe('batch-seam-1');
    // 提交只发生一次：不自动重试（提交受理非幂等，spec §5.4）
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
    expect(submitRequests[0]).toMatchObject({
      model_id: 'seam-model-a',
      task_count: 2,
      reference_asset_ids: ['asset_seam_1'],
      project_path: openProjectDir,
    });
    // 程序化提交不读写创作面草稿、不触发创作面 UI 状态（spec §6.4/§13）
    expect(usePromptDockStore.getState().draft).toEqual(draftBefore);
    expect(usePromptDockStore.getState().submitting).toBe(false);
    expect(usePromptDockStore.getState().preflightIssues).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 链路 D：app status 应用状态感知（CLI-020/CLI-021：主进程直答打开集合 + 代理只读查询选中态）
// ---------------------------------------------------------------------------

describe('链路 D：app status 应用状态感知（CLI-020/CLI-021 主链）', () => {
  it('选中态全链：真实 store 选中 → CLI → 控制服务 → 代理只读查询 → 接收器直读 store → 分类型回传（CLI-021 主链）', async () => {
    // 输入从真实链路源头产生：节点经真实 addNode action 创建，选中经真实
    // projectSelectionContract action 建立（与界面选择投影同一入口），不手工构造理想输入。
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10);
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [memberA, memberB],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
    const storeBefore = useCanvasStore.getState();
    const requestsBefore = sharedWiring.capturedRequests.length;

    const result = await runCli(['app', 'status', '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${result.stdout}`);
    }
    const entry = response.opened_projects.find((project) => project.path === openProjectDir);
    // 响应选中态 == store 真相源现值（分类型：节点/注释），且真实选中了两个节点
    const storeAfter = useCanvasStore.getState();
    expect(storeAfter.selectedNodeIds).toHaveLength(2);
    expect(entry?.selection).toEqual({
      node_ids: [...storeAfter.selectedNodeIds],
      annotation_ids: [...storeAfter.selectedAnnotationIds],
    });
    expect(entry).toMatchObject({ name: OPEN_PROJECT_NAME, focused: true });
    // 代理只读命令真实发出（主进程 → 画布窗口腿）
    expect(sharedWiring.capturedRequests.length).toBe(requestsBefore + 1);
    expect(sharedWiring.capturedRequests.at(-1)).toMatchObject({ command: 'canvas.selection.get' });
    // 只读不写：历史与画布结构不变（不进撤销栈、不产生任何写入，spec §6.3 只读查询条款）
    expect(useCanvasStore.getState().history.length).toBe(storeBefore.history.length);
    expect(useCanvasStore.getState().historyIndex).toBe(storeBefore.historyIndex);
    expect(
      (useCanvasStore.getState().nodeGraph?.nodes.length ?? 0) === (storeBefore.nodeGraph?.nodes.length ?? 0),
    ).toBe(true);
  });

  it('人读输出：逐项列出名称/路径/焦点标记/选中摘要（CLI-020 人读形态）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [memberA],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });

    const result = await runCli(['app', 'status']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('已打开 1 个项目');
    expect(result.stdout).toContain(OPEN_PROJECT_NAME);
    expect(result.stdout).toContain(openProjectDir);
    expect(result.stdout).toContain('持有焦点');
    expect(result.stdout).toContain('选中节点 1 个');
  });

  it('多项目并存逐项列出，焦点标记按查询时点逐窗口判定（CLI-020 主链）', async () => {
    seamState.extraOpenProjectPaths = [closedProjectDir];
    seamState.focusedProjectPath = closedProjectDir;

    const result = await runCli(['app', 'status', '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${result.stdout}`);
    }
    expect(response.opened_projects.map((project) => project.path)).toEqual([openProjectDir, closedProjectDir]);
    expect(response.opened_projects.map((project) => project.focused)).toEqual([false, true]);
    // 名称：注册表在册名优先；未在册项目回退路径末段（两项目都在注册表 fixture 中）
    expect(response.opened_projects.map((project) => project.name)).toEqual([OPEN_PROJECT_NAME, CLOSED_PROJECT_NAME]);
  });

  it('无项目打开 → 空集合且命令成功，不触达代理通道（CLI-020）', async () => {
    seamState.openWindowProjectPath = null;
    seamState.extraOpenProjectPaths = [];
    const requestsBefore = sharedWiring.capturedRequests.length;

    const result = await runCli(['app', 'status', '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${result.stdout}`);
    }
    expect(response.opened_projects).toEqual([]);
    expect(sharedWiring.capturedRequests.length).toBe(requestsBefore);
  });

  it('画布未就绪两形态 → 选中态 null 且命令成功（CLI-021）：页面加载中不分发查询；nodeGraph 未载入由接收器回 null', async () => {
    // 形态 1：画布页面仍在加载（主进程侧 isLoading）→ 不向该窗口分发查询，选中态 null
    seamState.canvasLoading = true;
    const requestsBefore = sharedWiring.capturedRequests.length;
    const loadingResult = await runCli(['app', 'status', '--json']);
    expect(loadingResult.exitCode).toBe(0);
    const loadingResponse = parseCliResponse(loadingResult);
    if (!loadingResponse.ok || loadingResponse.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${loadingResult.stdout}`);
    }
    expect(loadingResponse.opened_projects).toHaveLength(1);
    expect(loadingResponse.opened_projects[0]?.selection).toBeNull();
    expect(sharedWiring.capturedRequests.length).toBe(requestsBefore);

    // 形态 2：页面已加载完但画布数据未就绪（nodeGraph null）→ 查询分发到接收器，原路返回 selection null
    seamState.canvasLoading = false;
    useCanvasStore.setState((state) => {
      state.nodeGraph = null;
      state.selectedNodeIds = [];
      state.selectedAnnotationIds = [];
    });
    const notReadyResult = await runCli(['app', 'status', '--json']);
    expect(notReadyResult.exitCode).toBe(0);
    const notReadyResponse = parseCliResponse(notReadyResult);
    if (!notReadyResponse.ok || notReadyResponse.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${notReadyResult.stdout}`);
    }
    expect(notReadyResponse.opened_projects).toHaveLength(1);
    expect(notReadyResponse.opened_projects[0]?.selection).toBeNull();
    expect(sharedWiring.capturedRequests.length).toBe(requestsBefore + 1);
    expect(sharedWiring.capturedRequests.at(-1)).toMatchObject({ command: 'canvas.selection.get' });
  });
});
