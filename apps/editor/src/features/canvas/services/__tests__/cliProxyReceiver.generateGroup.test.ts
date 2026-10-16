// @vitest-environment jsdom
// @spec: CLI-043, CLI-044, CLI-046, CLI-033
//
// CLI 出生组接缝测试（spec docs/integrations/CLI与本地Agent集成.md §5.4 --group / §5.3 空组建组）：
// 输入从真实链路源头产生（真实 CliProxyCommandSchema 构造命令 → 真实接收器 → 真实程序化提交
// 共享核心 → 真实投影创建），只在最外层 HTTP 边界 mock submitGenerationBatch（假上游）；
// 断言覆盖：出生入组成员关系 + 组内落位锚定 + 受理回执 node_id/group_id + 组名歧义前置拦截
// （不发起提交、画布零改动）+ 零匹配自动建组 + 空组建组命令 + 幂等重放不重复建组建节点。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  cancelTask: vi.fn(),
  submitGenerationBatch: vi.fn(),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  __esModule: true,
  getRuntimeProjectPath: () => '/tmp/iart-cli-group-test',
}));

import { CliProxyCommandResponseSchema, CliProxyCommandSchema } from '@iart/contracts';
import type {
  CliProxyCommandResponse,
  ExecutableModelDirectoryEntry,
  MediaAsset,
  PromptDockBatchSubmitResponse,
} from '@iart/contracts';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import type { AssetNodeData, TaskNodeData } from '@/features/canvas/types/node';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { executeCliProxyCommand } from '../cliProxyReceiver';

const submitGenerationBatchMock = vi.mocked(submitGenerationBatch);

// ---------------------------------------------------------------------------
// store 种床（沿 cliProxyReceiver.generate.test.ts 惯例：真实 store + setState 种数据）
// ---------------------------------------------------------------------------

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-group-seam-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.ui.canvasContainerSize = null;
  });
  usePromptDockStore.setState({
    form: 'generate',
    catalog: [],
    catalogLoaded: true,
    submitting: false,
    preflightIssues: null,
  });
};

const loadTestGraph = async (): Promise<void> => {
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
  useCanvasStore.setState((state) => {
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
};

const mediaAsset = (id: string): MediaAsset => ({
  id,
  mediaType: 'image',
  original: {
    url: `local-media://demo/${id}.png`,
    projectRef: null,
    fileKey: `${id}.png`,
    sourceUrl: null,
    sourceFileName: null,
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
});

const catalogEntry = (): ExecutableModelDirectoryEntry => ({
  model_id: 'model-a',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [], default_values: {} },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
});

const acceptanceResponse = (taskCount: number, replayed = false): PromptDockBatchSubmitResponse => ({
  batch_id: 'batch_grp',
  intent_snapshot: {
    batch_id: 'batch_grp',
    model_id: 'model-a',
    model_version: '1.0.0',
    prompt: '一只猫在窗台',
    params: {},
    task_count: taskCount,
    task_ids: Array.from({ length: taskCount }, (_, index) => `task_${index + 1}`),
    created_at: '2026-10-15T00:00:00.000Z',
  },
  tasks: Array.from({ length: taskCount }, (_, index) => ({
    task_id: `task_${index + 1}`,
    task_index: index,
  })),
  ...(replayed ? { replayed: true } : {}),
});

const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

const findTaskNode = (taskId: string) => {
  const graph = useCanvasStore.getState().nodeGraph;
  return graph?.nodes.find((n) => n.type === 'task' && (n.data as TaskNodeData).taskId === taskId) ?? null;
};

const groupNodes = () =>
  useCanvasStore.getState().nodeGraph?.nodes.filter((n) => n.type === 'group') ?? [];

const groupByName = (name: string) =>
  groupNodes().find((node) => (node.data as { name: string }).name === name) ?? null;

/** 种一个组（真实链路：addNode 资产成员 → createGroup → renameGroup），返回组 id 与成员底缘。 */
const seedGroup = async (name: string, memberCount: number): Promise<{ groupId: string; memberBottomY: number; memberMinX: number }> => {
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i += 1) {
    const node = useCanvasStore.getState().addNode('asset', { x: 400 + i * 280, y: 200 }, {
      label: '素材',
      sourceBatchId: '',
      sourceTaskId: '',
      sourceModelId: '',
      mediaType: 'image',
      assetId: `asset_${i + 1}`,
    } satisfies AssetNodeData);
    if (node) memberIds.push(node.id);
  }
  const groupId = useCanvasStore.getState().createGroup(memberIds, undefined);
  if (groupId === null) throw new Error('seed group failed');
  useCanvasStore.getState().renameGroup(groupId, name);
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) throw new Error('graph missing');
  const members = graph.nodes.filter((n) => n.groupId === groupId);
  const memberBottomY = Math.max(...members.map((m) => m.position.y + 180));
  const memberMinX = Math.min(...members.map((m) => m.position.x));
  return { groupId, memberBottomY, memberMinX };
};

beforeEach(async () => {
  resetStore();
  await loadTestGraph();
  useCanvasStore.setState((state) => {
    state.mediaAssets = { asset_1: mediaAsset('asset_1'), asset_2: mediaAsset('asset_2') };
  });
  usePromptDockStore.setState({
    catalog: [catalogEntry()],
  });
  submitGenerationBatchMock.mockReset();
});

describe('CLI 出生组接缝（CLI-043/CLI-044/CLI-046）', () => {
  it('唯一同名组：任务节点出生入组、组内落位从成员包围盒下缘续排，回执携带 node_id/group_id', async () => {
    const seeded = await seedGroup('分镜', 1);
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(2));

    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-grp-1',
      prompt: '一只猫在窗台',
      model: 'model-a',
      count: 2,
      ref: ['asset_1'],
      group: '分镜',
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('batch_id' in response)) throw new Error('expected generate success response');
    expect(response.batch_id).toBe('batch_grp');
    // 受理回执逐任务携带画布投影身份（CLI-046）
    for (const task of response.tasks) {
      const node = findTaskNode(task.task_id);
      expect(node).not.toBeNull();
      expect(task.node_id).toBe(node?.id ?? null);
      expect(task.group_id).toBe(seeded.groupId);
    }
    // 成员关系：创建即入组（groupId 落图）
    const task1 = findTaskNode('task_1');
    const task2 = findTaskNode('task_2');
    expect(task1?.groupId).toBe(seeded.groupId);
    expect(task2?.groupId).toBe(seeded.groupId);
    // 组内落位：以成员包围盒下缘为续排起点（行内横向步进、同排同 y，防重叠引擎定最终位）
    expect(task1?.position.y).toBeGreaterThanOrEqual(seeded.memberBottomY);
    expect(task1?.position.x).toBeGreaterThanOrEqual(seeded.memberMinX);
    expect(task2?.position.x).toBe((task1?.position.x ?? 0) + 240 + 40);
    expect(task2?.position.y).toBe(task1?.position.y);
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
  });

  it('组名歧义（≥2 同名组）前置拦截：group_name_ambiguous、不发起提交、画布零改动', async () => {
    await seedGroup('同名组', 1);
    await seedGroup('同名组', 1);
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;

    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-grp-2',
      prompt: '一只猫在窗台',
      model: 'model-a',
      group: '同名组',
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('error' in response)) throw new Error('expected generate error response');
    expect(response.error.code).toBe('group_name_ambiguous');
    expect(response.error.message).toContain('同名组');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
  });

  it('零匹配自动建组：受理后建命名空组、任务节点出生其内（组头下方起排）', async () => {
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));
    const groupsBefore = groupNodes().length;

    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-grp-3',
      prompt: '一只猫在窗台',
      model: 'model-a',
      group: '新组',
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('batch_id' in response)) throw new Error('expected generate success response');
    expect(groupNodes().length).toBe(groupsBefore + 1);
    const created = groupByName('新组');
    expect(created).not.toBeNull();
    expect(response.tasks[0]?.group_id).toBe(created?.id ?? null);
    const taskNode = findTaskNode('task_1');
    expect(taskNode?.groupId).toBe(created?.id);
    // 组内落位：空组从组头卡片下方起排（组头高度 32 + 顶部内边距 8）
    expect(taskNode?.position.y).toBeGreaterThan((created?.position.y ?? 0) + 32);
  });

  it('CLI 空组建组（CLI-044）：零成员建组返回 group_node_id，组被命名且成员计数 0', async () => {
    const groupsBefore = groupNodes().length;
    const command = CliProxyCommandSchema.parse({
      command: 'canvas.group.create',
      request_id: 'req-grp-4',
      name: '空组',
      members: [],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('group_node_id' in response)) throw new Error('expected group create success response');
    expect(groupNodes().length).toBe(groupsBefore + 1);
    const created = groupByName('空组');
    expect(created?.id).toBe(response.group_node_id);
  });

  it('幂等重放带组：不重复建组建节点，回执回既有投影身份（CLI-033/CLI-043）', async () => {
    const seeded = await seedGroup('分镜', 1);
    // 既有投影：task_1 已在组内（真实通道：addNode membership 创建）
    const existing = useCanvasStore.getState().addNode(
      'task',
      { x: 100, y: 400 },
      {
        label: 'model-a',
        modelId: 'model-a',
        taskId: 'task_1',
        taskIndex: 0,
        batchId: 'batch_grp',
        status: 'generating',
        progressPercent: null,
        progressPhase: null,
        errorMessage: null,
        failure: null,
        createdAt: 1,
        updatedAt: 2,
      } satisfies TaskNodeData,
      { groupId: seeded.groupId },
    );
    expect(existing).not.toBeNull();
    const groupsBefore = groupNodes().length;
    const tasksBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1, true));

    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-grp-5',
      prompt: '一只猫在窗台',
      model: 'model-a',
      group: '分镜',
      client_request_id: 'req-idem-1',
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('batch_id' in response)) throw new Error('expected generate success response');
    expect(response.replayed).toBe(true);
    // 不重复建组建节点
    expect(groupNodes().length).toBe(groupsBefore);
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(tasksBefore);
    // 回执身份来自既有投影
    expect(response.tasks[0]?.node_id).toBe(existing?.id ?? null);
    expect(response.tasks[0]?.group_id).toBe(seeded.groupId);
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
  });
});
