import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { prepareLoadedNodeGraph } from '../internal/canvasStore.loadNodeGraph';
import type { ClipboardPayload } from '../../types';
import type { AgentNodeData, GraphNode, GroupNodeData, TextInputNodeData } from '../../types';

const createTestGraph = () =>
  createNodeGraph({
    name: 'container-membership-test',
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
  });
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
};

const addTextInputNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
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
    groupId,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
  return node;
};

const addAgentNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): GraphNode<AgentNodeData> => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x, y },
    data: { label: 'Agent', agentSessionId: `session-${id}` },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId,
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

describe('Agent 容器成员关系（建立/迁移/解除）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CT-003
  it('addNodesToGroup 把合规叶节点加入 Agent 容器（建立成员关系）', () => {
    const agent = addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120);

    useCanvasStore.getState().addNodesToGroup(['n1'], 'a1');

    expect(findNode('n1')?.groupId).toBe('a1');
    expect(findNode(agent.id)?.groupId).toBeUndefined();
  });

  // @spec: AG-CT-003
  it('removeNodesFromGroup 把成员拖出 Agent 容器（解除成员关系，节点保留）', () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120, 'a1');

    useCanvasStore.getState().removeNodesFromGroup(['n1']);

    expect(findNode('n1')).toBeDefined();
    expect(findNode('n1')?.groupId).toBeUndefined();
  });

  // @spec: AG-CN-002
  it('成员加入另一容器即原子迁移（覆盖原 groupId，单一归属）', () => {
    addTextInputNode('n1', 10, 10);
    addTextInputNode('n2', 20, 20);
    const groupIds = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
    addAgentNode('a1', 500, 500);
    expect(groupIds).not.toBeNull();

    useCanvasStore.getState().addNodesToGroup(['n1'], 'a1');

    expect(findNode('n1')?.groupId).toBe('a1'); // 迁入 Agent 容器
    expect(findNode('n2')?.groupId).toBe(groupIds); // 原组其他成员不变
    // 任一时刻至多一个 groupId（单一归属由字段形态保证）
    expect(findNode('n1')?.groupId).not.toBe(groupIds);
  });

  // @spec: AG-CN-002
  it('moveNodesBetweenGroups：叶节点从组迁入 Agent 容器', () => {
    addTextInputNode('n1', 10, 10);
    const groupId = useCanvasStore.getState().createGroup(['n1'], undefined);
    addAgentNode('a1', 500, 500);
    expect(groupId).not.toBeNull();

    useCanvasStore.getState().moveNodesBetweenGroups(['n1'], 'a1');

    expect(findNode('n1')?.groupId).toBe('a1');
  });

  // @spec: AG-CN-001
  it('Agent 容器可加入组（成为组的成员）', () => {
    addTextInputNode('n1', 10, 10);
    addTextInputNode('n2', 20, 20);
    const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
    addAgentNode('a1', 500, 500);
    expect(groupId).not.toBeNull();

    useCanvasStore.getState().addNodesToGroup(['a1'], groupId as string);

    expect(findNode('a1')?.groupId).toBe(groupId);
  });

  // @spec: AG-CN-001
  it('Agent 容器不得成为 Agent 容器的成员；组节点不得成为任何容器的成员', () => {
    addAgentNode('a1', 0, 0);
    addAgentNode('a2', 100, 100);
    addTextInputNode('n1', 10, 10);
    addTextInputNode('n2', 20, 20);
    const groupId = useCanvasStore.getState().createGroup(['n1'], undefined);
    expect(groupId).not.toBeNull();

    // a2 → a1（agent 套 agent）：拒绝
    useCanvasStore.getState().addNodesToGroup(['a2'], 'a1');
    expect(findNode('a2')?.groupId).toBeUndefined();

    // 组节点 → a1：拒绝
    useCanvasStore.getState().addNodesToGroup([groupId as string], 'a1');
    expect(findNode(groupId as string)?.groupId).toBeUndefined();

    // 组节点 → 组（组不得入组）：拒绝（既有不变量保持）
    const anotherGroupId = useCanvasStore.getState().createGroup(['n2'], undefined);
    expect(anotherGroupId).not.toBeNull();
    useCanvasStore.getState().addNodesToGroup([anotherGroupId as string], groupId as string);
    expect(findNode(anotherGroupId as string)?.groupId).toBeUndefined();
  });
});

describe('Agent 容器删除 = 解散（AG-CT-004 / AG-CN-005 / AG-CN-007）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CT-004, AG-CN-005
  it('删除 Agent 容器（默认路径）：成员保留于画布原位、成员关系在同一存储写入路径解除', () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120, 'a1');
    addTextInputNode('n2', 200, 200, 'a1');
    const n1Pos = findNode('n1')?.position;

    useCanvasStore.getState().removeNodes(['a1'], undefined);

    expect(findNode('a1')).toBeUndefined();
    expect(findNode('n1')).toBeDefined();
    expect(findNode('n1')?.position).toEqual(n1Pos); // 保留原绝对位置
    expect(findNode('n1')?.groupId).toBeUndefined(); // 成员关系解除（无悬空引用）
    expect(findNode('n2')?.groupId).toBeUndefined();
  });

  // @spec: AG-CN-007
  it('Agent 容器不提供连删：deleteGroupMembers=true 时成员仍保留', () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120, 'a1');
    addTextInputNode('n2', 200, 200, 'a1');

    useCanvasStore.getState().removeNodes(['a1'], { deleteGroupMembers: true });

    expect(findNode('a1')).toBeUndefined();
    expect(findNode('n1')).toBeDefined();
    expect(findNode('n1')?.groupId).toBeUndefined();
    expect(findNode('n2')).toBeDefined();
    expect(findNode('n2')?.groupId).toBeUndefined();
  });

  // @spec: AG-CN-006, AG-CT-004
  it('组连删：删除组与其显式成员（含 Agent 容器），但 Agent 容器的成员按解散保留', () => {
    addTextInputNode('m1', 10, 10);
    const groupId = useCanvasStore.getState().createGroup(['m1'], undefined);
    expect(groupId).not.toBeNull();
    addAgentNode('a1', 300, 300, groupId as string); // Agent 容器是组的成员
    addTextInputNode('a1-leaf', 320, 320, 'a1'); // Agent 容器的成员

    useCanvasStore.getState().removeNodes([groupId as string], { deleteGroupMembers: true });

    expect(findNode(groupId as string)).toBeUndefined();
    expect(findNode('m1')).toBeUndefined();
    expect(findNode('a1')).toBeUndefined(); // 组的显式成员（Agent 容器）被连删
    // Agent 容器的成员不被连删扩大删除，且成员关系已解除（解散）
    expect(findNode('a1-leaf')).toBeDefined();
    expect(findNode('a1-leaf')?.groupId).toBeUndefined();
  });
});

describe('Agent 容器折叠泛化（AG-CN-008）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CN-008
  it('toggleGroupCollapse 对 Agent 容器生效，且折叠不改成员关系与成员位置', () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120, 'a1');
    const n1Pos = findNode('n1')?.position;

    useCanvasStore.getState().toggleGroupCollapse('a1');

    const agentData = findNode('a1')?.data as AgentNodeData;
    expect(agentData.collapsed).toBe(true);
    // 折叠不改成员事实
    expect(findNode('n1')?.groupId).toBe('a1');
    expect(findNode('n1')?.position).toEqual(n1Pos);
    expect(findNode('a1')?.position).toEqual({ x: 100, y: 100 });

    useCanvasStore.getState().toggleGroupCollapse('a1');
    expect((findNode('a1')?.data as AgentNodeData).collapsed).toBe(false);
  });

  // @spec: AG-CN-008
  it('toggleGroupCollapse 对非容器节点无操作', () => {
    addTextInputNode('n1', 0, 0);
    useCanvasStore.getState().toggleGroupCollapse('n1');
    expect(findNode('n1')).toBeDefined();
    expect(findNode('n1')?.groupId).toBeUndefined();
  });
});

describe('成员关系历史合批（AG-CN-011 / AG-CT-006）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CN-011, AG-CT-006
  it('加入 Agent 容器是一条历史：undo 整体解除、redo 整体恢复', async () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120);
    useCanvasStore.getState().saveToHistory();
    const baseline = useCanvasStore.getState().history.length;

    useCanvasStore.getState().addNodesToGroup(['n1'], 'a1');
    expect(useCanvasStore.getState().history).toHaveLength(baseline + 1);
    expect(findNode('n1')?.groupId).toBe('a1');

    useCanvasStore.getState().undo();
    expect(findNode('n1')?.groupId).toBeUndefined(); // undo 恢复成员关系（自由态）

    useCanvasStore.getState().redo();
    expect(findNode('n1')?.groupId).toBe('a1'); // redo 恢复成员关系
  });

  // @spec: AG-CT-011
  // （2026-09-22 裁断翻转：删除 Agent 不再等于解散，删除不提供撤销兜底）
  it('删除 Agent 节点不进历史栈：撤销不可达（会话随删除物理清除）；解散已改由 dissolveAgentContainer 承载', () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120, 'a1');
    useCanvasStore.getState().saveToHistory();

    useCanvasStore.getState().removeNodes(['a1'], undefined);
    expect(findNode('a1')).toBeUndefined();
    expect(findNode('n1')?.groupId).toBeUndefined(); // 产物成员关系解除、节点保留
    // 删除 Agent：撤销不可达（不提供撤销兜底；此前的快照条目会复活出会话已被清除的悬空节点）
    expect(useCanvasStore.getState().canUndo()).toBe(false);
    useCanvasStore.getState().undo();
    expect(findNode('a1')).toBeUndefined();
  });

  // @spec: AG-CN-011
  it('一次用户意图的批量拖拽归属合批为一条历史（historyBatchActive）', () => {
    addAgentNode('a1', 100, 100);
    addTextInputNode('n1', 120, 120);
    addTextInputNode('n2', 300, 300);
    useCanvasStore.getState().saveToHistory();
    const baseline = useCanvasStore.getState().history.length;

    // 模拟拖拽落点分桶后的批量执行（useNodeCanvasChangeController 同款编排）
    useCanvasStore.setState((s) => {
      s.historyBatchActive = true;
    });
    useCanvasStore.getState().addNodesToGroup(['n1'], 'a1');
    useCanvasStore.getState().addNodesToGroup(['n2'], 'a1');
    useCanvasStore.setState((s) => {
      s.historyBatchActive = false;
    });
    useCanvasStore.getState().saveToHistory();

    expect(useCanvasStore.getState().history).toHaveLength(baseline + 1);
    expect(findNode('n1')?.groupId).toBe('a1');
    expect(findNode('n2')?.groupId).toBe('a1');
  });
});

describe('addNode 创建即入容器（产物自动包含接口）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CT-001
  it('创建时指定成员关系：节点落图即持有 groupId 指向容器', () => {
    addAgentNode('a1', 100, 100);

    const node = useCanvasStore.getState().addNode('imageInput', { x: 150, y: 150 }, undefined, {
      groupId: 'a1',
    });

    expect(node).not.toBeNull();
    expect(node?.groupId).toBe('a1');
    expect(findNode(node?.id ?? '')?.groupId).toBe('a1');
    // 创建 + 成员关系合为一条历史
    const history = useCanvasStore.getState().history;
    expect(history.length).toBeGreaterThan(0);
  });

  // @spec: AG-CT-001
  it('目标容器不存在：节点照常创建，不建立成员关系', () => {
    const node = useCanvasStore.getState().addNode(
      'imageInput',
      { x: 10, y: 10 },
      undefined,
      { groupId: 'missing-container' },
    );
    expect(node).not.toBeNull();
    expect(node?.groupId).toBeUndefined();
  });

  // @spec: AG-CN-001
  it('目标节点不是容器：节点照常创建，不建立成员关系', () => {
    addTextInputNode('leaf', 0, 0);
    const node = useCanvasStore.getState().addNode(
      'imageInput',
      { x: 10, y: 10 },
      undefined,
      { groupId: 'leaf' },
    );
    expect(node).not.toBeNull();
    expect(node?.groupId).toBeUndefined();
  });
});

describe('持久化恢复与旧输入拒绝（AG-CN-012 / AG-CN-013）', () => {
  // @spec: AG-CN-012
  it('合法成员关系随节点 JSON 整存整取：恢复后 groupId 原样保留', async () => {
    const graph = createTestGraph();
    const groupNode: GraphNode<GroupNodeData> = {
      id: 'g1',
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        label: '节点组',
        description: undefined,
        runtimeRef: undefined,
        name: 'g',
        collapsed: false,
        color: undefined,
      },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
    const agentNode: GraphNode<AgentNodeData> = {
      id: 'a1',
      type: 'agent',
      position: { x: 100, y: 100 },
      data: { label: 'Agent', agentSessionId: 's1', collapsed: true },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: 'g1', // Agent 容器是组的成员
    };
    const leaf: GraphNode<TextInputNodeData> = {
      id: 'n1',
      type: 'textInput',
      position: { x: 120, y: 120 },
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
      groupId: 'a1',
    };
    const prepared = await prepareLoadedNodeGraph(
      { ...graph, nodes: [groupNode, agentNode, leaf] },
      {},
    );
    const restoredAgent = prepared.nodeGraph.nodes.find((n) => n.id === 'a1');
    const restoredLeaf = prepared.nodeGraph.nodes.find((n) => n.id === 'n1');
    expect(restoredAgent?.groupId).toBe('g1');
    expect((restoredAgent?.data as AgentNodeData).collapsed).toBe(true);
    expect(restoredLeaf?.groupId).toBe('a1');
  });

  // @spec: AG-CN-013
  it('悬空 groupId（指向不存在节点）：拒绝进入正式打开态', async () => {
    const graph = createTestGraph();
    const leaf = addTextInputNode('n1', 0, 0, 'missing-container');
    useCanvasStore.setState((s) => {
      s.nodeGraph = null;
    });
    await expect(
      prepareLoadedNodeGraph({ ...graph, nodes: [leaf] }, {}),
    ).rejects.toThrow();
  });

  // @spec: AG-CN-013
  it('groupId 指向非容器节点：拒绝进入正式打开态', async () => {
    const graph = createTestGraph();
    const target = addTextInputNode('n1', 0, 0);
    const member = addTextInputNode('n2', 10, 10, 'n1');
    useCanvasStore.setState((s) => {
      s.nodeGraph = null;
    });
    await expect(
      prepareLoadedNodeGraph({ ...graph, nodes: [target, member] }, {}),
    ).rejects.toThrow();
  });

  // @spec: AG-CN-001, AG-CN-013
  it('Agent 容器指向 Agent 容器（超两层嵌套）：拒绝进入正式打开态', async () => {
    const graph = createTestGraph();
    const a1: GraphNode<AgentNodeData> = {
      id: 'a1',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Agent', agentSessionId: 's1' },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
    const a2: GraphNode<AgentNodeData> = {
      ...a1,
      id: 'a2',
      position: { x: 100, y: 100 },
      data: { label: 'Agent', agentSessionId: 's2' },
      groupId: 'a1',
    };
    await expect(
      prepareLoadedNodeGraph({ ...graph, nodes: [a1, a2] }, {}),
    ).rejects.toThrow();
  });

  // @spec: AG-CN-001, AG-CN-013
  it('组节点持有 groupId（组不得成为成员）：拒绝进入正式打开态', async () => {
    const graph = createTestGraph();
    const g1: GraphNode<GroupNodeData> = {
      id: 'g1',
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        label: '节点组',
        description: undefined,
        runtimeRef: undefined,
        name: 'g',
        collapsed: false,
        color: undefined,
      },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
    const g2: GraphNode<GroupNodeData> = { ...g1, id: 'g2', groupId: 'g1' };
    await expect(
      prepareLoadedNodeGraph({ ...graph, nodes: [g1, g2] }, {}),
    ).rejects.toThrow();
  });
});

describe('粘贴成员关系重映射（AG-CN-013 / 既有置空规则对 Agent 成员成立）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CN-013
  it('粘贴含非法成员引用（Agent 容器套 Agent 容器）：拒绝该输入', () => {
    const a1: GraphNode<AgentNodeData> = {
      id: 'src-a1',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Agent', agentSessionId: 's1' },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
    const a2: GraphNode<AgentNodeData> = {
      ...a1,
      id: 'src-a2',
      position: { x: 100, y: 100 },
      data: { label: 'Agent', agentSessionId: 's2' },
      groupId: 'src-a1',
    };
    const payload: ClipboardPayload = {
      copiedAt: Date.now(),
      sourceNodeGraphId: 'src-graph',
      nodes: [a1, a2],
      centerPosition: { x: 0, y: 0 },
    };
    expect(() =>
      useCanvasStore.getState().pasteClipboardPayload(payload, undefined),
    ).toThrow();
    // 拒绝后画布不被部分写入
    expect(useCanvasStore.getState().nodeGraph?.nodes).toHaveLength(0);
  });

  // @spec: AG-CN-013
  it('粘贴组节点持有 groupId：拒绝该输入（组不得成为成员）', () => {
    const g1: GraphNode<GroupNodeData> = {
      id: 'src-g1',
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        label: '节点组',
        description: undefined,
        runtimeRef: undefined,
        name: 'g',
        collapsed: false,
        color: undefined,
      },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: 'src-g0',
    };
    const payload: ClipboardPayload = {
      copiedAt: Date.now(),
      sourceNodeGraphId: 'src-graph',
      nodes: [g1],
      centerPosition: { x: 0, y: 0 },
    };
    expect(() =>
      useCanvasStore.getState().pasteClipboardPayload(payload, undefined),
    ).toThrow();
  });

  // @spec: AG-CT-003
  it('既有「粘贴成员 groupId 置空」规则对 Agent 成员同样成立（容器不在 payload 中 → 置空）', () => {
    const member: GraphNode<TextInputNodeData> = {
      id: 'src-member',
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
      groupId: 'src-agent', // 容器不在 payload 中
    };
    const payload: ClipboardPayload = {
      copiedAt: Date.now(),
      sourceNodeGraphId: 'src-graph',
      nodes: [member],
      centerPosition: { x: 0, y: 0 },
    };
    const result = useCanvasStore.getState().pasteClipboardPayload(payload, undefined);
    expect(result.nodeIds).toHaveLength(1);
    expect(findNode(result.nodeIds[0] ?? '')?.groupId).toBeUndefined();
  });

  // @spec: AG-CT-003
  it('容器与成员一起粘贴：成员 groupId 重映射指向新容器 id', () => {
    const agent: GraphNode<AgentNodeData> = {
      id: 'src-agent',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Agent', agentSessionId: 's1' },
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };
    const member: GraphNode<TextInputNodeData> = {
      id: 'src-member',
      type: 'textInput',
      position: { x: 20, y: 20 },
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
      groupId: 'src-agent',
    };
    const payload: ClipboardPayload = {
      copiedAt: Date.now(),
      sourceNodeGraphId: 'src-graph',
      nodes: [agent, member],
      centerPosition: { x: 0, y: 0 },
    };
    const result = useCanvasStore.getState().pasteClipboardPayload(payload, undefined);
    const newAgentId = result.nodes.find((n) => n.type === 'agent')?.id;
    const newMember = result.nodes.find((n) => n.type === 'textInput');
    expect(newAgentId).toBeDefined();
    expect(newMember?.groupId).toBe(newAgentId);
  });
});

describe('选择边界（AG-CN-010）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CN-010
  it('容器与成员 id 进入 selectedNodeIds，不设容器专用选中集合', () => {
    addAgentNode('a1', 0, 0);
    addTextInputNode('n1', 10, 10, 'a1');

    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: ['a1', 'n1'],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });

    const state = useCanvasStore.getState();
    expect(state.selectedNodeIds).toEqual(['a1', 'n1']);
    // 容器不建立独立选中集合：状态切片中不存在容器专用选中字段
    const stateKeys = Object.keys(state).map((k) => k.toLowerCase());
    expect(stateKeys.filter((k) => k.includes('containerselect') || k.includes('groupselect') || k.includes('agentselect'))).toEqual([]);
  });
});

describe('全局整理作用域：容器节点不进入布局输入（AG-CN-009）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CN-009
  it('全局整理不移动 Agent 容器与其成员', async () => {
    addAgentNode('a1', 4000, 4000);
    addTextInputNode('a1-leaf', 4100, 4100, 'a1');
    addTextInputNode('free1', 100, 100);

    const agentBefore = findNode('a1')?.position;
    const leafBefore = findNode('a1-leaf')?.position;

    const result = await useCanvasStore.getState().autoLayout(undefined);
    expect(result).not.toBeNull();

    expect(findNode('a1')?.position).toEqual(agentBefore);
    expect(findNode('a1-leaf')?.position).toEqual(leafBefore);
  });
});
