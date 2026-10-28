import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OverlayEscapeDispatcher } from '@iart/ui';
import type { GraphNode } from '@/features/canvas/types/node';

/**
 * Agent 节点选中态工具栏（spec docs/agent/02「选中态工具栏」「撤销重做与删除」；
 * 解散/删除双动作口径见 AG-CT-010 / AG-CT-011 与 docs/editor/画布对象右键菜单.md CM-025）。
 *
 * 本测试只验证接线与调用顺序：
 * - 选中集判定：全 agent 才呈现，混合/非 agent 不呈现；
 * - 使用 agent 调钉死导出；
 * - 解散（仅容器形态出现）→ 调 dissolveAgentContainer（不删节点、不经删除路径）；
 * - 删除 → 只开删除确认请求（requestAgentDeleteConfirm），不经确认不删除；
 *   键盘 Delete 同一确认通道（禁旁路）。
 */

const mocks = vi.hoisted(() => ({
  cancelAgentSessionForNode: vi.fn(),
  enterAgentFormForNode: vi.fn(),
  removeNode: vi.fn(),
  removeNodes: vi.fn(),
  dissolveAgentContainer: vi.fn(),
  requestAgentDeleteConfirm: vi.fn(),
  clearAgentDeleteConfirmRequest: vi.fn(),
  saveToHistory: vi.fn(),
  successToast: vi.fn(),
  /** PromptDock store 的形态/绑定事实源（幂等态判定读它） */
  promptDock: {
    state: {
      form: 'generate' as 'generate' | 'agent',
      agentBinding: null as { nodeId: string; agentSessionId: string } | null,
    },
  },
}));

const storeRef: { state: Record<string, unknown> } = { state: {} };

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: (...args: unknown[]) => {
      mocks.successToast(...args);
    },
    warning: vi.fn(),
  },
}));

vi.mock('../../../store/canvasStore', () => ({
  useCanvasStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeRef.state),
    {
      getState: () => storeRef.state,
      setState: (fn: (s: Record<string, unknown>) => void) => fn(storeRef.state),
    },
  ),
  markNodeDirty: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({
      transform: [0, 0, 1],
      nodeLookup: new Map(
        ((storeRef.state['nodeGraph'] as { nodes: Array<{ id: string }> })?.nodes ?? []).map(
          (n) => [
            n.id,
            {
              internals: { positionAbsolute: { x: 0, y: 0 }, z: 1 },
              measured: { width: 240, height: 96 },
              dragging: false,
            },
          ],
        ),
      ),
    }),
}));

// 钉死的动作锚点：会话终止属删除确认宿主职责，chrome 侧不再直接调用；
// 本测试钉 chrome → 确认请求通道 / 解散 store 动作的接线。
vi.mock('@/features/agent/agentSessionStore', () => ({
  cancelAgentSessionForNode: mocks.cancelAgentSessionForNode,
}));
// PromptDock store：只消费「是否已处于该会话」这一个派生值（幂等态视觉）。
vi.mock('@/features/promptdock/promptDockStore', () => ({
  enterAgentFormForNode: mocks.enterAgentFormForNode,
  usePromptDockStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mocks.promptDock.state),
}));
// 资产工具执行器与 Agent 工具栏无关，仅为隔离 useChromePlacement 所在模块的传递依赖。
vi.mock('../mediaToolExecutors', () => ({
  runDirectTransform: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/client/config/runtimeModelSelection', () => ({
  listRuntimeProjectedImageToImageModels: () => [],
}));

import { AgentNodeChrome } from '../AgentNodeChrome';

const agentNode = (id: string, agentSessionId = `session-${id}`): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: `Agent ${id}`, agentSessionId },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const assetNodeFor = (id: string): GraphNode => ({
  ...agentNode(id),
  type: 'asset',
});

const textNodeFor = (id: string, groupId: string | undefined): GraphNode => ({
  id,
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
  groupId,
});

const seedStore = (nodes: GraphNode[], selectedNodeIds: string[]) => {
  storeRef.state = {
    nodeGraph: { id: 'g1', nodes, annotations: [] },
    selectedNodeIds,
    removeNode: mocks.removeNode,
    removeNodes: mocks.removeNodes,
    dissolveAgentContainer: mocks.dissolveAgentContainer,
    requestAgentDeleteConfirm: mocks.requestAgentDeleteConfirm,
    clearAgentDeleteConfirmRequest: mocks.clearAgentDeleteConfirmRequest,
    saveToHistory: mocks.saveToHistory,
    historyBatchActive: false,
    pendingAgentDeleteConfirmNodeIds: null,
  };
};

const renderChrome = () => {
  const canvasRef = { current: document.createElement('div') };
  return render(
    <>
      {/* 真实分发器：Esc 必须经浮层栈派发（spec docs/editor/浮层堆栈管理.md） */}
      <OverlayEscapeDispatcher />
      <AgentNodeChrome canvasRef={canvasRef} />
    </>,
  );
};

const query = (selector: string) =>
  document.querySelector(selector) as HTMLElement | null;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.cancelAgentSessionForNode.mockResolvedValue(undefined);
  mocks.enterAgentFormForNode.mockReturnValue(true);
  mocks.dissolveAgentContainer.mockReturnValue(true);
  mocks.promptDock.state = { form: 'generate', agentBinding: null };
});

describe('AgentNodeChrome · 选中集判定', () => {
  it('单选无成员 Agent 节点（单节点形态）→ 工具栏呈现「使用 agent｜删除」，不出现「解散」', () => {
    seedStore([agentNode('n1')], ['n1']);
    renderChrome();
    expect(screen.getByTestId('agent-chrome-bottom')).toBeTruthy();
    expect(query('[data-act="use-agent"]')?.textContent).toContain('使用 agent');
    // 无成员＝单节点形态，无组织关系可解除，不出现「解散」（AG-CT-010）
    expect(query('[data-act="dissolve"]')).toBeNull();
    expect(query('[data-act="del"]')?.textContent).toContain('删除');
    expect(query('[data-act="expand"]')).toBeNull();
  });

  it('单选容器形态 Agent 节点（有成员）→ 呈现「使用 agent｜解散｜删除」三动作', () => {
    seedStore(
      [agentNode('n1'), textNodeFor('m1', 'n1')],
      ['n1'],
    );
    renderChrome();
    expect(query('[data-act="dissolve"]')?.textContent).toContain('解散');
    expect(query('[data-act="dissolve"]')?.getAttribute('aria-label')).toBe('解散容器');
    expect(query('[data-act="del"]')?.getAttribute('aria-label')).toBe('删除 Agent');
  });

  it('全 agent 多选 → 呈现「解散」「删除」，不呈现「使用 agent」', () => {
    seedStore(
      [agentNode('n1'), agentNode('n2'), textNodeFor('m1', 'n1')],
      ['n1', 'n2'],
    );
    renderChrome();
    expect(query('[data-act="use-agent"]')).toBeNull();
    expect(query('[data-act="dissolve"]')?.textContent).toContain('解散');
    expect(query('[data-act="del"]')?.textContent).toContain('删除');
  });

  it('混合选中（agent + 资产）→ 工具栏不呈现', () => {
    seedStore([agentNode('n1'), assetNodeFor('a1')], ['n1', 'a1']);
    const { container } = renderChrome();
    expect(container.textContent).toBe('');
    expect(query('[data-agent-node-chrome="bottom"]')).toBeNull();
  });

  it('非 agent 选中（任务节点）→ 工具栏不呈现', () => {
    seedStore([{ ...agentNode('t1'), type: 'task' }], ['t1']);
    const { container } = renderChrome();
    expect(container.textContent).toBe('');
  });
});

describe('AgentNodeChrome · 使用 agent', () => {
  it('点「使用 agent」→ 调 enterAgentFormForNode(nodeId, agentSessionId)', () => {
    seedStore([agentNode('n1', 's-1')], ['n1']);
    renderChrome();
    fireEvent.click(query('[data-act="use-agent"]') as HTMLElement);
    expect(mocks.enterAgentFormForNode).toHaveBeenCalledTimes(1);
    expect(mocks.enterAgentFormForNode).toHaveBeenCalledWith('n1', 's-1');
  });

  it('已处于该会话（agent 形态 + 绑定同一节点同一会话）→ 按钮呈已用态且禁用（幂等，不重复触发）', () => {
    mocks.promptDock.state = {
      form: 'agent',
      agentBinding: { nodeId: 'n1', agentSessionId: 's-1' },
    };
    seedStore([agentNode('n1', 's-1')], ['n1']);
    renderChrome();

    const button = query('[data-act="use-agent"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-active')).toBe('true');
    expect(mocks.enterAgentFormForNode).not.toHaveBeenCalled();
  });

  it('绑定的是别的会话（形态同为 agent）→ 按钮仍可点', () => {
    mocks.promptDock.state = {
      form: 'agent',
      agentBinding: { nodeId: 'n1', agentSessionId: 's-other' },
    };
    seedStore([agentNode('n1', 's-1')], ['n1']);
    renderChrome();

    const button = query('[data-act="use-agent"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('data-active')).toBeNull();
  });
});

describe('AgentNodeChrome · 解散（退出容器形态，AG-CT-010）', () => {
  it('点「解散」→ 调 dissolveAgentContainer（不删节点、不经删除路径），toast 钉死文案', () => {
    seedStore(
      [agentNode('n1'), textNodeFor('m1', 'n1')],
      ['n1'],
    );
    renderChrome();
    fireEvent.click(query('[data-act="dissolve"]') as HTMLElement);

    expect(mocks.dissolveAgentContainer).toHaveBeenCalledWith('n1');
    expect(mocks.removeNode).not.toHaveBeenCalled();
    expect(mocks.removeNodes).not.toHaveBeenCalled();
    expect(mocks.requestAgentDeleteConfirm).not.toHaveBeenCalled();
    expect(mocks.saveToHistory).toHaveBeenCalledTimes(1);
    expect(mocks.successToast).toHaveBeenCalledWith('容器已解散，Agent 和生成内容都保留');
  });

  it('多选解散 → 合批一次历史，逐容器调 dissolveAgentContainer', () => {
    seedStore(
      [
        agentNode('n1'),
        agentNode('n2'),
        textNodeFor('m1', 'n1'),
        textNodeFor('m2', 'n2'),
      ],
      ['n1', 'n2'],
    );
    renderChrome();
    fireEvent.click(query('[data-act="dissolve"]') as HTMLElement);

    expect(mocks.dissolveAgentContainer).toHaveBeenCalledTimes(2);
    expect(mocks.dissolveAgentContainer).toHaveBeenCalledWith('n1');
    expect(mocks.dissolveAgentContainer).toHaveBeenCalledWith('n2');
    expect(mocks.saveToHistory).toHaveBeenCalledTimes(1);
  });
});

describe('AgentNodeChrome · 删除（AG-CT-011：必须经确认框）', () => {
  it('点「删除」→ 只开删除确认请求，不直接删除', () => {
    seedStore([agentNode('n1')], ['n1']);
    renderChrome();
    fireEvent.click(query('[data-act="del"]') as HTMLElement);

    expect(mocks.requestAgentDeleteConfirm).toHaveBeenCalledWith(['n1']);
    expect(mocks.cancelAgentSessionForNode).not.toHaveBeenCalled();
    expect(mocks.removeNode).not.toHaveBeenCalled();
    expect(mocks.removeNodes).not.toHaveBeenCalled();
  });

  it('工具栏激活时 Delete 键走删除确认请求（禁旁路），不直接删除', () => {
    seedStore([agentNode('n1')], ['n1']);
    renderChrome();
    fireEvent.keyDown(document, { key: 'Delete' });

    expect(mocks.requestAgentDeleteConfirm).toHaveBeenCalledWith(['n1']);
    expect(mocks.removeNode).not.toHaveBeenCalled();
    expect(mocks.removeNodes).not.toHaveBeenCalled();
  });

  it('多选删除 → 确认请求携带全部选中 Agent 节点', () => {
    seedStore([agentNode('n1'), agentNode('n2')], ['n1', 'n2']);
    renderChrome();
    fireEvent.click(query('[data-act="del"]') as HTMLElement);

    expect(mocks.requestAgentDeleteConfirm).toHaveBeenCalledWith(['n1', 'n2']);
  });
});
