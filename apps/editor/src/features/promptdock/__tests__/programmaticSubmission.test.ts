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

const entry = (modelId = 'model-a'): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
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
  refAssetIds: ['asset_1'],
  count: 2,
  promptPresetSnapshots: undefined,
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
      legalIntent({ refAssetIds: ['ghost-asset'] }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('invalid_reference');
    expect(result.error.message).toContain('ghost-asset');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('模型不在可执行目录 → model_not_available 且 message 定位模型标识', async () => {
    const result = await submitGenerationBatchFromIntent(
      legalIntent({ modelId: 'ghost-model', refAssetIds: [] }),
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

    const result = await submitGenerationBatchFromIntent(legalIntent({ refAssetIds: [] }));

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

    const result = await submitGenerationBatchFromIntent(legalIntent({ refAssetIds: [] }));

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
      legalIntent({ refAssetIds: [], args: { steps: 'abc' } }),
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
        refAssetIds: [],
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
      legalIntent({ refAssetIds: [], args: { quality: '4k' } }),
    );

    if (result.ok) throw new Error('expected error result');
    expect(result.error.code).toBe('command_rejected');
    expect(result.error.message).toContain('quality');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('任务数越界（>10 或 <1）→ command_rejected，不发起提交', async () => {
    for (const count of [0, 11]) {
      const result = await submitGenerationBatchFromIntent(legalIntent({ count, refAssetIds: [] }));
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
      refAssetIds: [],
      count: 1,
      promptPresetSnapshots: undefined,
    });
  });

  it('count / ref 显式提供时原样进入意图；wait 不进意图（轮询归主进程侧）', () => {
    const intent = buildProgrammaticIntentFromCliParams({
      prompt: 'x',
      model: 'm',
      count: 3,
      ref: ['asset_9'],
      wait: true,
    });

    expect(intent.count).toBe(3);
    expect(intent.refAssetIds).toEqual(['asset_9']);
    expect('wait' in intent).toBe(false);
  });
});
