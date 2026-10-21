import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  submitGenerationBatch: vi.fn(),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  __esModule: true,
  getRuntimeProjectPath: () => '/tmp/iart-programmatic-submit-test',
}));

import type {
  ExecutableModelDirectoryEntry,
  MediaAsset,
  PromptDockBatchSubmitResponse,
} from '@iart/contracts';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { TaskNodeData } from '@/features/canvas/types/node';
import {
  buildProgrammaticIntentFromCliParams,
  runGenerationBatchSubmission,
  submitGenerationBatchFromIntent,
  type ProgrammaticSubmitIntent,
} from '../programmaticSubmission';
import { EMPTY_PROMPT_DOCK_DRAFT, usePromptDockStore } from '../promptDockStore';
import {
  createCatalogEntry,
  createCatalogEntryWithSlots,
  firstLastFrameSlots,
  multiImageRefSlots,
} from './fixtures/promptDockCatalogEntry';

/**
 * 程序化提交共享核心与 CLI 纯入口（spec docs/integrations/CLI与本地Agent集成.md §6.4/§5.4/§9，
 * 验收 CLI-008 / CLI-007 Editor 侧）。
 *
 * 口径：
 * - 共享核心与界面提交同一构造路径与数据源（模型目录从 store 读）；受理回执经真实
 *   createTaskProjectionsForAcceptance 在真实 canvasStore 种床上创建任务节点（不 mock 投影）。
 * - CLI 纯入口落位照常但不做选中反馈（selectCreatedNodes: false）；
 *   界面路径（默认）受理后选中新任务节点——两路行为都在此封口。
 * - 草稿与创作面 UI 状态不触碰（CLI-008）：以引用相等断言 store 字段未被任何写入替换。
 * - 校验失败映射（spec §6.4 定位到问题输入 / §9 错误码）与传输层失败不重试（spec §5.4）。
 *
 * @spec: CLI-008（程序化提交共享核心：受理回执投影 + 草稿不触碰）、CLI-007（Editor 侧映射）
 */

const submitGenerationBatchMock = vi.mocked(submitGenerationBatch);

// ---------------------------------------------------------------------------
// 种床（沿 cliProxyReceiver.test.ts / taskProjectionService.agentLineage.test.ts 惯例：
// 真实 store + setState 种数据，投影用真实实现）
// ---------------------------------------------------------------------------

const createTestGraph = () =>
  createNodeGraph({
    name: 'programmatic-submit-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetCanvasStore = (): void => {
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
};

const loadTestGraph = (): void => {
  void useCanvasStore.getState().loadNodeGraph(createTestGraph());
  useCanvasStore.setState((state) => {
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
};

const mediaAsset = (id: string, mediaType: 'image' | 'video' | 'audio' = 'image'): MediaAsset => ({
  id,
  mediaType,
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

const entry = (modelId = 'model-a'): ExecutableModelDirectoryEntry =>
  createCatalogEntry({ model_id: modelId });

const acceptanceResponse = (taskCount: number): PromptDockBatchSubmitResponse => ({
  batch_id: 'batch_1',
  intent_snapshot: {
    batch_id: 'batch_1',
    model_id: 'model-a',
    model_version: '1.0.0',
    prompt: '一只猫',
    params: {},
    task_count: taskCount,
    task_ids: Array.from({ length: taskCount }, (_, index) => `task_${index + 1}`),
    created_at: '2026-10-07T00:00:00.000Z',
  },
  tasks: Array.from({ length: taskCount }, (_, index) => ({
    task_id: `task_${index + 1}`,
    task_index: index,
  })),
});

const seedPromptDockStore = (): void => {
  usePromptDockStore.setState({
    form: 'generate',
    draft: {
      ...EMPTY_PROMPT_DOCK_DRAFT,
      prompt: '草稿原文 [[pp:preset-1]]',
      arguments: { size: 'auto' },
      references: [
        { refId: 'asset_1', assetId: 'asset_1', mediaType: 'image', label: '参考素材' },
      ],
      taskCount: 3,
    },
    catalog: [entry()],
    catalogLoaded: true,
    generationModelChosen: true,
    submitting: false,
    preflightIssues: null,
  });
};

const findTaskNodeByTaskId = (taskId: string) => {
  const graph = useCanvasStore.getState().nodeGraph;
  const node = graph?.nodes.find((n) => n.type === 'task' && (n.data as TaskNodeData).taskId === taskId);
  return node ? (node.data as TaskNodeData) : null;
};

const legalIntent = (overrides: Partial<ProgrammaticSubmitIntent> = {}): ProgrammaticSubmitIntent => ({
  modelId: 'model-a',
  prompt: '一只猫',
  args: {},
  refs: [{ assetId: 'asset_1' }],
  count: 2,
  promptPresetSnapshots: undefined,
  clientRequestId: undefined,
  ...overrides,
});

beforeEach(() => {
  resetCanvasStore();
  loadTestGraph();
  seedPromptDockStore();
  useCanvasStore.setState((state) => {
    state.mediaAssets = { asset_1: mediaAsset('asset_1') };
  });
  submitGenerationBatchMock.mockReset();
});

// ---------------------------------------------------------------------------
// 共享核心：构造路径 / 投影 / 选中反馈开关
// ---------------------------------------------------------------------------

describe('程序化提交共享核心（与界面提交同一构造路径）', () => {
  it('合法 intent 按界面同一形状构造提交请求（目录条目提供模型版本，引用素材解析媒体输入）', async () => {
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(2));

    // 目录条目带一个多张参考位：--ref 无用途时按设计 §8 兜底成「普通参考」，
    // 媒体条目随带该素材位的字段键（field_key 是后端分桶的显式绑定）。
    usePromptDockStore.setState({ catalog: [createCatalogEntryWithSlots(multiImageRefSlots)] });

    const outcome = await runGenerationBatchSubmission(legalIntent());

    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
    const request = submitGenerationBatchMock.mock.calls[0]?.[0];
    expect(request).toEqual({
      model_id: 'model-a',
      model_version: '1.0.0',
      prompt: '一只猫',
      arguments: {},
      media_inputs: [
        {
          media_kind: 'image',
          source_kind: 'attachment',
          value: 'local-media://demo/asset_1.png',
          mime_type: 'image/png',
          filename: null,
          field_key: 'image',
        },
      ],
      reference_asset_ids: ['asset_1'],
      task_count: 2,
      project_path: '/tmp/iart-programmatic-submit-test',
      mention_map: { image: { media_kind: 'image', index: 0 } },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.batchId).toBe('batch_1');
    expect(outcome.tasks.map((task) => task.task_id)).toEqual(['task_1', 'task_2']);
  });

  it('受理回执经真实投影创建任务节点并落位；界面路径（默认）选中新任务节点', async () => {
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['existing-node'];
    });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(2));

    const outcome = await runGenerationBatchSubmission(legalIntent());
    if (!outcome.ok) throw new Error('expected ok outcome');

    const taskNode1 = findTaskNodeByTaskId('task_1');
    const taskNode2 = findTaskNodeByTaskId('task_2');
    expect(taskNode1?.batchId).toBe('batch_1');
    expect(taskNode1?.modelId).toBe('model-a');
    expect(taskNode1?.taskIndex).toBe(0);
    expect(taskNode2?.taskIndex).toBe(1);
    // 界面路径受理后选中新任务节点（提交的第一时间用户反馈，既有语义）
    expect(useCanvasStore.getState().selectedNodeIds).not.toContain('existing-node');
    expect(useCanvasStore.getState().selectedNodeIds.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CLI 纯入口：受理结果 / 草稿不触碰 / 选中不触碰 / 错误映射
// ---------------------------------------------------------------------------

describe('CLI 程序化提交纯入口（CLI-008 / CLI-007）', () => {
  it('受理成功返回批次与任务身份，任务节点落位但不改画布选中态', async () => {
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['existing-node'];
    });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(2));

    const result = await submitGenerationBatchFromIntent(legalIntent());

    if (!result.ok) throw new Error('expected ok result');
    expect(result.acceptance.batch_id).toBe('batch_1');
    expect(result.acceptance.tasks.map((task) => task.task_id)).toEqual(['task_1', 'task_2']);
    // 落位照常（受理回执 → 任务节点创建与落位，与界面提交同一函数）
    expect(findTaskNodeByTaskId('task_1')).not.toBeNull();
    expect(findTaskNodeByTaskId('task_2')).not.toBeNull();
    // 不做选中反馈：用户可能正在选别的对象，画布选中态保持原样
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['existing-node']);
  });

  it('草稿与创作面 UI 状态不触碰：提交前后草稿内容与形态逐项不变', async () => {
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));
    const before = usePromptDockStore.getState();

    await submitGenerationBatchFromIntent(legalIntent());

    const after = usePromptDockStore.getState();
    // 引用相等断言：任何写入都会替换对象引用，比深比较更严格
    expect(after.draft).toBe(before.draft);
    expect(after.form).toBe(before.form);
    expect(after.submitting).toBe(before.submitting);
    expect(after.preflightIssues).toBe(before.preflightIssues);
    expect(after.agentBinding).toBe(before.agentBinding);
  });

  it('引用素材不存在 → invalid_reference 且 message 定位素材标识，不发起提交', async () => {
    const result = await submitGenerationBatchFromIntent(
      legalIntent({ refs: [{ assetId: 'ghost-asset' }] }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('invalid_reference');
    expect(result.error.message).toContain('ghost-asset');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('模型不在可执行目录 → model_not_available 且 message 定位模型标识', async () => {
    const result = await submitGenerationBatchFromIntent(
      legalIntent({ modelId: 'ghost-model', refs: [] }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('model_not_available');
    expect(result.error.message).toContain('ghost-model');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('模型不可执行（deployment 不可提交）→ model_not_available 携带失效原因', async () => {
    usePromptDockStore.setState({
      catalog: [
        {
          ...entry(),
          deployment: {
            has_active_deployment: true,
            active_deployment_id: 'dep_1',
            deployable: false,
            failure_code: 'credential_missing',
          },
        },
      ],
    });

    const result = await submitGenerationBatchFromIntent(legalIntent({ refs: [] }));

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('model_not_available');
    expect(result.error.message).toContain('model-a');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('必填参数缺失 → command_rejected 且 message 定位到具体参数名', async () => {
    usePromptDockStore.setState({
      catalog: [
        {
          ...entry(),
          parameter_schema: {
            fields: [
              {
                fieldKey: 'size',
                label: '画面尺寸',
                component: 'select',
                required: true,
                enumOptions: [{ value: 'auto', label: '自动' }],
              },
            ],
            required_fields: ['size'],
            default_values: {},
          },
        },
      ],
    });

    const result = await submitGenerationBatchFromIntent(legalIntent({ refs: [] }));

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    expect(result.error.message).toContain('size');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('参数取值不满足 schema（number 字段给非数值）→ command_rejected 且定位参数名', async () => {
    usePromptDockStore.setState({
      catalog: [
        {
          ...entry(),
          parameter_schema: {
            fields: [
              { fieldKey: 'steps', label: '步数', component: 'number', required: false },
            ],
            required_fields: [],
            default_values: {},
          },
        },
      ],
    });

    const result = await submitGenerationBatchFromIntent(
      legalIntent({ refs: [], args: { steps: 'abc' } }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    expect(result.error.message).toContain('steps');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('k=v 字符串取值按 schema 收敛类型后提交（switch → 布尔，number → 数值，枚举命中放行）', async () => {
    usePromptDockStore.setState({
      catalog: [
        {
          ...entry(),
          parameter_schema: {
            fields: [
              { fieldKey: 'enhance', label: '增强', component: 'switch', required: false },
              { fieldKey: 'steps', label: '步数', component: 'number', required: false },
              {
                fieldKey: 'quality',
                label: '画质',
                component: 'select',
                required: false,
                enumOptions: [{ value: 'auto', label: '自动' }, { value: 'hd', label: '高清' }],
              },
            ],
            required_fields: [],
            default_values: {},
          },
        },
      ],
    });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    const result = await submitGenerationBatchFromIntent(
      legalIntent({
        refs: [],
        args: { enhance: 'true', steps: '30', quality: 'hd' },
      }),
    );

    if (!result.ok) throw new Error('expected ok result');
    const request = submitGenerationBatchMock.mock.calls[0]?.[0];
    expect(request?.arguments).toEqual({ enhance: true, steps: 30, quality: 'hd' });
  });

  it('枚举参数取值不在可选值内 → command_rejected 且定位参数名', async () => {
    usePromptDockStore.setState({
      catalog: [
        {
          ...entry(),
          parameter_schema: {
            fields: [
              {
                fieldKey: 'quality',
                label: '画质',
                component: 'select',
                required: false,
                enumOptions: [{ value: 'auto', label: '自动' }],
              },
            ],
            required_fields: [],
            default_values: {},
          },
        },
      ],
    });

    const result = await submitGenerationBatchFromIntent(
      legalIntent({ refs: [], args: { quality: '4k' } }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    expect(result.error.message).toContain('quality');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('任务数越界（>10 或 <1）→ command_rejected，不发起提交', async () => {
    for (const count of [0, 11]) {
      const result = await submitGenerationBatchFromIntent(legalIntent({ count, refs: [] }));
      if (result.ok) throw new Error(`expected error result for count=${count}`);
      expect(result.error.code).toBe('command_rejected');
      expect(result.error.message).toContain(String(count));
    }
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('提交传输层失败 → internal_error 原样映射，不重试', async () => {
    submitGenerationBatchMock.mockRejectedValue(new Error('network boom'));

    const result = await submitGenerationBatchFromIntent(legalIntent());

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('internal_error');
    expect(result.error.message).toContain('network boom');
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
  });

  it('受理后投影创建失败（画布未就绪）→ internal_error 携带原因（受理已成立不回滚）', async () => {
    useCanvasStore.setState((state) => {
      state.nodeGraph = null;
    });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    const result = await submitGenerationBatchFromIntent(legalIntent());

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('internal_error');
    expect(result.error.message).toContain('画布');
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 受理幂等键（spec §5.4 受理幂等键 / CLI-033）
// ---------------------------------------------------------------------------

describe('受理幂等键（CLI-033 Editor 侧）', () => {
  it('intent 携带幂等键 → 提交请求携带 client_request_id', async () => {
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    const outcome = await runGenerationBatchSubmission(
      legalIntent({ clientRequestId: 'req-seam-echo', refs: [] }),
    );

    expect(outcome.ok).toBe(true);
    const request = submitGenerationBatchMock.mock.calls[0]?.[0];
    expect(request?.client_request_id).toBe('req-seam-echo');
  });

  it('界面形态（intent 不带幂等键）→ 提交请求不出现 client_request_id 键', async () => {
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    await runGenerationBatchSubmission(legalIntent({ refs: [] }));

    const request = submitGenerationBatchMock.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('client_request_id');
  });

  it('幂等重放（replayed: true）→ 不创建任务节点投影、outcome 标记 replayed，受理结果原样返回', async () => {
    submitGenerationBatchMock.mockResolvedValue({
      ...acceptanceResponse(2),
      replayed: true,
    });
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;

    const outcome = await runGenerationBatchSubmission(
      legalIntent({ clientRequestId: 'req-seam-replay' }),
    );

    if (!outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.replayed).toBe(true);
    expect(outcome.batchId).toBe('batch_1');
    expect(outcome.tasks.map((task) => task.task_id)).toEqual(['task_1', 'task_2']);
    // 重放不触发投影创建：画布无新增节点（既有投影由画布既有恢复/通知机制持有）
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
    expect(findTaskNodeByTaskId('task_1')).toBeNull();
    expect(findTaskNodeByTaskId('task_2')).toBeNull();
  });

  it('CLI 纯入口：重放回执携带幂等键回显与 replayed 标志；全新受理 replayed: false', async () => {
    submitGenerationBatchMock.mockResolvedValue({ ...acceptanceResponse(1), replayed: true });
    const replay = await submitGenerationBatchFromIntent(
      legalIntent({ clientRequestId: 'req-seam-replay', refs: [] }),
    );
    if (!replay.ok) throw new Error('expected ok result');
    expect(replay.acceptance.replayed).toBe(true);
    expect(replay.acceptance.client_request_id).toBe('req-seam-replay');

    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));
    const fresh = await submitGenerationBatchFromIntent(
      legalIntent({ clientRequestId: 'req-seam-fresh', refs: [] }),
    );
    if (!fresh.ok) throw new Error('expected ok result');
    expect(fresh.acceptance.replayed).toBe(false);
    expect(fresh.acceptance.client_request_id).toBe('req-seam-fresh');
  });
});

// ---------------------------------------------------------------------------
// CLI 契约参数 → 意图映射
// ---------------------------------------------------------------------------

describe('buildProgrammaticIntentFromCliParams（契约参数 → 提交意图）', () => {
  it('arg 键值对成参数记录（同名键后者覆盖并留痕）、count 缺省 1、ref 缺省空', () => {
    const intent = buildProgrammaticIntentFromCliParams({
      prompt: '一只猫',
      model: 'model-a',
      arg: [
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
        { key: 'b', value: 'z' },
      ],
    });

    expect(intent).toEqual({
      modelId: 'model-a',
      prompt: '一只猫',
      args: { a: '2', b: 'z' },
      refs: [],
      count: 1,
      promptPresetSnapshots: undefined,
      clientRequestId: undefined,
    });
  });

  it('count / ref 显式提供时原样进入意图（含用途）；wait 不进意图（轮询归主进程侧）', () => {
    const intent = buildProgrammaticIntentFromCliParams({
      prompt: 'x',
      model: 'm',
      count: 3,
      ref: [
        { asset_id: 'asset_9', slot_id: 'first_frame' },
        { asset_id: 'asset_10', slot_id: null },
      ],
      wait: true,
    });

    expect(intent.count).toBe(3);
    // 用途原样进入意图：CLI 已能做用途表达（--ref <id>:<用途>），意图层不得丢弃它。
    expect(intent.refs).toEqual([
      { assetId: 'asset_9', slotId: 'first_frame' },
      { assetId: 'asset_10', slotId: null },
    ]);
    expect('wait' in intent).toBe(false);
  });

  it('幂等键 client_request_id 进入意图（受理幂等键链路起点，spec CLI-033）', () => {
    const intent = buildProgrammaticIntentFromCliParams({
      prompt: 'x',
      model: 'm',
      client_request_id: 'req-seam-1',
    });

    expect(intent.clientRequestId).toBe('req-seam-1');
  });
});

// ---------------------------------------------------------------------------
// 引用用途链路（设计 docs/editor/PromptDock参考区用途标注-design.md §5.2/§8）
//
// 0.6.5 回归的回归保护：用途在提交核心入口处丢失时，这几条用例必须变红。
// 种床刻意带 media_slots（目录条目 fixture 不带素材位会让用途判据恒不生效）。
// ---------------------------------------------------------------------------

describe('引用用途：意图携带 / §8 兜底 / 阻断文案可执行', () => {
  it('显式用途随提交下发为该素材位的字段键（界面路径同形状）', async () => {
    usePromptDockStore.setState({ catalog: [createCatalogEntryWithSlots(firstLastFrameSlots)] });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    const outcome = await runGenerationBatchSubmission(
      legalIntent({ refs: [{ assetId: 'asset_1', slotId: 'first_frame' }], count: 1 }),
    );

    expect(outcome.ok).toBe(true);
    const mediaInputs = submitGenerationBatchMock.mock.calls[0]?.[0].media_inputs;
    // 显式用途不被兜底改写：首帧就是首帧（后端据此分桶到 firstFrameImage）
    expect(mediaInputs?.[0]?.field_key).toBe('firstFrameImage');
  });

  it('未表达用途且模型只有一个多张位 → 按 §8 兜底成普通参考并受理成功', async () => {
    usePromptDockStore.setState({ catalog: [createCatalogEntryWithSlots(multiImageRefSlots)] });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    const outcome = await runGenerationBatchSubmission(
      legalIntent({ refs: [{ assetId: 'asset_1' }], count: 1 }),
    );

    expect(outcome.ok).toBe(true);
    expect(submitGenerationBatchMock.mock.calls[0]?.[0].media_inputs?.[0]?.field_key).toBe('image');
  });

  it('未表达用途且模型全是单张位 → 阻断，CLI 文案给出 --ref 可执行动作与可用用途', async () => {
    usePromptDockStore.setState({ catalog: [createCatalogEntryWithSlots(firstLastFrameSlots)] });

    const result = await submitGenerationBatchFromIntent(
      legalIntent({ refs: [{ assetId: 'asset_1', slotId: null }], count: 1 }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    // 不再让用户去画布点一个命令行提交读不到的位置：给的是 CLI 现场能完成的动作。
    expect(result.error.message).toContain('--ref');
    expect(result.error.message).toContain('first_frame');
    expect(result.error.message).not.toContain('画布创作区');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('未表达用途且模型只有一个单张位 → 不替调用方认定（§8 不兜底，阻断）', async () => {
    // 唯一候选但只能放一张：§4.3「加入参考」会直绑，§8「没表达用途」不绑。
    usePromptDockStore.setState({
      catalog: [
        createCatalogEntryWithSlots([
          {
            slotId: 'first_frame',
            fieldKey: 'firstFrameImage',
            required: false,
            maxFiles: 1,
            mediaKind: 'image',
            label: '首帧',
          },
        ]),
      ],
    });

    const result = await submitGenerationBatchFromIntent(
      legalIntent({ refs: [{ assetId: 'asset_1' }], count: 1 }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    expect(result.error.message).toContain('first_frame');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('用途不属于当前模型 → 阻断且点名该用途，不发起提交', async () => {
    usePromptDockStore.setState({ catalog: [createCatalogEntryWithSlots(multiImageRefSlots)] });

    const result = await submitGenerationBatchFromIntent(
      legalIntent({ refs: [{ assetId: 'asset_1', slotId: 'last_frame' }], count: 1 }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    expect(result.error.message).toContain('last_frame');
    expect(result.error.message).toContain('reference_image');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('CLI --ref 用途经意图进入提交体（端到端：参数 → 意图 → field_key）', async () => {
    // 首帧改为非必填：本用例只验证「用途一路传到 field_key」，不叠加必填位阻断。
    usePromptDockStore.setState({
      catalog: [
        createCatalogEntryWithSlots(
          firstLastFrameSlots.map((slot) => ({ ...slot, required: false })),
        ),
      ],
    });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(1));

    const intent = buildProgrammaticIntentFromCliParams({
      prompt: '一只猫',
      model: 'model-a',
      ref: [{ asset_id: 'asset_1', slot_id: 'last_frame' }],
      count: 1,
    });
    const result = await submitGenerationBatchFromIntent(intent);

    if (!result.ok) throw new Error(`expected ok result, got ${result.error.message}`);
    expect(submitGenerationBatchMock.mock.calls[0]?.[0].media_inputs?.[0]?.field_key).toBe(
      'lastFrameImage',
    );
  });
});
