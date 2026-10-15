// @vitest-environment node
// @spec: CLI-033
//
// CLI 受理幂等键接缝测试（spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键）。
//
// 使命：把「CLI 客户端 → 本地控制服务 → 执行器 → 代理执行通道 → 画布窗口接收器 →
// 程序化提交」主链在幂等键维度真实跑通一遍（与 cli.seam.test.ts 同一 bargain：两端真实实现，
// 只在 HTTP 边界替身；红→绿输入从真实链路源头产生）：
// - 未传 --request-id：CLI 客户端自动生成 uuid 随请求携带、受理回执回显；
// - 显式 --request-id：幂等键经真实代理链透传到提交请求，重放回执（replayed: true）回显
//   幂等键、不创建任务节点投影，人读回执说明「未重复创建」。
//
// 替身清单（guard-seam-mock-exempt 标注）：promptDockApi HTTP 边界替身——受理响应按
// PromptDockBatchSubmitResponseSchema 字段构造并当场 parse；其余（前置校验、受理回执投影
// 判定、画布 store、代理链）全部走真实实现。

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CliCommandResponseSchema,
  PromptDockBatchSubmitResponseSchema,
  type CliCommandResponse,
  type CliProxyCommandResponse,
} from '@iart/contracts';

// guard-seam-mock-exempt: 外部 HTTP 边界替身——被测主链两端真实，仅 HTTP facade 按 schema 真实形态替身；消除条件：promptDockApi 改为可注入 fetch 上游后移除本替身
vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  cancelTask: vi.fn(),
  submitGenerationBatch: vi.fn(),
}));

import { submitGenerationBatch } from '@/client/api/promptDockApi';
import { useRuntimeStore } from '@/client/store/runtimeStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { TaskNodeData } from '@/features/canvas/types/node';
import { handleCliProxyPayload } from '@/features/canvas/services/cliProxyReceiver';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';

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
};
type ServiceModule = {
  startCliControlService: (options: Record<string, unknown>) => Promise<ServiceHandle>;
};
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
    ) => Promise<
      { ok: true; response: CliProxyCommandResponse } | { ok: false; reason: string; detail: string }
    >;
    consumeResponsePayload: (payload: unknown) => void;
  };
};

const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;
const loadServiceModule = (): ServiceModule => requireDesktop(serviceEntry) as ServiceModule;
const loadDispatcherModule = (): DispatcherModule => requireDesktop(dispatcherEntry) as DispatcherModule;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-idem-seam-'));
const registryFixturePath = path.join(tempRoot, 'recent-projects.json');
const openProjectDir = path.join(tempRoot, 'projects', 'opened-project');
const OPEN_PROJECT_NAME = '幂等接缝项目';

interface FixtureEntry {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt?: number | null;
}

const writeRegistryFixture = (): void => {
  const entries: FixtureEntry[] = [
    {
      nodeGraphId: 'ng-idem-open',
      name: OPEN_PROJECT_NAME,
      path: openProjectDir,
      createdAt: 1,
      savedAt: 2,
      lastOpenedAt: 1700000000000,
    },
  ];
  fs.writeFileSync(registryFixturePath, JSON.stringify(entries, null, 2), 'utf-8');
};

const buildProxyWiring = () => {
  const dispatcherModule = loadDispatcherModule();
  const dispatcher = dispatcherModule.createCliProxyDispatcher({
    getWindow: (projectPath) => {
      if (projectPath !== openProjectDir) return null;
      return {
        sendCommand: (payload) => {
          void handleCliProxyPayload(payload, (response) => {
            dispatcher.consumeResponsePayload(response);
          });
        },
        onClosed: () => undefined,
      };
    },
  });
  return dispatcher;
};

type DispatcherHandle = ReturnType<DispatcherModule['createCliProxyDispatcher']>;

const buildExecutorDeps = (dispatcher: DispatcherHandle): Record<string, unknown> => ({
  readProjects: () => JSON.parse(fs.readFileSync(registryFixturePath, 'utf-8')) as unknown[],
  windows: {
    openOrFocus: async () => ({ ok: true as const }),
    hasOpenWindow: (projectPath: string) => projectPath === openProjectDir,
    closeByProjectPath: () => true,
    listOpenEditorProjects: () => [{ projectPath: openProjectDir, focused: true, canvasLoading: false }],
  },
  forwarder: {
    getJson: async (pathname: string) => ({
      ok: false as const,
      reason: 'network_error',
      detail: `seam: forwarder not wired (${pathname})`,
    }),
    postJson: async (pathname: string, _body: unknown) => ({
      ok: false as const,
      reason: 'network_error',
      detail: `seam: forwarder not wired (${pathname})`,
    }),
  },
  storage: {
    createProject: () => ({ projectPath: openProjectDir }),
    deleteProject: () => undefined,
    touchProjectOpenedAt: () => undefined,
    readMediaAssets: () => [],
    readMediaAssetById: () => null,
    readAssetTaskIndex: () => new Map<string, string>(),
    readAssetGenerationIndex: () => new Map<string, unknown>(),
    readTaskOutputAssets: () => [],
    readBatchByClientRequestId: () => null,
    readTaskViewsByBatchId: () => [],
    readCanvasNodePayloads: () => [],
  },
  proxy: {
    dispatch: (projectPath: string, candidate: Record<string, unknown>) => dispatcher.dispatch(projectPath, candidate),
  },
  pollIntervalMs: 10,
});

let service: ServiceHandle;
let client: ClientModule;
let dispatcher: DispatcherHandle;

const runCli = (argv: readonly string[]): Promise<CliClientRunResult> =>
  client.runCliClient(argv, {
    discoveryFilePath: service.discoveryFilePath,
    pollIntervalMs: 10,
  });

/** CLI --json 成功输出 = 完整 CliCommandResponse，逐条过契约 schema（CLI-014 客户端侧断言口径）。 */
const parseCliResponse = (result: CliClientRunResult): CliCommandResponse => {
  const raw: unknown = JSON.parse(result.stdout);
  const parsed = CliCommandResponseSchema.parse(raw);
  expect(parsed).toEqual(raw);
  return parsed;
};

const submitGenerationBatchMock = vi.mocked(submitGenerationBatch);

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-idem-seam',
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

const findTaskNodeData = (taskId: string): TaskNodeData | null => {
  const node = (useCanvasStore.getState().nodeGraph?.nodes ?? []).find(
    (candidate) => candidate.type === 'task' && (candidate.data as TaskNodeData).taskId === taskId,
  );
  return node ? (node.data as TaskNodeData) : null;
};

const seedGenerationContext = (): void => {
  const mediaAsset = {
    id: 'asset_seam_1',
    mediaType: 'image',
    original: {
      url: 'local-media://seam/asset_seam_1.png',
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
    thumbnail: { url: null, mimeType: null, width: null, height: null, status: 'missing', generatedAt: null, error: null },
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
        deployment: { has_active_deployment: true, active_deployment_id: 'dep_seam_1', deployable: true, failure_code: 'none' },
      },
    ],
  });
};

beforeAll(async () => {
  fs.mkdirSync(openProjectDir, { recursive: true });
  writeRegistryFixture();
  client = loadClientModule();
  dispatcher = buildProxyWiring();
  const serviceModule = loadServiceModule();
  service = await serviceModule.startCliControlService({
    port: 0,
    discoveryFilePath: path.join(tempRoot, 'cli-discovery.json'),
    version: 'idem-seam-test',
    executorDeps: buildExecutorDeps(dispatcher),
  });
});

afterAll(async () => {
  await service.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  writeRegistryFixture();
  submitGenerationBatchMock.mockReset();
  await resetStores();
  seedGenerationContext();
});

describe('受理幂等键接缝（CLI-033：CLI 客户端 → 控制服务 → 代理链 → 程序化提交）', () => {
  it('未传 --request-id：客户端自动生成 uuid 随请求携带，受理回执回显该键', async () => {
    const acceptance = PromptDockBatchSubmitResponseSchema.parse({
      batch_id: 'batch-idem-auto',
      intent_snapshot: {
        batch_id: 'batch-idem-auto',
        model_id: 'seam-model-a',
        model_version: '1.0.0',
        prompt: '一只猫在窗台',
        params: {},
        task_count: 1,
        task_ids: ['task_idem_auto_1'],
        created_at: '2026-10-14T00:00:00.000Z',
      },
      tasks: [{ task_id: 'task_idem_auto_1', task_index: 0 }],
      replayed: false,
    });
    const submitRequests: unknown[] = [];
    submitGenerationBatchMock.mockImplementation(async (request) => {
      submitRequests.push(request);
      return acceptance;
    });

    const result = await runCli([
      'generate',
      '--project',
      OPEN_PROJECT_NAME,
      '--prompt',
      '一只猫在窗台',
      '--model',
      'seam-model-a',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'generate') {
      throw new Error(`expected generate success response, got ${result.stdout}`);
    }
    const firstRequest = submitRequests[0] as { client_request_id?: string } | undefined;
    // 幂等键自动生成：非空 uuid 形态随请求携带
    expect(typeof firstRequest?.client_request_id).toBe('string');
    expect(firstRequest?.client_request_id.length ?? 0).toBeGreaterThan(10);
    // 回执回显幂等键（真实代理链原路返回）
    expect(response.client_request_id).toBe(firstRequest?.client_request_id);
    expect(response.replayed).toBe(false);
  });

  it('显式 --request-id 全链：幂等键透传提交请求、重放回执回显 replayed 标志且不创建任务节点投影', async () => {
    const replay = PromptDockBatchSubmitResponseSchema.parse({
      batch_id: 'batch-idem-replay',
      intent_snapshot: {
        batch_id: 'batch-idem-replay',
        model_id: 'seam-model-a',
        model_version: '1.0.0',
        prompt: '一只猫在窗台',
        params: {},
        task_count: 1,
        task_ids: ['task_idem_replay_1'],
        created_at: '2026-10-14T00:00:00.000Z',
      },
      tasks: [{ task_id: 'task_idem_replay_1', task_index: 0 }],
      replayed: true,
    });
    const submitRequests: unknown[] = [];
    submitGenerationBatchMock.mockImplementation(async (request) => {
      submitRequests.push(request);
      return replay;
    });

    const result = await runCli([
      'generate',
      '--project',
      OPEN_PROJECT_NAME,
      '--prompt',
      '一只猫在窗台',
      '--model',
      'seam-model-a',
      '--request-id',
      'req-idem-explicit-1',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'generate') {
      throw new Error(`expected generate success response, got ${result.stdout}`);
    }
    // 幂等键经真实代理链透传到 Editor 提交请求
    expect(submitRequests[0]).toMatchObject({ client_request_id: 'req-idem-explicit-1' });
    // 重放回执回显幂等键与重放标志
    expect(response.batch_id).toBe('batch-idem-replay');
    expect(response.client_request_id).toBe('req-idem-explicit-1');
    expect(response.replayed).toBe(true);
    // 重放不创建任务节点投影（投影创建只属全新受理）
    expect(findTaskNodeData('task_idem_replay_1')).toBeNull();

    // 人读回执同样回显幂等键与重放语义（不暴露内部术语）
    const human = await runCli([
      'generate',
      '--project',
      OPEN_PROJECT_NAME,
      '--prompt',
      '一只猫在窗台',
      '--model',
      'seam-model-a',
      '--request-id',
      'req-idem-explicit-2',
    ]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('req-idem-explicit-2');
    expect(human.stdout).toContain('未重复创建');
  });
});
