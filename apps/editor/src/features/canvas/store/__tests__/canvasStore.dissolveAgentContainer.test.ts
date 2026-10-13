import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AgentNodeData, GraphNode, TextInputNodeData } from '../../types';

/**
 * Agent 容器「解散」＝退出容器形态（AG-CT-010，spec docs/agent/02「撤销重做与删除」）：
 * 全部成员 groupId 清空且原位保留、Agent 头节点不删除（随成员清空回落单节点形态）、
 * 会话与全部消息历史完整保留（不触发会话清理、不终止在途）、一次成员关系变更写一条历史
 * （撤销整体恢复成员关系与成员位置）。
 *
 * 删除（AG-CT-011）：删除 Agent 节点级联物理删除会话，不提供撤销兜底——历史栈为全图快照栈，
 * 仅跳过入栈不够（此前快照仍含被删 Agent，撤销会复活出会话已被清除的悬空节点），
 * 删除后以删除后状态重建唯一基线条目、撤销不可达（硬切）。
 *
 * 宿主搭建：画布 store 用真实实例（成员关系、历史、脏标记全走真实实现）。
 * agent 会话域整体 stub（features/agent 模块链与本测试无关；解散是 canvas store 动作，
 * 对会话域的唯一合法行为是「完全不触碰」——stub 态不变 + 不产生 removedNodes 脏标记共同钉住）。
 */

const agentSessionStub = vi.hoisted(() => {
  const state = {
    sessionsById: {} as Record<string, { agentSessionId: string; nodeId: string }>,
    sessionIdByNodeId: {} as Record<string, string>,
  };
  return {
    state,
    useAgentSessionStore: {
      getState: () => state,
      setState: (fn: (s: typeof state) => void) => fn(state),
    },
  };
});

vi.mock('@/features/agent/agentSessionStore', () => ({
  useAgentSessionStore: agentSessionStub.useAgentSessionStore,
  cancelAgentSessionForNode: vi.fn(async () => undefined),
  cancelAndForgetAgentSessions: vi.fn(),
  ensureAgentNodeRemovalPreflightRegistered: vi.fn(),
  loadAgentSessions: vi.fn(async () => undefined),
}));

const createTestGraph = () =>
  createNodeGraph({
    name: 'dissolve-agent-container-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = async () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
    state.pendingAgentDeleteConfirmNodeIds = null;
    state.dirty = {
      graph: false,
      viewport: false,
      fullReplace: false,
      mediaAssets: false,
      nodes: {},
      removedNodes: {},
    };
  });
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
};

const addAgentNode = (
  id: string,
  x = 0,
  y = 0,
): GraphNode<AgentNodeData> => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x, y },
    data: { label: 'Agent', agentSessionId: `session-${id}` },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
  return node;
};

const addMemberNode = (
  id: string,
  containerId: string,
  x = 0,
  y = 0,
): GraphNode<TextInputNodeData> => {
  const node: GraphNode<TextInputNodeData> = {
    id,
    type: 'textInput',
    position: { x, y },
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
    groupId: containerId,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
  return node;
};

const findNode = (id: string): GraphNode | undefined => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return undefined;
  return graph.nodes.find((n) => n.id === id);
};

const getGroupMemberCount = (containerId: string): number => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return 0;
  return graph.nodes.filter(
    (n) => n.type !== 'group' && n.groupId === containerId,
  ).length;
};

const seedAgentSession = (nodeId: string, agentSessionId: string) => {
  agentSessionStub.state.sessionsById[agentSessionId] = {
    agentSessionId,
    nodeId,
  };
  agentSessionStub.state.sessionIdByNodeId[nodeId] = agentSessionId;
};

beforeEach(async () => {
  vi.clearAllMocks();
  agentSessionStub.state.sessionsById = {};
  agentSessionStub.state.sessionIdByNodeId = {};
  await resetStore();
});

describe('dissolveAgentContainer：解散＝退出容器形态（AG-CT-010）', () => {
  // @spec: AG-CT-010, AG-CT-006
  it('有成员 Agent 容器解散：成员 groupId 清空且原位、Agent 节点保留（成员数为 0）、会话保留、无 removedNodes 脏标记', () => {
    addAgentNode('a1', 100, 100);
    addMemberNode('n1', 'a1', 120, 120);
    addMemberNode('n2', 'a1', 200, 200);
    const n1Pos = findNode('n1')?.position;
    const n2Pos = findNode('n2')?.position;
    seedAgentSession('a1', 'sess-a1');

    const dissolved = useCanvasStore.getState().dissolveAgentContainer('a1');

    expect(dissolved).toBe(true);
    // 成员保留原位、成员关系解除
    expect(findNode('n1')).toBeDefined();
    expect(findNode('n1')?.groupId).toBeUndefined();
    expect(findNode('n1')?.position).toEqual(n1Pos);
    expect(findNode('n2')).toBeDefined();
    expect(findNode('n2')?.groupId).toBeUndefined();
    expect(findNode('n2')?.position).toEqual(n2Pos);
    // Agent 头节点不删除，随成员清空回落单节点形态（成员数为 0）
    expect(findNode('a1')).toBeDefined();
    expect(getGroupMemberCount('a1')).toBe(0);
    // 会话与锚定完整保留（不触发会话清理）
    expect(agentSessionStub.state.sessionsById['sess-a1']).toBeTruthy();
    expect(agentSessionStub.state.sessionIdByNodeId['a1']).toBe('sess-a1');
    // 纯成员关系变更：不产生 removedNodes 脏标记（不触发存储删除链路）
    const dirty = useCanvasStore.getState().dirty;
    expect(Object.keys(dirty.removedNodes)).toEqual([]);
    expect(Object.keys(dirty.nodes)).toEqual(expect.arrayContaining(['n1', 'n2']));
  });

  // @spec: AG-CT-006
  it('解散写一条成员关系历史：undo 整体恢复成员关系与位置，redo 再次解除', () => {
    addAgentNode('a1', 100, 100);
    addMemberNode('n1', 'a1', 120, 120);
    addMemberNode('n2', 'a1', 200, 200);
    useCanvasStore.getState().saveToHistory();
    const baseline = useCanvasStore.getState().history.length;

    useCanvasStore.getState().dissolveAgentContainer('a1');
    expect(useCanvasStore.getState().history).toHaveLength(baseline + 1);
    expect(findNode('n1')?.groupId).toBeUndefined();

    useCanvasStore.getState().undo();
    expect(findNode('n1')?.groupId).toBe('a1');
    expect(findNode('n2')?.groupId).toBe('a1');
    expect(getGroupMemberCount('a1')).toBe(2);

    useCanvasStore.getState().redo();
    expect(findNode('n1')?.groupId).toBeUndefined();
    expect(findNode('n2')?.groupId).toBeUndefined();
    expect(findNode('a1')).toBeDefined();
  });

  it('无成员 Agent 节点解散为 no-op（debug 留痕）：不删节点、不写历史', () => {
    addAgentNode('a1', 100, 100);
    useCanvasStore.getState().saveToHistory();
    const historyLength = useCanvasStore.getState().history.length;
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const dissolved = useCanvasStore.getState().dissolveAgentContainer('a1');

    expect(dissolved).toBe(false);
    expect(findNode('a1')).toBeDefined();
    expect(useCanvasStore.getState().history).toHaveLength(historyLength);
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('目标不是 Agent 节点时解散为 no-op（debug 留痕）', () => {
    addMemberNode('n1', 'missing-container', 0, 0);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const dissolved = useCanvasStore.getState().dissolveAgentContainer('n1');

    expect(dissolved).toBe(false);
    expect(findNode('n1')).toBeDefined();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe('删除 Agent 不提供撤销兜底（AG-CT-011）', () => {
  // @spec: AG-CT-011
  it('删除 Agent 节点：撤销不可达（历史重建为删除后基线），非 Agent 节点删除仍可撤销', () => {
    addAgentNode('a1', 100, 100);
    addMemberNode('n1', 'a1', 120, 120);
    useCanvasStore.getState().saveToHistory();
    expect(useCanvasStore.getState().canUndo()).toBe(true);

    useCanvasStore.getState().removeNodes(['a1'], undefined);

    expect(findNode('a1')).toBeUndefined();
    expect(findNode('n1')?.groupId).toBeUndefined();
    // 删除后撤销不可达（不提供撤销兜底）
    expect(useCanvasStore.getState().canUndo()).toBe(false);
    useCanvasStore.getState().undo();
    expect(findNode('a1')).toBeUndefined();

    // 对照组：非 Agent 节点删除仍可撤销
    addMemberNode('n2', 'free', 300, 300);
    useCanvasStore.getState().saveToHistory();
    useCanvasStore.getState().removeNodes(['n2'], undefined);
    expect(findNode('n2')).toBeUndefined();
    expect(useCanvasStore.getState().canUndo()).toBe(true);
    useCanvasStore.getState().undo();
    expect(findNode('n2')).toBeDefined();
  });
});

describe('deleteSelectedElements 对 Agent 节点转删除确认（禁旁路）', () => {
  it('选中集含 Agent 节点：不直接删除，转删除确认请求（无成员 Agent 同样拦截）', () => {
    addAgentNode('a1', 100, 100);
    addMemberNode('n1', 'free', 10, 10);
    useCanvasStore.setState((s) => {
      s.selectedNodeIds = ['a1'];
    });

    useCanvasStore.getState().deleteSelectedElements();

    expect(findNode('a1')).toBeDefined();
    expect(useCanvasStore.getState().pendingAgentDeleteConfirmNodeIds).toEqual(['a1']);
  });

  it('确认通道清空后 deleteSelectedElements 对纯非 Agent 选中集行为不变', () => {
    addMemberNode('n1', 'free', 10, 10);
    useCanvasStore.setState((s) => {
      s.selectedNodeIds = ['n1'];
    });

    useCanvasStore.getState().deleteSelectedElements();

    expect(findNode('n1')).toBeUndefined();
    expect(useCanvasStore.getState().pendingAgentDeleteConfirmNodeIds).toBeNull();
  });
});
