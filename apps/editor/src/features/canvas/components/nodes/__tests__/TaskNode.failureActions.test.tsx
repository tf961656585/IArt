// @spec: FTB-014, CM-032
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import type * as PromptDockApiModule from '@/client/api/promptDockApi';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { TaskNodeData } from '@/features/canvas/types/node';
import { cast } from '@/lib/utils';
import { TaskNode } from '../TaskNode';

/**
 * 失败任务卡片的动作渲染与重新查询交互（spec：docs/editor/失败任务重新查询-design.md
 * §5 状态机 / §7 文案 / §8 错误边界）。
 *
 * 保护：
 * - 查询类失败显示「重新查询结果」+「重新生成」+「删除任务」；
 * - 提交类/无阶段失败只显示「重试」+「删除任务」，不出现重新生成；
 * - 点击重新查询后保持失败卡、主按钮进入 pending 且三个动作 aria-disabled；
 * - 后端拒绝时原位显示用户文案，按钮恢复；
 * - 重新查询后的等待态显示胶囊副行「重新查询结果」；
 * - 密钥缺失失败（credential_missing）额外显示次级动作「去填写密钥」，点击触发跨窗口
 *   聚焦 Hub 服务商设置；其他失败码不出现该动作。
 */

const { requeryTaskMock, reuseTaskToDraftMock, focusHubModelProvidersMock } = vi.hoisted(() => ({
  requeryTaskMock: vi.fn(),
  reuseTaskToDraftMock: vi.fn(),
  focusHubModelProvidersMock: vi.fn(),
}));

vi.mock('@/client/api/promptDockApi', async (importOriginal) => {
  const actual = await importOriginal<typeof PromptDockApiModule>();
  return { ...actual, requeryTask: requeryTaskMock };
});

vi.mock('@/features/promptdock/assetReuse', () => ({
  reuseTaskToDraft: reuseTaskToDraftMock,
}));

vi.mock('@/features/promptdock/hubFocus', () => ({
  focusHubModelProviders: focusHubModelProvidersMock,
}));

const GRAPH_ID = 'graph-task-failure-actions';
const NODE_ID = 'task-node-1';
const TASK_ID = 'task-1';
const MODEL_ID = 'veo_3_1-fast';

const graphWith = (nodes: GraphNode[]): NodeGraph => ({
  id: GRAPH_ID,
  name: 'test',
  description: undefined,
  status: 'draft',
  nodes,
  annotations: [],
  variables: undefined,
  settings: undefined,
  viewport: { x: 0, y: 0, zoom: 1 },
  meta: {
    version: '1.0.0',
    schemaVersion: undefined,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const taskNode = (data: Partial<TaskNodeData> = {}): GraphNode<TaskNodeData> => ({
  ...createGraphNode<TaskNodeData>({
    type: 'task',
    position: { x: 0, y: 0 },
    data: {
      label: MODEL_ID,
      modelId: MODEL_ID,
      taskId: TASK_ID,
      taskIndex: 0,
      batchId: 'batch-1',
      status: 'failed',
      progressPercent: null,
      progressPhase: null,
      errorMessage: null,
      failure: {
        code: 'result_output_mapping_missed',
        message: '结果输出映射未命中正式输出',
        stage: 'result_mapping',
      },
      remoteRequestId: 'remote-request-1',
      requeryCount: 0,
      createdAt: 1,
      updatedAt: 2,
      ...data,
    },
  }),
  id: NODE_ID,
});

const renderNode = (data: Partial<TaskNodeData> = {}): void => {
  useCanvasStore.setState({ nodeGraph: graphWith([taskNode(data)]) });
  render(<TaskNode {...cast<NodeProps>({ id: NODE_ID, selected: false })} />);
};

beforeEach(() => {
  cleanup();
  requeryTaskMock.mockReset();
  reuseTaskToDraftMock.mockReset();
  focusHubModelProvidersMock.mockReset();
  useCanvasStore.setState({ nodeGraph: null });
});

afterEach(() => {
  cleanup();
});

describe('TaskNode 失败动作', () => {
  it('查询类失败：主重新查询 + 次重新生成 + 危险删除，摘要用阶段兜底文案', () => {
    renderNode();

    const group = screen.getByRole('group', { name: `任务 #1 · ${MODEL_ID} 失败` });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新查询任务 #1 的结果' })).toHaveTextContent(
      '重新查询结果',
    );
    expect(screen.getByRole('button', { name: '用任务 #1 的原配置重新生成' })).toHaveTextContent(
      '重新生成',
    );
    expect(screen.getByRole('button', { name: '删除任务 #1' })).toHaveTextContent('删除任务');
    expect(screen.getByText('服务返回了结果，但没能识别出可用的内容。')).toBeInTheDocument();
    // 失败态外部徽章组不渲染，任务身份由 overlay 头部承载
    expect(screen.getByTitle(`任务 #1 · ${MODEL_ID}`)).toHaveTextContent(`任务 #1 · ${MODEL_ID}`);
  });

  it('提交类失败：只显示重试 + 删除，不出现重新生成', () => {
    renderNode({
      failure: {
        code: 'task_execution_failed',
        message: '提交失败',
        stage: 'submit',
      },
    });

    expect(screen.getByRole('button', { name: '重试任务 #1' })).toHaveTextContent('重试');
    expect(screen.queryByRole('button', { name: '用任务 #1 的原配置重新生成' })).toBeNull();
    expect(screen.getByRole('button', { name: '删除任务 #1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试任务 #1' }));
    // 复用按来源任务定位所属意图（多意图批次回填对应提示词），故带上 taskId。
    expect(reuseTaskToDraftMock).toHaveBeenCalledWith({
      batchId: 'batch-1',
      modelId: MODEL_ID,
      taskId: 'task-1',
    });
    expect(requeryTaskMock).not.toHaveBeenCalled();
  });

  it('点击重新查询：保持失败卡、主按钮进入 pending，三个动作 aria-disabled', async () => {
    requeryTaskMock.mockResolvedValue({
      accepted: true,
      taskId: TASK_ID,
      status: 'polling',
      requestedAt: '2026-10-28T00:00:00.000Z',
    });
    renderNode();

    fireEvent.click(screen.getByRole('button', { name: '重新查询任务 #1 的结果' }));

    const pendingPrimary = screen.getByRole('button', {
      name: '正在重新查询任务 #1 的结果',
    });
    expect(pendingPrimary).toHaveTextContent('正在重新查询…');
    expect(pendingPrimary).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: '用任务 #1 的原配置重新生成' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: '删除任务 #1' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await waitFor(() => expect(requeryTaskMock).toHaveBeenCalledWith(TASK_ID));
  });

  it('后端拒绝：原位显示用户文案，按钮恢复可点', async () => {
    requeryTaskMock.mockRejectedValue({
      message: 'HTTP 409',
      status: 409,
      body: { code: 'connection_unavailable', message: 'internal detail' },
    });
    renderNode();

    fireEvent.click(screen.getByRole('button', { name: '重新查询任务 #1 的结果' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(
      '没能重新查询：这个任务原来的服务商连接已经不可用。检查服务商设置，或用「重新生成」新建一次任务。',
    );
    expect(error).not.toHaveTextContent('internal detail');
    expect(screen.getByRole('button', { name: '重新查询任务 #1 的结果' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByRole('button', { name: '用任务 #1 的原配置重新生成' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('重新查询后的等待态：胶囊副行显示「重新查询结果」', () => {
    renderNode({
      status: 'polling',
      failure: null,
      requeryCount: 1,
      progressPercent: null,
      progressPhase: null,
    });

    expect(screen.getByText('重新查询结果')).toBeInTheDocument();
    expect(screen.getByText('等待结果…')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: `任务 #1 · ${MODEL_ID} 失败` })).toBeNull();
  });

  it('密钥缺失失败：失败提示旁显示次级动作「去填写密钥」，点击聚焦 Hub 服务商设置', () => {
    renderNode({
      failure: {
        code: 'credential_missing',
        message: 'credential missing',
        userMessage: '没能读取这个服务商的密钥，请到「设置 → 服务商与模型」重新填写。',
        details: { reason: 'unreadable' },
      },
    });

    // 摘要仍由 userMessage 承载，文案优先级未被改动
    expect(
      screen.getByText('没能读取这个服务商的密钥，请到「设置 → 服务商与模型」重新填写。'),
    ).toBeInTheDocument();
    // 既有动作顺序与权重不变：主「重试」仍在首位
    expect(screen.getByRole('button', { name: '重试任务 #1' })).toHaveTextContent('重试');
    expect(screen.getByRole('button', { name: '删除任务 #1' })).toBeInTheDocument();

    const credentialFix = screen.getByRole('button', { name: '去填写密钥' });
    expect(credentialFix).toHaveTextContent('去填写密钥');

    fireEvent.click(credentialFix);
    expect(focusHubModelProvidersMock).toHaveBeenCalledTimes(1);
    // 跨窗口动作不触发任何任务命令
    expect(requeryTaskMock).not.toHaveBeenCalled();
    expect(reuseTaskToDraftMock).not.toHaveBeenCalled();
  });

  it('其他失败码不出现「去填写密钥」', () => {
    renderNode({
      failure: {
        code: 'task_execution_failed',
        message: '提交失败',
        stage: 'submit',
      },
    });

    expect(screen.getByRole('button', { name: '重试任务 #1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去填写密钥' })).toBeNull();
  });
});

/**
 * 失败卡信息分层（docs/editor/失败任务重新查询-design.md §6/§7.2）：
 * 卡片内只放两行钳制摘要，完整摘要 / 错误码 / 服务返回原文由「错误详情」弹窗承载。
 */
describe('TaskNode 失败卡信息可读性', () => {
  const LONG_MESSAGE =
    '服务商在等待 107 秒后断开了连接（阶段：提交请求）。若反复出现，可尝试降低图片尺寸或参考图数量后重新提交';

  const longFailure = (): Partial<TaskNodeData> => ({
    failure: {
      code: 'connection_dropped',
      stage: 'submit',
      userMessage: LONG_MESSAGE,
      backendMessage: '{"error":"socket hang up"}',
      details: { phase: 'requesting', elapsedMs: 107000 },
    },
  });

  it('摘要固定两行钳制，内联详情折叠不再渲染', () => {
    renderNode(longFailure());

    const summary = screen.getByText(LONG_MESSAGE);
    expect(summary).toHaveClass('sum-clamp-2');
    // 卡片内不再有第二套阅读面：既没有 <details>，也没有旧的详情样式钩子
    expect(document.querySelector('details')).toBeNull();
    expect(document.querySelector('.failure-details')).toBeNull();
  });

  it('短摘要失败同样显示「错误详情」入口', () => {
    renderNode({
      failure: { code: 'submit_failed', stage: 'submit', userMessage: '提交失败。' },
    });

    expect(screen.getByText('提交失败。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看任务 #1 的详情' })).toBeInTheDocument();
  });

  it('点「错误详情」打开弹窗，展示完整摘要、错误码与服务返回原文', async () => {
    renderNode(longFailure());

    fireEvent.click(screen.getByRole('button', { name: '查看任务 #1 的详情' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(LONG_MESSAGE);
    expect(dialog).toHaveTextContent('connection_dropped');
    expect(dialog).toHaveTextContent('socket hang up');
  });

  it('关闭弹窗后焦点回到「错误详情」入口', async () => {
    renderNode(longFailure());

    const entry = screen.getByRole('button', { name: '查看任务 #1 的详情' });
    fireEvent.click(entry);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(entry).toHaveFocus();
  });
});
