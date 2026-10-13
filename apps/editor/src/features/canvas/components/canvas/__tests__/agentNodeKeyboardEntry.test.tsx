import { useCallback, useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { nodeRegistry } from '@/features/canvas/nodes/registry';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import { enterAgentFormFromSelection, usePromptDockAgentEntryRestore } from '@/features/promptdock/agentEntry';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useRightWorkspaceStore } from '@/features/rightworkspace/rightWorkspaceStore';
import { useCanvasInteractionController } from '../useCanvasInteractionController';
import { useNodeCanvasKeyboardShortcuts } from '../useNodeCanvasKeyboardShortcuts';

/**
 * Agent 节点的键盘等价与 Esc 退一层（spec docs/agent/02「选中态工具栏·键盘等价」、
 * docs/agent/06「键盘与焦点」）。
 *
 * 接缝性质：真实画布选择事实源 + 真实 PromptDock store + 真实控制器/键盘链，
 * DOM 上复刻 React Flow 的节点容器（`.react-flow__node[data-id]`，它是节点的 Tab 停靠点）。
 * 保护：Enter 等价普通单击（选中并进入其会话）；非 Agent 节点上 Enter 不越权；
 * Esc 未粘滞时还原快照（不动选择），已粘滞/无快照时清选择并把焦点交回画布。
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const AGENT_NODE_ID = 'agent-node-1';
const TASK_NODE_ID = 'task-node-1';
const MEMBER_NODE_ID = 'member-node-1';
const SESSION_ID = 'sess_1';

const graphWith = (nodes: GraphNode[]): NodeGraph => ({
  id: 'graph-1',
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
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const agentNode = (): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 10, y: 20 },
    data: { label: 'Agent', agentSessionId: SESSION_ID },
  }),
  id: AGENT_NODE_ID,
});

const taskNode = (): GraphNode => {
  const node = nodeRegistry.createNode('imageInput', { x: 0, y: 0 }, undefined);
  if (!node) throw new Error('imageInput 节点定义未注册');
  return { ...node, id: TASK_NODE_ID };
};

/** Agent 容器成员（图片素材节点，成员侧 groupId 指向容器）。 */
const memberNode = (): GraphNode => ({ ...taskNode(), id: MEMBER_NODE_ID, groupId: AGENT_NODE_ID });

function KeyboardHarness() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodeHostRef = useRef<HTMLDivElement | null>(null);
  const selectNodes = useCallback((nodeIds: string[]) => {
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: nodeIds,
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
  }, []);
  const clearCanvasSelection = useCallback(() => {
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
  }, []);

  const controller = useCanvasInteractionController({
    contextMenuOpen: false,
    setContextMenu: () => undefined,
    closeContextMenu: () => undefined,
    screenToFlowPosition: (position) => position,
    containerGeometries: [],
    applySelectionCommand: () => undefined,
    selectNodes,
    selectAnnotations: () => undefined,
    clearCanvasSelection,
    pendingPlacement: null,
    createCharacterImageNode: async () => undefined,
    completePlacement: () => undefined,
    pendingAnnotationBinding: null,
    bindAnnotation: () => false,
    cancelAnnotationBinding: () => undefined,
    startMarquee: () => undefined,
    skipNextPaneClickRef: { current: false },
    cancelMarquee: () => undefined,
  });

  useNodeCanvasKeyboardShortcuts({
    pendingPlacement: null,
    cancelPlacement: () => undefined,
    pendingAnnotationBinding: null,
    cancelAnnotationBinding: () => undefined,
    cancelMarquee: null,
    clearCanvasSelection,
    canvasRef,
  });
  usePromptDockAgentEntryRestore();

  // 与 NodeCanvas 同一接法：原生监听 + React Flow 自己渲染的节点容器 DOM。
  useEffect(() => {
    const root = canvasRef.current;
    if (root === null) return;
    const listener = controller.onCanvasKeyDown;
    root.addEventListener('keydown', listener);
    return () => {
      root.removeEventListener('keydown', listener);
    };
  }, [controller.onCanvasKeyDown]);

  // 节点容器由 React Flow 渲染（tabIndex=0 的 Tab 停靠点），测试里按同一形状构造 DOM。
  useEffect(() => {
    const host = nodeHostRef.current;
    if (host === null) return;
    for (const nodeId of [AGENT_NODE_ID, TASK_NODE_ID, MEMBER_NODE_ID]) {
      const wrapper = document.createElement('div');
      wrapper.className = 'react-flow__node';
      wrapper.dataset.id = nodeId;
      wrapper.tabIndex = 0;
      wrapper.setAttribute(
        'data-testid',
        nodeId === AGENT_NODE_ID
          ? 'agent-node-wrapper'
          : nodeId === MEMBER_NODE_ID
            ? 'member-node-wrapper'
            : 'task-node-wrapper',
      );
      wrapper.textContent = nodeId;
      host.appendChild(wrapper);
    }
    return () => {
      host.replaceChildren();
    };
  }, []);

  return (
    <div ref={canvasRef} tabIndex={-1} data-testid="canvas-root">
      <div ref={nodeHostRef} data-testid="node-host" />
    </div>
  );
}

beforeEach(() => {
  cleanup();
  usePromptDockStore.setState({
    form: 'generate',
    agentBinding: null,
    agentEntrySnapshot: null,
    agentEntryFocusToken: 0,
  });
  useAgentSessionStore.setState({
    sessionsById: {
      [SESSION_ID]: {
        agentSessionId: SESSION_ID,
        nodeId: AGENT_NODE_ID,
        modelId: 'my-llm',
        thinkingTier: 'high',
        approvalMode: 'confirm',
        title: '画一只在雨中弹吉他的柴犬',
        createdAt: 1_770_000_000_000,
        updatedAt: 1_770_000_600_000,
        messageCount: 1,
        lastMessageAt: 1_770_000_600_000,
      },
    },
    sessionIdByNodeId: { [AGENT_NODE_ID]: SESSION_ID },
  });
  useCanvasStore.setState({
    nodeGraph: graphWith([agentNode(), taskNode(), memberNode()]),
    selectedNodeIds: [],
    selectedAnnotationIds: [],
  });
  useRightWorkspaceStore.setState({ activeKind: null, agentSessionId: null });
});

describe('Agent 节点键盘等价', () => {
  it('Tab 聚焦 Agent 节点后 Enter：等价普通单击（选中该节点并进入其会话）', () => {
    render(<KeyboardHarness />);
    const wrapper = screen.getByTestId('agent-node-wrapper');
    act(() => {
      wrapper.focus();
    });
    expect(document.activeElement).toBe(wrapper);

    act(() => {
      fireEvent.keyDown(wrapper, { key: 'Enter' });
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([AGENT_NODE_ID]);
    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: SESSION_ID,
    });
    // 选中驱动进入：记下进入前的形态与绑定，未粘滞时离开即还原
    expect(state.agentEntrySnapshot).not.toBeNull();
    // 键盘等价同样打开会话视图（spec 06「历史承载与会话视图」）
    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe(SESSION_ID);
  });

  // @spec: AG-CT-012
  it('Tab 聚焦容器成员后 Enter：等价普通单击（选中该成员并进入其容器会话）', () => {
    render(<KeyboardHarness />);
    const wrapper = screen.getByTestId('member-node-wrapper');
    act(() => {
      wrapper.focus();
    });

    act(() => {
      fireEvent.keyDown(wrapper, { key: 'Enter' });
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([MEMBER_NODE_ID]);
    const state = usePromptDockStore.getState();
    expect(state.form).toBe('agent');
    // 绑定与快照锚点恒为容器节点，不是被点的成员
    expect(state.agentBinding).toEqual({
      nodeId: AGENT_NODE_ID,
      agentSessionId: SESSION_ID,
    });
    expect(state.agentEntrySnapshot).not.toBeNull();
    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe(SESSION_ID);
  });

  it('非 Agent 容器作用域内的节点上按 Enter：不进入、不改选择', () => {
    render(<KeyboardHarness />);
    const wrapper = screen.getByTestId('task-node-wrapper');
    act(() => {
      wrapper.focus();
      fireEvent.keyDown(wrapper, { key: 'Enter' });
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
    expect(usePromptDockStore.getState().form).toBe('generate');
    expect(usePromptDockStore.getState().agentEntrySnapshot).toBeNull();
  });
});

describe('Esc 退一层', () => {
  it('有待还原快照（未粘滞）→ 还原进入前的形态与绑定', () => {
    render(<KeyboardHarness />);
    act(() => {
      useCanvasStore.getState().projectSelectionContract({
        selectedNodeIds: [AGENT_NODE_ID],
        selectedAnnotationIds: [],
        editingAnnotationId: null,
        pendingAnnotationBinding: null,
      });
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });
    expect(usePromptDockStore.getState().form).toBe('agent');

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });

    const state = usePromptDockStore.getState();
    expect(state.form).toBe('generate');
    expect(state.agentBinding).toBeNull();
    expect(state.agentEntrySnapshot).toBeNull();
  });

  it('无待还原快照（已粘滞）→ 清除选择并把焦点交回画布', () => {
    render(<KeyboardHarness />);
    act(() => {
      useCanvasStore.getState().projectSelectionContract({
        selectedNodeIds: [AGENT_NODE_ID],
        selectedAnnotationIds: [],
        editingAnnotationId: null,
        pendingAnnotationBinding: null,
      });
      enterAgentFormFromSelection(AGENT_NODE_ID);
      // 受理即粘滞：快照清除，此后 Esc 落到「清选择、焦点回画布」
      usePromptDockStore.getState().markAgentSessionCurrent(SESSION_ID);
    });
    expect(usePromptDockStore.getState().agentEntrySnapshot).toBeNull();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
    expect(usePromptDockStore.getState().form).toBe('agent');
    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
  });

  it('焦点在输入控件内时让位给控件（不还原、不清选择）', () => {
    render(<KeyboardHarness />);
    act(() => {
      useCanvasStore.getState().projectSelectionContract({
        selectedNodeIds: [AGENT_NODE_ID],
        selectedAnnotationIds: [],
        editingAnnotationId: null,
        pendingAnnotationBinding: null,
      });
      enterAgentFormFromSelection(AGENT_NODE_ID);
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(usePromptDockStore.getState().form).toBe('agent');
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([AGENT_NODE_ID]);
    input.remove();
  });
});
