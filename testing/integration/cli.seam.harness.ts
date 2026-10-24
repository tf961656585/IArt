/**
 * CLI 与本地 Agent 集成 · 主链接缝测试共享台架（spec docs/integrations/CLI与本地Agent集成.md
 * §4 架构 / §6 通道契约 / §10 边界条件）。
 *
 * 从 cli.seam.test.ts 拆出的共享脚手架（max-lines 1000 行数预算，拆分先例同
 * packages/contracts/src/cli-asset-import-contract.ts）：两端真实 + 只在最外层挡掉真实边界。
 * - CLI 客户端 / 控制服务 / 执行器 / 代理分发器：desktop-shell 编译产物 dist/cli/*.cjs
 *   （经 createRequire 加载；源码 .cts 的内部 import 指向 .cjs 构建产物，无法直接 import 源码，
 *   与 apps/desktop-shell/src/__tests__/cli-*.test.mts 同口径）；
 * - Editor 接收器 / canvasStore / promptDockStore / runtimeStore：apps/editor 源码经 vitest
 *   `@` alias 直接 import（node 环境可用，已探针核实）；
 * - 假 Electron 传输层（webContents.send / ipcMain.on 的替身，含断链注入点）：直通——
 *   分发器发出的命令载荷喂给真实 handleCliProxyPayload，接收器的 send 回调原样回注真实
 *   dispatcher.consumeResponsePayload；
 * - 临时数据根：recent-projects 注册表 fixture + 项目目录；主进程存储服务与注册表按契约
 *   以假存储适配承载（创建链重名守卫属存储服务职责，此处按其契约抛 PROJECT_NAME_CONFLICT）。
 *
 * 前置构建：desktop-shell 侧测试经 dist 加载，跑前需要
 * `pnpm --filter @iart/contracts build && pnpm --filter @iart/desktop-shell build`。
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'vitest';

import {
  CliCommandResponseSchema,
  type CliCommandResponse,
  type CliProxyCommandResponse,
} from '@iart/contracts';
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

export type CliClientRunResult = { exitCode: number; stdout: string; stderr: string };
export type ClientModule = {
  runCliClient: (
    argv: readonly string[],
    deps?: { discoveryFilePath?: string; fetchImpl?: typeof fetch; pollIntervalMs?: number },
  ) => Promise<CliClientRunResult>;
};
export type ServiceHandle = {
  port: number;
  discoveryFilePath: string;
  stop: () => Promise<void>;
  getCommandLog: () => readonly unknown[];
};
type ServiceModule = {
  startCliControlService: (options: Record<string, unknown>) => Promise<ServiceHandle>;
};
export type ProxyDispatchOutcome =
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

export type ProxyWiring = {
  /** 真实分发器（desktop-shell dist 产物）。 */
  dispatcher: ReturnType<DispatcherModule['createCliProxyDispatcher']>;
  /** 主进程 → 画布窗口方向捕获的命令载荷（webContents.send 的替身捕获）。 */
  capturedRequests: unknown[];
  /** 画布窗口 → 主进程方向捕获的响应载荷（sendCliProxyResponse 的替身捕获）。 */
  capturedResponses: unknown[];
  setMode: (mode: TransportMode) => void;
};

export const createProxyWiring = (
  isOpenProject: (projectPath: string) => boolean,
): ProxyWiring => {
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

export interface FixtureEntry {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt?: number | null;
}

export const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-seam-'));
export const registryFixturePath = path.join(tempRoot, 'recent-projects.json');
export const projectsRoot = path.join(tempRoot, 'projects');
export const openProjectDir = path.join(projectsRoot, 'opened-project');
export const closedProjectDir = path.join(projectsRoot, 'closed-project');
export const OPEN_PROJECT_NAME = '接缝打开项目';
export const CLOSED_PROJECT_NAME = '接缝关闭项目';
export const baseRegistryEntries = (): FixtureEntry[] => [
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

export const writeRegistryFixture = (entries: FixtureEntry[]): void => {
  fs.writeFileSync(registryFixturePath, JSON.stringify(entries, null, 2), 'utf-8');
};
export const readRegistryFixture = (): FixtureEntry[] =>
  JSON.parse(fs.readFileSync(registryFixturePath, 'utf-8')) as FixtureEntry[];

/**
 * 项目「已打开」状态（executor 的 hasOpenWindow 与分发器 getWindow 共用）。
 * app status（链路 D）扩展：多项目并存集合、查询时点焦点与画布加载态。
 */
export const seamState: {
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
// 资产 fixture（asset list / canvas node create / canvas.inspect 共用的存储投影数据源）
// ---------------------------------------------------------------------------

export type SeamAssetView = {
  assetId: string;
  mediaType: 'image' | 'video' | 'audio';
  original: {
    url: string;
    fileKey: string;
    sourceFileName: string | null;
    mimeType: string;
    width: number;
    height: number;
  };
  thumbnail: { url: null; status: 'missing' };
  lifecycle: { createdAt: number; updatedAt: number };
};

export type SeamGenerationEntry = {
  taskId: string;
  batchId: string | null;
  modelId: string | null;
  prompt: string | null;
};

const makeSeamAsset = (
  assetId: string,
  mediaType: SeamAssetView['mediaType'],
  sourceFileName: string | null,
): SeamAssetView => ({
  assetId,
  mediaType,
  original: {
    url: `local-media://spid_seam/${assetId}.png`,
    fileKey: `${assetId}.png`,
    sourceFileName,
    mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png',
    width: 1024,
    height: 768,
  },
  thumbnail: { url: null, status: 'missing' },
  lifecycle: { createdAt: 1700000000000, updatedAt: 1700000000001 },
});

/** 生成产物资产（有来源批次/任务/模型）。 */
export const SEAM_GENERATED_ASSET_ID = 'asset-seam-gen';
/** 导入素材资产（无生成来源，batch_id 为 null）。 */
export const SEAM_IMPORTED_ASSET_ID = 'asset-seam-imp';
/** 生成来源批次（canvas node create 落 sourceBatchId、asset list 输出 batch_id）。 */
export const SEAM_GENERATION_BATCH_ID = 'batch-seam-1';

const defaultSeamAssets = (): SeamAssetView[] => [
  makeSeamAsset(SEAM_GENERATED_ASSET_ID, 'image', null),
  makeSeamAsset(SEAM_IMPORTED_ASSET_ID, 'video', 'seam-import.mp4'),
];

const defaultSeamGenerationIndex = (): Map<string, SeamGenerationEntry> =>
  new Map([
    [
      SEAM_GENERATED_ASSET_ID,
      { taskId: 'task-seam-1', batchId: SEAM_GENERATION_BATCH_ID, modelId: 'model-seam', prompt: '接缝提示词' },
    ],
  ]);

export const seamAssets: SeamAssetView[] = defaultSeamAssets();
export const seamGenerationIndex: Map<string, SeamGenerationEntry> = defaultSeamGenerationIndex();

const resetSeamAssetFixtures = (): void => {
  seamAssets.splice(0, seamAssets.length, ...defaultSeamAssets());
  seamGenerationIndex.clear();
  for (const [assetId, entry] of defaultSeamGenerationIndex()) seamGenerationIndex.set(assetId, entry);
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
  // 运行域转发端点：本接缝各链路都不触达（有窗取消走代理通道；status/wait 不在范围），
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
    // 项目级资产投影：fixture 只属于打开的项目（未打开项目没有可读画布/资产上下文，
    // 保持既有「关闭项目输出空场景图」语义）。asset list 同理按解析出的项目路径读取。
    readMediaAssets: (projectPath: string) => (projectPath === openProjectDir ? seamAssets : []),
    readMediaAssetById: (projectPath: string, assetId: string) =>
      projectPath === openProjectDir ? (seamAssets.find((asset) => asset.assetId === assetId) ?? null) : null,
    readAssetTaskIndex: () =>
      new Map([...seamGenerationIndex].map(([assetId, generation]) => [assetId, generation.taskId])),
    // canvas.inspect / asset.list 的生成来源索引（含批次，CLI-056）。
    readAssetGenerationIndex: (projectPath: string) =>
      projectPath === openProjectDir ? seamGenerationIndex : new Map(),
    readTaskOutputAssets: () => [],
    // 画布节点投影：打开项目的画布窗口 store 现值（真实 Editor store 是唯一事实源，
    // 等价于生产环境的持久化读模型投影）；未打开项目无可读画布，返回空清单。
    readCanvasNodePayloads: (projectPath: string) =>
      projectPath === openProjectDir ? (useCanvasStore.getState().nodeGraph?.nodes ?? []) : [],
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
let sharedWiring: ProxyWiring | null = null;

/** 共享分发器/传输层（须在 startCliSeamService 之后访问；缺失即接缝未初始化）。 */
export const getWiring = (): ProxyWiring => {
  if (sharedWiring === null) throw new Error('cli seam wiring not started');
  return sharedWiring;
};

/** beforeAll：建 fixture 目录 + 启动真实控制服务（注入假传输层接线）。 */
export const startCliSeamService = async (): Promise<void> => {
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
};

/** afterAll：停服务 + 清临时数据根。 */
export const stopCliSeamService = async (): Promise<void> => {
  await service.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
};

/** beforeEach：fixture 与已打开状态复位 + 画布/运行时 store 种床。 */
export const resetSeamForTest = async (): Promise<void> => {
  writeRegistryFixture(baseRegistryEntries());
  resetSeamAssetFixtures();
  seamState.openWindowProjectPath = openProjectDir;
  seamState.extraOpenProjectPaths = [];
  seamState.canvasLoading = false;
  seamState.focusedProjectPath = openProjectDir;
  await resetStores();
};

export const runCli = (argv: readonly string[]): Promise<CliClientRunResult> =>
  client.runCliClient(argv, {
    discoveryFilePath: service.discoveryFilePath,
    pollIntervalMs: 10,
  });

/** CLI --json 成功输出 = 完整 CliCommandResponse，逐条过契约 schema（CLI-014 客户端侧断言口径）。 */
export const parseCliResponse = (result: CliClientRunResult): CliCommandResponse => {
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
export const parseCliFailure = (result: CliClientRunResult): { code: string; message: string } => {
  const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
  expect(body.ok).toBe(false);
  return body.error;
};

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
  // 历史基线（生产环境项目加载后即存在）：使「一次写命令 = 一条撤销记录」可按 +1 比较。
  useCanvasStore.getState().saveToHistory();
  // 项目媒体资产投影（生产环境由项目加载链写入 store；此处从同一 fixture 映射，
  // 画布窗口侧的 asset 前置校验读的是 store.mediaAssets）。
  useCanvasStore.setState((state) => {
    state.mediaAssets = Object.fromEntries(
      seamAssets.map((asset) => [
        asset.assetId,
        {
          id: asset.assetId,
          mediaType: asset.mediaType,
          original: {
            url: asset.original.url,
            projectRef: null,
            fileKey: asset.original.fileKey,
            sourceUrl: null,
            sourceFileName: asset.original.sourceFileName,
            mimeType: asset.original.mimeType,
            sizeBytes: null,
            width: asset.original.width,
            height: asset.original.height,
            durationMs: null,
            fps: null,
          },
          thumbnail: {
            url: null,
            mimeType: null,
            width: null,
            height: null,
            status: 'missing' as const,
            generatedAt: null,
            error: null,
          },
          lifecycle: { ...asset.lifecycle },
        },
      ]),
    );
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
export const createMemberNodeViaStoreAction = (x: number, y: number): string => {
  const created = useCanvasStore.getState().addNode('asset', { x, y }, undefined, undefined);
  if (created === null) throw new Error('addNode failed to create asset node');
  const graph = useCanvasStore.getState().nodeGraph;
  const node = graph?.nodes.find((candidate) => candidate.id === created.id);
  if (!node) throw new Error('created node missing from store');
  return node.id;
};

export const groupNodes = () =>
  (useCanvasStore.getState().nodeGraph?.nodes ?? []).filter((node) => node.type === 'group');

export const findTaskNodeData = (taskId: string): TaskNodeData | null => {
  const node = (useCanvasStore.getState().nodeGraph?.nodes ?? []).find(
    (candidate) => candidate.type === 'task' && (candidate.data as TaskNodeData).taskId === taskId,
  );
  return node ? (node.data as TaskNodeData) : null;
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 有限等待观察分发器是否收口：断链时 pending 永不 resolve（内部通信不设超时，测试用有限等待观察）。 */
export const settleWithin = async (
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
