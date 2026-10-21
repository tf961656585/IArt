import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  cancelTask: vi.fn(),
  submitGenerationBatch: vi.fn(),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  __esModule: true,
  getRuntimeProjectPath: () => '/tmp/iart-cli-generate-test',
}));

import { CliProxyCommandResponseSchema, CliProxyCommandSchema } from '@iart/contracts';
import type {
  CliProxyCommandResponse,
  ExecutableModelDirectoryEntry,
  MediaAsset,
  PromptDockBatchSubmitResponse,
} from '@iart/contracts';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import type { TaskNodeData } from '@/features/canvas/types/node';
import { createCatalogEntryWithSlots, multiImageRefSlots } from '@/features/promptdock/__tests__/fixtures/promptDockCatalogEntry';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode } from '../../types';
import { executeCliProxyCommand, handleCliProxyPayload } from '../cliProxyReceiver';

/**
 * CLI 代理执行通道 · generate 命令端到端（spec docs/integrations/CLI与本地Agent集成.md
 * §6.3 代理执行通道 / §6.4 程序化提交；验收 CLI-007 / CLI-008 Editor 侧映射部分）。
 *
 * 命令经真实 CliProxyCommandSchema 构造（双端 schema 校验纪律，CLI-014），响应逐条过
 * CliProxyCommandResponseSchema.parse；提交链 mock 在 HTTP 边界（submitGenerationBatch），
 * 前置校验、受理回执处理与任务节点投影全部走真实实现（真实 canvasStore 种床）。
 *
 * @spec: CLI-007, CLI-008
 */

const submitGenerationBatchMock = vi.mocked(submitGenerationBatch);

// ---------------------------------------------------------------------------
// store 种床（沿 cliProxyReceiver.test.ts 惯例：真实 store + setState 种数据）
// ---------------------------------------------------------------------------

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-proxy-generate-test',
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

/**
 * 目录条目带一个多张参考位（真实图像编辑族的形状）：`--ref` 不带用途时按设计 §8 兜底成
 * 「普通参考」并带 field_key 下发给后端。不带素材位的退化条目会让用途判据恒不生效。
 */
const catalogEntry = (): ExecutableModelDirectoryEntry =>
  createCatalogEntryWithSlots(multiImageRefSlots);

const acceptanceResponse = (taskCount: number): PromptDockBatchSubmitResponse => ({
  batch_id: 'batch_cli',
  intent_snapshot: {
    batch_id: 'batch_cli',
    model_id: 'model-a',
    model_version: '1.0.0',
    prompt: '一只猫在窗台',
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

/** 消费端纪律断言：响应必须能通过契约 schema parse，不合法让用例直接失败。 */
const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

const collectSend = (): {
  responses: CliProxyCommandResponse[];
  send: (payload: CliProxyCommandResponse) => void;
} => {
  const responses: CliProxyCommandResponse[] = [];
  return {
    responses,
    send: (payload) => {
      responses.push(payload);
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

const findTaskNodeData = (taskId: string): TaskNodeData | null => {
  const graph = useCanvasStore.getState().nodeGraph;
  const node = graph?.nodes.find(
    (n) => n.type === 'task' && (n.data as TaskNodeData).taskId === taskId,
  );
  return node ? (node.data as TaskNodeData) : null;
};

beforeEach(async () => {
  resetStore();
  await loadTestGraph();
  useCanvasStore.setState((state) => {
    state.mediaAssets = { asset_1: mediaAsset('asset_1') };
  });
  usePromptDockStore.setState({
    catalog: [catalogEntry()],
  });
  submitGenerationBatchMock.mockReset();
});

describe('CLI 代理执行通道 · generate（CLI-007/CLI-008 Editor 侧映射）', () => {
  it('端到端：真实 schema 构造命令 → 程序化提交 → 受理结果响应过契约 schema，任务节点落位且不选中', async () => {
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['existing-node'];
    });
    submitGenerationBatchMock.mockResolvedValue(acceptanceResponse(2));

    // 经真实 CliProxyCommandSchema 构造（双端 schema 校验纪律）
    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-gen-1',
      prompt: '一只猫在窗台',
      model: 'model-a',
      count: 2,
      ref: [{ asset_id: 'asset_1', slot_id: null }],
      arg: [{ key: 'size', value: '1024x1024' }],
      wait: true,
    });

    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('batch_id' in response)) {
      throw new Error('expected generate success response');
    }
    expect(response.command).toBe('generate');
    expect(response.request_id).toBe('req-gen-1');
    expect(response.batch_id).toBe('batch_cli');
    expect(response.tasks.map((task) => task.task_id)).toEqual(['task_1', 'task_2']);
    // 提交请求形状：k=v 参数按 schema 收敛类型后进入 arguments
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
    const request = submitGenerationBatchMock.mock.calls[0]?.[0];
    expect(request?.arguments).toEqual({ size: '1024x1024' });
    expect(request?.reference_asset_ids).toEqual(['asset_1']);
    // 受理回执 → 任务节点落位（与界面提交同一函数）；画布选中态保持原样
    expect(findTaskNodeData('task_1')?.batchId).toBe('batch_cli');
    expect(findTaskNodeData('task_2')?.batchId).toBe('batch_cli');
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['existing-node']);
  });

  it('前置校验失败映射经代理通道回传：引用素材不存在 → invalid_reference 且定位素材标识', async () => {
    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-gen-2',
      prompt: '一只猫在窗台',
      model: 'model-a',
      ref: [{ asset_id: 'ghost-asset', slot_id: null }],
    });

    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('error' in response)) {
      throw new Error('expected generate error response');
    }
    expect(response.error.code).toBe('invalid_reference');
    expect(response.error.message).toContain('ghost-asset');
    expect(response.request_id).toBe('req-gen-2');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });

  it('提交传输层失败 → internal_error 响应且不重试', async () => {
    submitGenerationBatchMock.mockRejectedValue(new Error('network boom'));
    const command = CliProxyCommandSchema.parse({
      command: 'generate',
      request_id: 'req-gen-3',
      prompt: '一只猫在窗台',
      model: 'model-a',
    });

    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('error' in response)) {
      throw new Error('expected generate error response');
    }
    expect(response.error.code).toBe('internal_error');
    expect(response.error.message).toContain('network boom');
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
  });

  it('generate 与画布命令共享同一串行队列：前一条受理完成前不开始下一条', async () => {
    type Acceptance = PromptDockBatchSubmitResponse;
    let resolveSubmit: (value: Acceptance) => void = () => undefined;
    submitGenerationBatchMock.mockImplementation(
      () =>
        new Promise<Acceptance>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    // 第二条命令的成员节点
    const graph = useCanvasStore.getState().nodeGraph;
    if (!graph) throw new Error('nodeGraph 为空');
    const memberNode: GraphNode = {
      id: 'n1',
      type: 'textInput',
      position: { x: 0, y: 0 },
      data: {
        label: undefined,
        description: undefined,
        runtimeRef: undefined,
        segments: [],
        lastExecutionId: undefined,
        lastSourceNodeId: undefined,
        lastSourcePortId: undefined,
        separator: undefined,
        customSeparator: undefined,
        promptPresetSnapshots: undefined,
        taskInfo: undefined,
        promptInterview: undefined,
      },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
    useCanvasStore.setState((state) => {
      if (state.nodeGraph) {
        state.nodeGraph.nodes.push(memberNode);
        state.structureRevision += 1;
      }
    });

    const { responses, send } = collectSend();
    const pending1 = handleCliProxyPayload(
      {
        command: 'generate',
        request_id: 'q-gen-1',
        prompt: '一只猫在窗台',
        model: 'model-a',
        count: 1,
      },
      send,
    );
    const pending2 = handleCliProxyPayload(
      { command: 'canvas.group.create', request_id: 'q-gen-2', name: '组', members: ['n1'] },
      send,
    );

    // 队列被 generate 占用中：建组命令尚未执行
    await flushMicrotasks();
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
    expect(
      (useCanvasStore.getState().nodeGraph?.nodes ?? []).filter((node) => node.type === 'group'),
    ).toHaveLength(0);

    resolveSubmit(acceptanceResponse(1));
    await Promise.all([pending1, pending2]);

    expect(responses.map((response) => response.command)).toEqual(['generate', 'canvas.group.create']);
    responses.forEach((response) => parseResponse(response));
  });

  it('非法 generate 载荷立即回错误响应且不进队列（request_id 原样携带）', async () => {
    const { responses, send } = collectSend();

    // 形状非法（缺 model）但 command/request_id 可识别：立即回错误响应
    await handleCliProxyPayload({ command: 'generate', request_id: 'q-gen-3', prompt: 'x' }, send);
    expect(responses).toHaveLength(1);
    const invalid = parseResponse(responses[0]);
    if (!('error' in invalid)) {
      throw new Error('expected invalid payload error response');
    }
    expect(invalid.error.code).toBe('internal_error');
    expect(invalid.request_id).toBe('q-gen-3');
    expect(submitGenerationBatchMock).not.toHaveBeenCalled();
  });
});
