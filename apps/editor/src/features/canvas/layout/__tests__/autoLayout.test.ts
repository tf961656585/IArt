import { describe, expect, it } from 'vitest';
import { computeAutoLayout } from '../autoLayout';
import { NODE_GAP } from '../layoutPrimitives';
import { DEFAULT_NODE_SIZE } from '../../utils/effectiveSize';
import type { GraphNode, NodePosition, NodeSize } from '../../types';

/**
 * 布局尺寸来源链回归测试。
 *
 * 背景：组内整理 / 全局整理曾出现「整理后组内节点重叠」——算法拿到的是注册表 default 尺寸
 *（asset 240x180），而节点真实渲染高度是 320（Layout Model），竖向栈间距 180+120=300 < 320。
 * 根因是 computeAutoLayout 重建 sizeSources 时把调用方传入的 layoutModelByNodeId 抹成 undefined
 *（spec：画布自动布局算法.md「输入契约·调用层尺寸可信度义务」；画布节点尺寸管理架构.md
 * 「与画布自动布局算法.md 的关系」）。
 *
 * 本文件锁定「布局必须消费 Layout Model」这条主链契约。
 */

const SNAP_GRID: [number, number] = [15, 15];

const makeNode = (id: string, size: NodeSize): GraphNode => ({
  id,
  type: 'asset',
  position: { x: 0, y: 0 } as NodePosition,
  data: {} as GraphNode['data'],
  draggable: undefined,
  size,
  style: undefined,
  groupId: undefined,
});

/** 无连边输入的布局走孤立节点垂直栈：相邻节点间距 = 尺寸高度 + NODE_GAP。 */
const verticalPitch = (
  positions: Record<string, NodePosition>,
  firstId: string,
  secondId: string,
): number => {
  const first = positions[firstId];
  const second = positions[secondId];
  if (!first || !second) throw new Error(`missing position: ${firstId} / ${secondId}`);
  return second.y - first.y;
};

describe('computeAutoLayout 尺寸来源链', () => {
  const LAYOUT_MODEL_HEIGHT = 320;

  it('存在 layoutModel 时必须消费 layoutModel，而不是回退到 default 尺寸', async () => {
    const nodes = [makeNode('a', DEFAULT_NODE_SIZE), makeNode('b', DEFAULT_NODE_SIZE)];
    const layoutModelByNodeId: Record<string, NodeSize> = {
      a: { width: 240, height: LAYOUT_MODEL_HEIGHT },
      b: { width: 240, height: LAYOUT_MODEL_HEIGHT },
    };

    const result = await computeAutoLayout(nodes, {
      defaultNodeSize: undefined,
      snapGrid: SNAP_GRID,
      sizeSources: {
        measuredByNodeId: undefined,
        desiredByNodeId: undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId,
      },
    });

    const pitch = verticalPitch(result.positions, 'a', 'b');
    // default 高度 120 时间距是 240；回退到 asset 注册表 default 180 时是 300。
    // 消费 layoutModel(320) 时应为 320 + NODE_GAP(120) = 440（经 15px 网格对齐后约 435）。
    expect(pitch).toBeGreaterThan(LAYOUT_MODEL_HEIGHT + NODE_GAP - 10);
    expect(pitch).toBeLessThan(LAYOUT_MODEL_HEIGHT + NODE_GAP + 10);
  });

  it('layoutModel 与 measured 同值时产出相同位置（Layout Model 是 measured 缺失时的同源替代）', async () => {
    const nodes = [makeNode('a', DEFAULT_NODE_SIZE), makeNode('b', DEFAULT_NODE_SIZE)];
    const size: NodeSize = { width: 240, height: LAYOUT_MODEL_HEIGHT };

    const viaLayoutModel = await computeAutoLayout(nodes, {
      defaultNodeSize: undefined,
      snapGrid: SNAP_GRID,
      sizeSources: {
        measuredByNodeId: undefined,
        desiredByNodeId: undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId: { a: size, b: size },
      },
    });
    const viaMeasured = await computeAutoLayout(nodes, {
      defaultNodeSize: undefined,
      snapGrid: SNAP_GRID,
      sizeSources: {
        measuredByNodeId: { a: size, b: size },
        desiredByNodeId: undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId: undefined,
      },
    });

    expect(viaLayoutModel.positions).toEqual(viaMeasured.positions);
  });

  it('调用方未提供任何来源时仍走 defaultNodeSize 兜底档', async () => {
    const nodes = [makeNode('a', DEFAULT_NODE_SIZE), makeNode('b', DEFAULT_NODE_SIZE)];
    const fallback: NodeSize = { width: 100, height: 100 };

    const result = await computeAutoLayout(nodes, {
      defaultNodeSize: fallback,
      snapGrid: SNAP_GRID,
      sizeSources: undefined,
    });

    const pitch = verticalPitch(result.positions, 'a', 'b');
    expect(pitch).toBeGreaterThan(fallback.height + NODE_GAP - 10);
    expect(pitch).toBeLessThan(fallback.height + NODE_GAP + 10);
  });
});
