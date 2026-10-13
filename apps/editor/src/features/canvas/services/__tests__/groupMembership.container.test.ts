import { describe, expect, it } from 'vitest';
import {
  canBeMemberOf,
  canBeMemberOfType,
  expandPositionUpdatesWithGroup,
  expandRemovalWithGroup,
  filterAddCandidates,
  filterRemoveCandidates,
  findIllegalMemberships,
  getGroupMembers,
  isContainerNode,
} from '../groupMembership';
import type { GraphNode } from '../../types';
import type { NodeGraph } from '../../types/nodeGraph';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AgentNodeData, GroupNodeData, TextInputNodeData } from '../../types/node';

const makeTextInputNode = (
  id: string,
  groupId: string | undefined,
  x = 0,
  y = 0,
): GraphNode<TextInputNodeData> => ({
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
});

const makeGroupNode = (id: string, x = 0, y = 0): GraphNode<GroupNodeData> => ({
  id,
  type: 'group',
  position: { x, y },
  data: {
    label: '节点组',
    description: undefined,
    runtimeRef: undefined,
    name: id,
    collapsed: false,
    color: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const makeAgentNode = (
  id: string,
  groupId: string | undefined,
  x = 0,
  y = 0,
): GraphNode<AgentNodeData> => ({
  id,
  type: 'agent',
  position: { x, y },
  data: {
    label: 'Agent',
    agentSessionId: `session-${id}`,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const makeGraph = (nodes: GraphNode[]): NodeGraph => {
  const graph = createNodeGraph({
    name: 'container-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  return { ...graph, nodes };
};

describe('容器判据与成员资格矩阵', () => {
  // @spec: AG-CN-001
  it('isContainerNode：group 与 agent 是容器，叶节点不是', () => {
    expect(isContainerNode(makeGroupNode('g1'))).toBe(true);
    expect(isContainerNode(makeAgentNode('a1', undefined))).toBe(true);
    expect(isContainerNode(makeTextInputNode('n1', undefined))).toBe(false);
  });

  // @spec: AG-CN-001
  it('成员资格矩阵：非容器可入任一容器；组不得成为任何容器成员；Agent 容器可入组、不得入 Agent 容器', () => {
    expect(canBeMemberOfType('textInput', 'group')).toBe(true);
    expect(canBeMemberOfType('asset', 'group')).toBe(true);
    expect(canBeMemberOfType('task', 'agent')).toBe(true);
    expect(canBeMemberOfType('asset', 'agent')).toBe(true);
    // Agent 容器可成为组的成员（组 > Agent 容器 > 叶）
    expect(canBeMemberOfType('agent', 'group')).toBe(true);
    // 组不得成为任何容器的成员
    expect(canBeMemberOfType('group', 'group')).toBe(false);
    expect(canBeMemberOfType('group', 'agent')).toBe(false);
    // 禁止 Agent 容器嵌套
    expect(canBeMemberOfType('agent', 'agent')).toBe(false);
    // 目标必须是容器节点
    expect(canBeMemberOfType('asset', 'asset')).toBe(false);
    expect(canBeMemberOfType('asset', 'task')).toBe(false);
  });

  // @spec: AG-CN-002
  it('canBeMemberOf：容器不得指向自身，目标非容器不可入', () => {
    const agent = makeAgentNode('a1', undefined);
    const leaf = makeTextInputNode('n1', undefined);
    expect(canBeMemberOf(agent, agent)).toBe(false); // 自身引用
    expect(canBeMemberOf(leaf, leaf)).toBe(false); // 目标非容器
    expect(canBeMemberOf(leaf, agent)).toBe(true);
  });

  // @spec: AG-CN-001
  it('getGroupMembers 返回组的显式成员（含 Agent 容器成员，排除组节点）', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeAgentNode('a1', 'g1'),
      makeTextInputNode('n1', 'g1'),
      makeGroupNode('g2'),
      makeGroupNode('orphan-group'),
    ]);
    // 组成员集合包含 Agent 容器（组 > Agent 容器两层嵌套合法）
    expect(getGroupMembers(graph, 'g1').map((n) => n.id).sort()).toEqual(['a1', 'n1']);
  });
});

describe('filterAddCandidates / filterRemoveCandidates 容器泛化', () => {
  // @spec: AG-CN-001
  it('目标为 Agent 容器：叶节点可加入，Agent 容器与组节点被排除', () => {
    const graph = makeGraph([
      makeAgentNode('a1', undefined),
      makeTextInputNode('n1', undefined),
      makeAgentNode('a2', undefined),
      makeGroupNode('g1'),
      makeTextInputNode('n2', 'a1'), // 已是 a1 成员 → 无操作排除
    ]);
    // n1 叶节点可入；a2（Agent 容器）与 g1（组）被资格矩阵排除；n2 已是 a1 成员属无操作
    expect(filterAddCandidates(graph, ['n1', 'a2', 'g1', 'n2'], 'a1')).toEqual(['n1']);
  });

  // @spec: AG-CN-001
  it('目标为组：Agent 容器可加入，组节点被排除', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeAgentNode('a1', undefined),
      makeGroupNode('g2'),
      makeTextInputNode('n1', undefined),
    ]);
    expect(filterAddCandidates(graph, ['a1', 'g2', 'n1'], 'g1')).toEqual(['a1', 'n1']);
  });

  // @spec: AG-CN-001
  it('filterRemoveCandidates：Agent 容器成员可移出，组节点不可', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeAgentNode('a1', 'g1'),
      makeTextInputNode('n1', 'g1'),
      makeGroupNode('g2'),
    ]);
    expect(filterRemoveCandidates(graph, ['a1', 'n1', 'g2'])).toEqual(['a1', 'n1']);
  });
});

describe('expandPositionUpdatesWithGroup 两层位移传播', () => {
  // @spec: AG-CN-003, AG-CT-002
  it('拖动组：组成员（含 Agent 容器）与其叶成员递归一层整体跟随，边界内非成员不跟随', () => {
    const graph = makeGraph([
      makeGroupNode('g1', 0, 0),
      makeAgentNode('a1', 'g1', 100, 100),
      makeTextInputNode('l1', 'g1', 120, 120),
      makeTextInputNode('l2', 'a1', 140, 140), // Agent 容器的叶成员（第二层）
      makeTextInputNode('free', undefined, 900, 900), // 非成员
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'g1', position: { x: 50, y: 70 } }, // dx=50, dy=70
    ]);
    const posById = new Map(result.map((r) => [r.id, r.position]));
    expect(posById.get('g1')).toEqual({ x: 50, y: 70 });
    expect(posById.get('a1')).toEqual({ x: 150, y: 170 });
    expect(posById.get('l1')).toEqual({ x: 170, y: 190 });
    // 第二层：组内 Agent 容器的成员随递归一层整体跟随
    expect(posById.get('l2')).toEqual({ x: 190, y: 210 });
    expect(posById.has('free')).toBe(false);
  });

  // @spec: AG-CT-002
  it('拖动 Agent 容器：其全部成员跟随，所在组与组内兄弟不移动', () => {
    const graph = makeGraph([
      makeGroupNode('g1', 0, 0),
      makeAgentNode('a1', 'g1', 100, 100),
      makeTextInputNode('l1', 'g1', 120, 120), // 组的其他成员
      makeTextInputNode('l2', 'a1', 140, 140),
      makeTextInputNode('l3', 'a1', 160, 160),
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'a1', position: { x: 110, y: 110 } }, // dx=10, dy=10
    ]);
    const posById = new Map(result.map((r) => [r.id, r.position]));
    expect(posById.get('a1')).toEqual({ x: 110, y: 110 });
    expect(posById.get('l2')).toEqual({ x: 150, y: 150 });
    expect(posById.get('l3')).toEqual({ x: 170, y: 170 });
    // 拖单个成员不移动其他成员、不反向拖动组
    expect(posById.has('g1')).toBe(false);
    expect(posById.has('l1')).toBe(false);
  });

  // @spec: AG-CN-003
  it('组与组内 Agent 容器同时被直接拖动时，显式位置优先且成员不被重复扩展', () => {
    const graph = makeGraph([
      makeGroupNode('g1', 0, 0),
      makeAgentNode('a1', 'g1', 100, 100),
      makeTextInputNode('l2', 'a1', 140, 140),
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'g1', position: { x: 60, y: 60 } }, // dx=60, dy=60
      { id: 'a1', position: { x: 400, y: 400 } }, // 直接拖动优先
    ]);
    const posById = new Map(result.map((r) => [r.id, r.position]));
    expect(posById.get('a1')).toEqual({ x: 400, y: 400 });
    // a1 被显式拖动：其成员跟随 a1 的显式位移（+300,+300），不叠加组的位移
    expect(posById.get('l2')).toEqual({ x: 440, y: 440 });
  });
});

describe('expandRemovalWithGroup 连删边界', () => {
  // @spec: AG-CN-006
  it('组连删：删除组与其全部显式成员（含 Agent 容器），不扩大到 Agent 容器的成员', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeAgentNode('a1', 'g1'),
      makeTextInputNode('l1', 'g1'),
      makeTextInputNode('l2', 'a1'), // Agent 容器的成员不被连删扩大
    ]);
    const result = expandRemovalWithGroup(graph, ['g1'], { deleteGroupMembers: true });
    expect(result.sort()).toEqual(['a1', 'g1', 'l1'].sort());
  });

  // @spec: AG-CN-007
  it('Agent 容器连删标志恒不适用：deleteGroupMembers=true 也不扩展其成员', () => {
    const graph = makeGraph([
      makeAgentNode('a1', undefined),
      makeTextInputNode('l1', 'a1'),
      makeTextInputNode('l2', 'a1'),
    ]);
    const result = expandRemovalWithGroup(graph, ['a1'], { deleteGroupMembers: true });
    expect(result).toEqual(['a1']);
  });

  // @spec: AG-CN-005, AG-CN-007
  it('dissolve（deleteGroupMembers=false）不连带任何容器的成员', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('l1', 'g1'),
      makeAgentNode('a1', undefined),
      makeTextInputNode('l2', 'a1'),
    ]);
    expect(expandRemovalWithGroup(graph, ['g1', 'a1'], { deleteGroupMembers: false })).toEqual([
      'g1',
      'a1',
    ]);
  });
});

describe('findIllegalMemberships 非法成员引用检测', () => {
  // @spec: AG-CN-013
  it('合法成员关系不产生违规', () => {
    const nodes = [
      makeGroupNode('g1'),
      makeAgentNode('a1', 'g1'), // Agent 容器入组：合法
      makeTextInputNode('n1', 'a1'), // 叶入 Agent 容器：合法
      makeTextInputNode('n2', 'g1'), // 叶入组：合法
      makeTextInputNode('free', undefined),
    ];
    expect(findIllegalMemberships(nodes)).toEqual([]);
  });

  // @spec: AG-CN-013
  it('悬空 groupId（指向不存在节点）被识别', () => {
    const nodes = [makeTextInputNode('n1', 'missing')];
    const violations = findIllegalMemberships(nodes);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('dangling-target');
  });

  // @spec: AG-CN-013
  it('groupId 指向非容器节点被识别', () => {
    const nodes = [
      makeTextInputNode('n1', undefined),
      makeTextInputNode('n2', 'n1'),
    ];
    const violations = findIllegalMemberships(nodes);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('target-not-container');
  });

  // @spec: AG-CN-013
  it('组节点持有 groupId 被识别（组不得成为任何容器的成员）', () => {
    const nodes: GraphNode[] = [
      makeGroupNode('g1'),
      { ...makeGroupNode('g2', 10, 10), groupId: 'g1' },
    ];
    const violations = findIllegalMemberships(nodes);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('group-cannot-be-member');
  });

  // @spec: AG-CN-013
  it('Agent 容器指向 Agent 容器被识别（禁容器套容器）', () => {
    const nodes = [
      makeAgentNode('a1', undefined),
      makeAgentNode('a2', 'a1'),
    ];
    const violations = findIllegalMemberships(nodes);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('agent-in-agent');
  });

  // @spec: AG-CN-013
  it('容器指向自身被识别', () => {
    const nodes = [makeAgentNode('a1', 'a1')];
    const violations = findIllegalMemberships(nodes);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('self-reference');
  });

  // @spec: AG-CN-013
  it('ignoreDanglingTarget：粘贴场景跳过悬空目标（重映射会置空），其余违规照报', () => {
    const nodes = [makeTextInputNode('n1', 'not-in-payload')];
    expect(findIllegalMemberships(nodes, { ignoreDanglingTarget: true })).toEqual([]);
    const groupHolder: GraphNode[] = [
      { ...makeGroupNode('g1'), groupId: 'not-in-payload' },
    ];
    expect(findIllegalMemberships(groupHolder, { ignoreDanglingTarget: true })).toHaveLength(1);
  });
});
