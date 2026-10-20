// @spec: AL-GC-003, AG-CN-018
import { describe, expect, it } from 'vitest';

import { resolveContainerOverlaps, type ContainerOverlapRelocation } from '../containerOverlap';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { createTextInputDataFixture } from '../../components/__tests__/fixtures/canvasTestBuilders';
import type { AgentNodeData, GraphNode, GroupNodeData, NodePosition, NodeSize } from '../../types';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import { rectsIntersect } from '../../utils/taskNodePlacement';

/**
 * 容器级防重叠（长大容器整体让位）纯函数：
 * - 只做容器 × 容器派生矩形相交判定；
 * - 相交时整块让位（容器 + 全部后代同 delta），容器内相对布局不变；
 * - 组内 Agent 容器候选归并到宿主组；
 * - 空组 / 折叠容器同样支持；
 * - 确定性：相同输入相同结果。
 */

const MEMBER_SIZE: NodeSize = { width: 200, height: 100 };

const leafNode = (
  id: string,
  x: number,
  y: number,
  groupId: string | undefined = undefined,
): GraphNode => ({
  id,
  type: 'textInput',
  position: { x, y },
  data: createTextInputDataFixture(),
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const groupNode = (id: string, x: number, y: number, collapsed = false): GraphNode<GroupNodeData> => ({
  id,
  type: 'group',
  position: { x, y },
  data: {
    label: '节点组',
    description: undefined,
    runtimeRef: undefined,
    name: id,
    collapsed,
    color: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const agentNode = (id: string, x: number, y: number, groupId: string | undefined): GraphNode<AgentNodeData> => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id, agentSessionId: `session-${id}`, collapsed: false },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const rowMembers = (
  idPrefix: string,
  containerId: string,
  count: number,
  startX: number,
  startY: number,
): GraphNode[] =>
  Array.from({ length: count }, (_, index) =>
    leafNode(`${idPrefix}-${index + 1}`, startX + index * 220, startY, containerId),
  );

const buildSizeSources = (nodes: ReadonlyArray<GraphNode>): EffectiveSizeSources => {
  const layoutModelByNodeId: Record<string, NodeSize> = {};
  for (const node of nodes) {
    layoutModelByNodeId[node.id] = MEMBER_SIZE;
  }
  return {
    measuredByNodeId: undefined,
    desiredByNodeId: undefined,
    derivedByNodeId: undefined,
    defaultByNodeId: undefined,
    layoutModelByNodeId,
  };
};

const derivedOf = (nodes: ReadonlyArray<GraphNode>) =>
  buildGroupDerivedSize({ nodes, sizeSources: buildSizeSources(nodes) }).byGroupId;

const applyRelocations = (
  nodes: ReadonlyArray<GraphNode>,
  relocations: ReadonlyArray<ContainerOverlapRelocation>,
): GraphNode[] => {
  const deltaById = new Map<string, NodePosition>();
  for (const relocation of relocations) {
    deltaById.set(relocation.containerId, relocation.delta);
    for (const id of relocation.memberIds) {
      deltaById.set(id, relocation.delta);
    }
  }
  return nodes.map((node) => {
    const delta = deltaById.get(node.id);
    if (!delta) return node;
    return { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } };
  });
};

const requireEntry = (
  entries: ReturnType<typeof derivedOf>,
  id: string,
): { position: NodePosition; size: NodeSize } => {
  const entry = entries[id];
  if (!entry) throw new Error(`derived entry missing: ${id}`);
  return entry;
};

const entryRect = (entry: { position: NodePosition; size: NodeSize }) => ({
  x: entry.position.x,
  y: entry.position.y,
  width: entry.size.width,
  height: entry.size.height,
});

describe('resolveContainerOverlaps 容器级防重叠', () => {
  it('两个组相距 280 且各 8 成员：返回整组让位，让位后两框不相交、成员相对位置不变', () => {
    const nodes: GraphNode[] = [
      groupNode('group-a', 0, 0),
      ...rowMembers('a', 'group-a', 8, 0, 0),
      groupNode('group-b', 280, 0),
      ...rowMembers('b', 'group-b', 8, 280, 0),
    ];
    const relocations = resolveContainerOverlaps({
      nodes,
      sizeSources: buildSizeSources(nodes),
      snapGrid: [20, 20],
      containerIds: ['group-a', 'group-b'],
    });

    expect(relocations).toHaveLength(1);
    const relocation = relocations[0];
    if (!relocation) throw new Error('relocation missing');
    expect(relocation.delta.x !== 0 || relocation.delta.y !== 0).toBe(true);
    expect(relocation.memberIds).toHaveLength(8);
    // 整组统一 delta：容器目标位置 = 存储 position + delta
    expect(relocation.containerTargetPosition).toEqual({
      x: relocation.delta.x,
      y: relocation.delta.y,
    });

    const movedNodes = applyRelocations(nodes, relocations);
    const before = derivedOf(nodes);
    const after = derivedOf(movedNodes);
    expect(
      rectsIntersect(entryRect(requireEntry(after, 'group-a')), entryRect(requireEntry(after, 'group-b'))),
    ).toBe(false);

    // 成员相对位置不变：每个成员同 delta 平移
    for (const id of relocation.memberIds) {
      const beforeNode = nodes.find((node) => node.id === id);
      const afterNode = movedNodes.find((node) => node.id === id);
      if (!beforeNode || !afterNode) throw new Error(`node missing: ${id}`);
      expect(afterNode.position).toEqual({
        x: beforeNode.position.x + relocation.delta.x,
        y: beforeNode.position.y + relocation.delta.y,
      });
    }
    // 容器自身存储 position 同样平移
    const movedContainer = movedNodes.find((node) => node.id === relocation.containerId);
    expect(movedContainer?.position).toEqual(relocation.containerTargetPosition);
    // 与让位前的派生矩形尺寸一致（不因让位改变容器内部布局）
    expect(requireEntry(after, relocation.containerId).size).toEqual(
      requireEntry(before, relocation.containerId).size,
    );
  });

  it('不相交输入返回空数组', () => {
    const nodes: GraphNode[] = [
      groupNode('group-a', 0, 0),
      ...rowMembers('a', 'group-a', 2, 0, 0),
      groupNode('group-b', 3000, 0),
      ...rowMembers('b', 'group-b', 2, 3000, 0),
    ];
    expect(
      resolveContainerOverlaps({
        nodes,
        sizeSources: buildSizeSources(nodes),
        snapGrid: [20, 20],
        containerIds: ['group-a', 'group-b'],
      }),
    ).toEqual([]);
  });

  it('确定性：同一输入两次结果相同', () => {
    const nodes: GraphNode[] = [
      groupNode('group-a', 0, 0),
      ...rowMembers('a', 'group-a', 3, 0, 0),
      groupNode('group-b', 200, 0),
      ...rowMembers('b', 'group-b', 3, 200, 0),
    ];
    const params = {
      nodes,
      sizeSources: buildSizeSources(nodes),
      snapGrid: [20, 20] as ReadonlyArray<number>,
      containerIds: ['group-a', 'group-b'],
    };
    const first = resolveContainerOverlaps(params);
    const second = resolveContainerOverlaps(params);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('组内 Agent 容器作为候选：归并到宿主组，memberIds 含两层后代', () => {
    const nodes: GraphNode[] = [
      groupNode('group-g', 1000, 1000),
      agentNode('agent-a', 1000, 1000, 'group-g'),
      leafNode('a1', 1000, 1000, 'agent-a'),
      leafNode('a2', 1200, 1000, 'agent-a'),
      leafNode('m1', 1300, 1000, 'group-g'),
      groupNode('group-h', 1000, 1000),
      leafNode('h1', 1050, 1000, 'group-h'),
    ];
    const relocations = resolveContainerOverlaps({
      nodes,
      sizeSources: buildSizeSources(nodes),
      snapGrid: [20, 20],
      containerIds: ['agent-a'],
    });

    expect(relocations).toHaveLength(1);
    const relocation = relocations[0];
    if (!relocation) throw new Error('relocation missing');
    // 最外层容器归并：不是 agent-a，而是宿主组 group-g
    expect(relocation.containerId).toBe('group-g');
    expect([...relocation.memberIds].sort()).toEqual(['a1', 'a2', 'agent-a', 'm1']);
    expect(relocation.containerTargetPosition).toEqual({
      x: 1000 + relocation.delta.x,
      y: 1000 + relocation.delta.y,
    });
    const movedNodes = applyRelocations(nodes, relocations);
    const after = derivedOf(movedNodes);
    expect(
      rectsIntersect(entryRect(requireEntry(after, 'group-g')), entryRect(requireEntry(after, 'group-h'))),
    ).toBe(false);
  });

  it('空组（无成员）整体平移存储 position，memberIds 为空', () => {
    const nodes: GraphNode[] = [groupNode('group-a', 0, 0), groupNode('group-b', 100, 0)];
    const relocations = resolveContainerOverlaps({
      nodes,
      sizeSources: buildSizeSources(nodes),
      snapGrid: [20, 20],
      containerIds: ['group-a', 'group-b'],
    });

    expect(relocations).toHaveLength(1);
    const relocation = relocations[0];
    if (!relocation) throw new Error('relocation missing');
    expect(relocation.memberIds).toEqual([]);
    expect(relocation.containerTargetPosition).toEqual(relocation.delta);
    const after = derivedOf(applyRelocations(nodes, relocations));
    expect(
      rectsIntersect(entryRect(requireEntry(after, 'group-a')), entryRect(requireEntry(after, 'group-b'))),
    ).toBe(false);
  });

  it('折叠容器按派生卡片参与判定，隐藏成员保持相对位置同步平移', () => {
    const nodes: GraphNode[] = [
      groupNode('group-a', 0, 0, true),
      leafNode('a1', 0, 0, 'group-a'),
      leafNode('a2', 300, 150, 'group-a'),
      groupNode('group-b', 100, 0),
      leafNode('b1', 100, 0, 'group-b'),
    ];
    const relocations = resolveContainerOverlaps({
      nodes,
      sizeSources: buildSizeSources(nodes),
      snapGrid: [20, 20],
      containerIds: ['group-a'],
    });

    expect(relocations).toHaveLength(1);
    const relocation = relocations[0];
    if (!relocation) throw new Error('relocation missing');
    expect([...relocation.memberIds].sort()).toEqual(['a1', 'a2']);
    const movedNodes = applyRelocations(nodes, relocations);
    const after = derivedOf(movedNodes);
    expect(
      rectsIntersect(entryRect(requireEntry(after, 'group-a')), entryRect(requireEntry(after, 'group-b'))),
    ).toBe(false);
    // 隐藏成员同 delta 平移（相对位置保持）
    const a1 = movedNodes.find((node) => node.id === 'a1');
    const a2 = movedNodes.find((node) => node.id === 'a2');
    expect(a1?.position).toEqual({ x: 0 + relocation.delta.x, y: 0 + relocation.delta.y });
    expect(a2?.position).toEqual({ x: 300 + relocation.delta.x, y: 150 + relocation.delta.y });
  });

  it('无成员 Agent 容器按静态有效尺寸兜底参与判定与让位', () => {
    const nodes: GraphNode[] = [
      agentNode('agent-a', 0, 0, undefined),
      agentNode('agent-b', 100, 0, undefined),
    ];
    const relocations = resolveContainerOverlaps({
      nodes,
      sizeSources: buildSizeSources(nodes),
      snapGrid: [20, 20],
      containerIds: ['agent-a', 'agent-b'],
    });

    expect(relocations).toHaveLength(1);
    const relocation = relocations[0];
    if (!relocation) throw new Error('relocation missing');
    const movedNodes = applyRelocations(nodes, relocations);
    const rectOf = (id: string) => {
      const node = movedNodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error(`node missing: ${id}`);
      return {
        x: node.position.x,
        y: node.position.y,
        width: MEMBER_SIZE.width,
        height: MEMBER_SIZE.height,
      };
    };
    expect(rectsIntersect(rectOf('agent-a'), rectOf('agent-b'))).toBe(false);
  });
});
