import { describe, expect, it } from 'vitest';
import { buildGroupDerivedSize } from '../groupDerivedSize';
import { toFlowNodes } from '../nodeCanvasFlowProjection';
import {
  GROUP_COLLAPSED_HEIGHT,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING,
} from '../../../services/groupGeometry';
import type { CanvasLayoutSnapshotNode } from '../../../store/selectors';
import type {
  AgentNodeData,
  GraphNode,
  GroupNodeData,
  NodeSize,
  TextInputNodeData,
} from '../../../types';

const makeTextInputNode = (
  id: string,
  groupId: string | undefined,
  x: number,
  y: number,
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

const makeAgentNode = (
  id: string,
  groupId: string | undefined,
  x: number,
  y: number,
  collapsed?: boolean,
): GraphNode<AgentNodeData> => ({
  id,
  type: 'agent',
  position: { x, y },
  data: {
    label: 'Agent',
    agentSessionId: `session-${id}`,
    ...(collapsed !== undefined ? { collapsed } : {}),
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const makeGroupNode = (id: string, x: number, y: number): GraphNode<GroupNodeData> => ({
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

const LEAF_SIZE: NodeSize = { width: 240, height: 160 };

const buildSizeSources = (defaultByNodeId: Record<string, NodeSize>) => ({
  measuredByNodeId: undefined,
  desiredByNodeId: undefined,
  derivedByNodeId: undefined,
  defaultByNodeId,
  layoutModelByNodeId: undefined,
});

describe('Agent 容器派生尺寸', () => {
  // @spec: AG-CN-001, AG-CT-005
  it('展开态：成员包围盒 + padding + 容器头高度（与组同一派生规则），position 由共享算法派生', () => {
    const nodes = [
      makeAgentNode('a1', undefined, 0, 0),
      makeTextInputNode('n1', 'a1', 100, 100),
      makeTextInputNode('n2', 'a1', 300, 200),
    ];
    const projection = buildGroupDerivedSize({
      nodes,
      sizeSources: buildSizeSources({ n1: LEAF_SIZE, n2: LEAF_SIZE }),
    });
    const entry = projection.byGroupId['a1'];
    expect(entry).toBeDefined();
    // bbox: x 100..540, y 100..360 → w=440, h=260
    expect(entry?.size).toEqual({
      width: 440 + GROUP_PADDING.left + GROUP_PADDING.right,
      height: 260 + GROUP_PADDING.top + GROUP_PADDING.bottom + GROUP_HEADER_HEIGHT,
    });
    expect(entry?.position).toEqual({
      x: 100 - GROUP_PADDING.left,
      y: 100 - GROUP_PADDING.top - GROUP_HEADER_HEIGHT,
    });
  });

  // @spec: AG-CT-005
  it('无成员 Agent 容器不产派生 entry：走既有静态尺寸路径（defaultSize 240×64）', () => {
    const nodes = [makeAgentNode('a1', undefined, 100, 100)];
    const projection = buildGroupDerivedSize({
      nodes,
      sizeSources: buildSizeSources({}),
    });
    expect(projection.byGroupId['a1']).toBeUndefined();
  });

  // @spec: AG-CN-008
  it('折叠态 Agent 容器：折叠卡片尺寸，position 保持原位', () => {
    const nodes = [makeAgentNode('a1', undefined, 42, 24, true)];
    const projection = buildGroupDerivedSize({
      nodes,
      sizeSources: buildSizeSources({}),
    });
    const entry = projection.byGroupId['a1'];
    expect(entry).toBeDefined();
    expect(entry?.position).toEqual({ x: 42, y: 24 });
    expect(entry?.size.height).toBe(GROUP_COLLAPSED_HEIGHT);
    expect(entry?.size.width).toBeGreaterThanOrEqual(GROUP_COLLAPSED_MIN_WIDTH);
  });

  // @spec: AG-CN-003, AG-CT-002
  it('组内 Agent 容器成员计入组包围盒（成员尺寸经 resolveEffectiveSize 解析 Agent 容器派生尺寸）', () => {
    // a1 的叶成员在 (500,500)，尺寸 240×160 → a1 派生 position (488,460)、size (264,212)
    // a1 store position 与派生 position 一致（运行期由 store 重算保持同步）
    const nodes = [
      makeGroupNode('g1', 0, 0),
      makeAgentNode('a1', 'g1', 488, 460),
      makeTextInputNode('g-leaf', 'g1', 100, 100),
      makeTextInputNode('a-leaf', 'a1', 500, 500),
    ];
    const projection = buildGroupDerivedSize({
      nodes,
      sizeSources: buildSizeSources({
        'g-leaf': LEAF_SIZE,
        'a-leaf': LEAF_SIZE,
      }),
    });
    const agentEntry = projection.byGroupId['a1'];
    expect(agentEntry).toBeDefined();
    // a1 派生尺寸：bbox 240×160 + padding + header
    expect(agentEntry?.size).toEqual({
      width: 240 + GROUP_PADDING.left + GROUP_PADDING.right,
      height: 160 + GROUP_PADDING.top + GROUP_PADDING.bottom + GROUP_HEADER_HEIGHT,
    });
    // 组包围盒须包住 a1 的容器形态范围：
    // members extent: g-leaf 100..340/100..260；a1 488..752/460..672
    // bbox w = 752-100 = 652, h = 672-100 = 572
    const groupEntry = projection.byGroupId['g1'];
    expect(groupEntry).toBeDefined();
    expect(groupEntry?.size).toEqual({
      width: 652 + GROUP_PADDING.left + GROUP_PADDING.right,
      height: 572 + GROUP_PADDING.top + GROUP_PADDING.bottom + GROUP_HEADER_HEIGHT,
    });
  });
});

describe('toFlowNodes 容器分层与派生注入', () => {
  const snapshot = (
    id: string,
    type: CanvasLayoutSnapshotNode['type'],
  ): CanvasLayoutSnapshotNode => ({
    id,
    type,
    position: { x: 0, y: 0 },
    draggable: true,
  });

  // @spec: AG-CN-006（z-order 分层）
  it('组背板 zIndex=-2（低于 Agent 容器背板）', () => {
    const [node] = toFlowNodes([snapshot('g1', 'group')], {
      groupDerivedByNodeId: {
        g1: { position: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
      },
      renderSizeByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });
    expect(node?.zIndex).toBe(-2);
    expect(node?.className).toBe('iart-canvas-group-node');
    // 容器包裹层穿透（AG-CN-016 前置条件）：内联注入，空隙命中落到画布
    // @spec: AG-CN-016
    expect(node?.style?.pointerEvents).toBe('none');
  });

  // @spec: AG-CT-005（容器形态背板）
  it('容器形态 Agent 背板 zIndex=-1 且注入派生尺寸', () => {
    const [node] = toFlowNodes([snapshot('a1', 'agent')], {
      groupDerivedByNodeId: {
        a1: { position: { x: 10, y: 20 }, size: { width: 324, height: 202 } },
      },
      renderSizeByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });
    expect(node?.zIndex).toBe(-1);
    expect(node?.width).toBe(324);
    expect(node?.height).toBe(202);
    expect(node?.position).toEqual({ x: 10, y: 20 });
    // 容器包裹层穿透（AG-CN-016 前置条件）：与组同一口径，空隙命中落到画布
    // @spec: AG-CN-016
    expect(node?.style?.pointerEvents).toBe('none');
  });

  // @spec: AG-CT-005
  it('无成员叶形态 Agent 不设背板 zIndex（保持默认 0 层）', () => {
    const [node] = toFlowNodes([snapshot('a1', 'agent')], {
      groupDerivedByNodeId: undefined,
      renderSizeByNodeId: { a1: { width: 240, height: 64 } },
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });
    expect(node?.zIndex).toBeUndefined();
    expect(node?.width).toBe(240);
  });

  // @spec: AG-CN-010（叶节点保持默认层）
  it('叶节点不设背板 zIndex', () => {
    const [node] = toFlowNodes([snapshot('n1', 'asset')], {
      groupDerivedByNodeId: undefined,
      renderSizeByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });
    expect(node?.zIndex).toBeUndefined();
  });
});
