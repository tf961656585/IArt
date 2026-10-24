// @spec: AL-GC-002, AL-GC-004, AL-GC-005, AL-GC-006
//
// 容器内整理共享计算（锚点吸附 + 精确 gap）与排序口径 helper。
// 纯函数测试：不触碰 store / DOM，输入为真实布局层消费的 GraphNode 形状。

import { describe, expect, it } from 'vitest';

import {
  computeContainerArrangedPositions,
  orderNodesForLayoutMode,
  snapAnchorToGrid,
} from '../containerArrangement';
import { NODE_GAP } from '../layoutPrimitives';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import type { GraphNode, NodePosition, NodeSize } from '../../types';

const makeNode = (id: string, x: number, y: number, size: NodeSize): GraphNode => ({
  id,
  type: 'asset',
  position: { x, y } as NodePosition,
  data: {} as GraphNode['data'],
  draggable: undefined,
  size,
  style: undefined,
  groupId: undefined,
});

const sizeSourcesOf = (nodes: readonly GraphNode[]): EffectiveSizeSources => {
  const defaultByNodeId: Record<string, NodeSize> = {};
  for (const node of nodes) {
    if (node.size !== undefined) defaultByNodeId[node.id] = node.size;
  }
  return {
    measuredByNodeId: undefined,
    desiredByNodeId: undefined,
    derivedByNodeId: undefined,
    defaultByNodeId,
    layoutModelByNodeId: undefined,
  };
};

const SIZE: NodeSize = { width: 100, height: 100 };

describe('snapAnchorToGrid', () => {
  it('吸附到最近网格点', () => {
    expect(snapAnchorToGrid({ x: 100, y: 50 }, [15, 15])).toEqual({ x: 105, y: 45 });
    expect(snapAnchorToGrid({ x: -7, y: 7 }, [10, 10])).toEqual({ x: -10, y: 10 });
  });

  it('snapGrid 缺失或非法（0 / 非有限）时精确保持原位', () => {
    expect(snapAnchorToGrid({ x: 100.4, y: 50.6 }, undefined)).toEqual({ x: 100.4, y: 50.6 });
    expect(snapAnchorToGrid({ x: 100.4, y: 50.6 }, [0, 0])).toEqual({ x: 100.4, y: 50.6 });
    expect(snapAnchorToGrid({ x: 100.4, y: 50.6 }, [Number.NaN, 15])).toEqual({
      x: 100.4,
      y: 45,
    });
  });
});

describe('computeContainerArrangedPositions', () => {
  it('格子间距精确等于缺省 NODE_GAP（不做逐点网格取整）', async () => {
    const nodes = [makeNode('a', 0, 0, SIZE), makeNode('b', 0, 0, SIZE)];
    const positions = await computeContainerArrangedPositions({
      members: nodes,
      sizeSources: sizeSourcesOf(nodes),
      columns: undefined,
      snapGrid: [15, 15],
    });
    if (positions === null) throw new Error('expected positions');
    // 锚点 (0,0) 本身在网格上；b 的 y = 100 + 120（精确值，不吸附）
    expect(positions['a']).toEqual({ x: 0, y: 0 });
    expect(positions['b']).toEqual({ x: 0, y: 100 + NODE_GAP });
  });

  it('gap 入参覆盖缺省：组内网格行距与列距都精确等于 gap', async () => {
    const nodes = [
      makeNode('a', 0, 0, SIZE),
      makeNode('b', 0, 0, SIZE),
      makeNode('c', 0, 0, SIZE),
      makeNode('d', 0, 0, SIZE),
    ];
    const positions = await computeContainerArrangedPositions({
      members: nodes,
      sizeSources: sizeSourcesOf(nodes),
      columns: 2,
      snapGrid: undefined,
      gap: 40,
    });
    if (positions === null) throw new Error('expected positions');
    expect(positions['a']).toEqual({ x: 0, y: 0 });
    expect(positions['b']).toEqual({ x: 140, y: 0 });
    expect(positions['c']).toEqual({ x: 0, y: 140 });
    expect(positions['d']).toEqual({ x: 140, y: 140 });
  });

  it('整块锚点吸附：成员包围盒左上角移动到最近网格点，块内间距不变', async () => {
    const nodes = [makeNode('a', 100, 50, SIZE), makeNode('b', 260, 50, SIZE)];
    const positions = await computeContainerArrangedPositions({
      members: nodes,
      sizeSources: sizeSourcesOf(nodes),
      columns: 1,
      snapGrid: [15, 15],
      gap: 40,
    });
    if (positions === null) throw new Error('expected positions');
    // 锚点 (100, 50) → (105, 45)；单列垂直摆放
    expect(positions['a']).toEqual({ x: 105, y: 45 });
    expect(positions['b']).toEqual({ x: 105, y: 45 + 100 + 40 });
  });

  it('无网格时锚点精确保持整理前位置（不取整）', async () => {
    const nodes = [makeNode('a', 100.4, 50.6, SIZE), makeNode('b', 260, 900, SIZE)];
    const positions = await computeContainerArrangedPositions({
      members: nodes,
      sizeSources: sizeSourcesOf(nodes),
      columns: 1,
      snapGrid: undefined,
    });
    if (positions === null) throw new Error('expected positions');
    expect(positions['a']).toEqual({ x: 100.4, y: 50.6 });
  });

  it('重复整理收敛：同一输入两次产出相同位置', async () => {
    const nodes = [makeNode('a', 800, 700, SIZE), makeNode('b', 900, 850, SIZE)];
    const params = {
      members: nodes,
      sizeSources: sizeSourcesOf(nodes),
      columns: 2,
      snapGrid: [15, 15] as [number, number],
      gap: 120,
    };
    const first = await computeContainerArrangedPositions(params);
    const secondNodes = nodes.map((node) => {
      const next = first?.[node.id];
      return next === undefined ? node : { ...node, position: next };
    });
    const second = await computeContainerArrangedPositions({
      ...params,
      members: secondNodes,
      sizeSources: sizeSourcesOf(secondNodes),
    });
    expect(second).toEqual(first);
  });
});

describe('orderNodesForLayoutMode', () => {
  const nodes = [
    makeNode('bottom', 0, 300, SIZE),
    makeNode('top-right', 400, 0, SIZE),
    makeNode('top-left', 0, 0, SIZE),
  ];

  it('缺省 / position：视觉阅读序（先 y 分行，行内按 x）', () => {
    expect(orderNodesForLayoutMode(nodes, undefined).map((node) => node.id)).toEqual([
      'top-left',
      'top-right',
      'bottom',
    ]);
    expect(orderNodesForLayoutMode(nodes, 'position').map((node) => node.id)).toEqual([
      'top-left',
      'top-right',
      'bottom',
    ]);
  });

  it('insertion：保持调用方数组序', () => {
    expect(orderNodesForLayoutMode(nodes, 'insertion').map((node) => node.id)).toEqual([
      'bottom',
      'top-right',
      'top-left',
    ]);
  });

  it('created：画布侧按 insertion 处理（主进程会先解析成显式 order）', () => {
    expect(orderNodesForLayoutMode(nodes, 'created').map((node) => node.id)).toEqual([
      'bottom',
      'top-right',
      'top-left',
    ]);
  });
});
