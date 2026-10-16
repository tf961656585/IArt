import { describe, expect, it } from 'vitest';
import {
  computeTaskBatchPlacement,
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  type TaskBatchPlacementInput,
} from '../taskNodePlacement';
import type { EffectiveSizeSources } from '../effectiveSize';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { cast } from '@/lib/utils';
import type {
  GraphNode,
  GraphNodeData,
  GraphNodeType,
  NodeGraphViewport,
  NodePosition,
  NodeSize,
} from '../../types';
import { TASK_NODE_DEFAULT_SIZE } from '../../nodes/task/taskNodeFactory';

const CONTAINER = { width: 1440, height: 900 };

const EMPTY_SOURCES: EffectiveSizeSources = {
  measuredByNodeId: undefined,
  desiredByNodeId: undefined,
  derivedByNodeId: undefined,
  defaultByNodeId: undefined,
  layoutModelByNodeId: undefined,
};

/** 显式 measured 尺寸来源：让既有节点占位走真实尺寸解析（而非注册表默认值）。 */
const measuredSources = (sizes: Record<string, NodeSize>): EffectiveSizeSources => ({
  ...EMPTY_SOURCES,
  measuredByNodeId: sizes,
});

const makeNode = (
  id: string,
  x: number,
  y: number,
  size: NodeSize,
  type: GraphNodeType = 'imageInput',
  groupId: string | undefined = undefined,
): GraphNode => ({
  id,
  type,
  position: { x, y },
  data: cast<GraphNodeData>(type === 'group' ? { name: '测试组' } : {}),
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

type OccupancyRect = { x: number; y: number; width: number; height: number };

const rectsIntersect = (a: OccupancyRect, b: OccupancyRect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const makeInput = (overrides: Partial<TaskBatchPlacementInput>): TaskBatchPlacementInput => ({
  viewport: { x: 0, y: 0, zoom: 1 } satisfies NodeGraphViewport,
  containerSize: CONTAINER,
  nodes: [],
  count: 1,
  nodeSize: TASK_NODE_DEFAULT_SIZE,
  perRow: 3,
  referencePositions: [],
  sizeSources: EMPTY_SOURCES,
  ...overrides,
});

/** 默认视口（0,0,1）+ 1440×900 容器的安全区：fitView padding 20/20/35/20。 */
const SAFE = {
  x: CONTAINER.width * 0.2,
  y: CONTAINER.height * 0.2,
  width: CONTAINER.width * 0.6,
  height: CONTAINER.height * (1 - 0.2 - 0.35),
};

const VISIBLE = { x: 0, y: 0, width: CONTAINER.width, height: CONTAINER.height };

const insideRect = (p: NodePosition, rect: typeof SAFE, w: number, h: number): boolean =>
  p.x >= rect.x - 1e-6 &&
  p.y >= rect.y - 1e-6 &&
  p.x + w <= rect.x + rect.width + 1e-6 &&
  p.y + h <= rect.y + rect.height + 1e-6;

/** 批量网格全部格子矩形（按落位基底展开）。 */
const batchCells = (
  base: NodePosition,
  count: number,
  perRow: number,
  nodeSize: NodeSize,
): OccupancyRect[] => {
  const columnWidth = nodeSize.width + TASK_BATCH_GAP_X;
  const rowHeight = nodeSize.height + TASK_BATCH_GAP_Y;
  const cells: OccupancyRect[] = [];
  for (let index = 0; index < count; index += 1) {
    cells.push({
      x: base.x + (index % perRow) * columnWidth,
      y: base.y + Math.floor(index / perRow) * rowHeight,
      width: nodeSize.width,
      height: nodeSize.height,
    });
  }
  return cells;
};

describe('computeTaskBatchPlacement', () => {
  it('空画布默认视口：单个任务节点落在安全区中心', () => {
    const result = computeTaskBatchPlacement(makeInput({}));
    expect(result.mode).toBe('safe');
    expect(result.containerFallback).toBe(false);
    expect(result.base.x).toBeCloseTo(SAFE.x + (SAFE.width - TASK_NODE_DEFAULT_SIZE.width) / 2, 6);
    expect(result.base.y).toBeCloseTo(SAFE.y + (SAFE.height - TASK_NODE_DEFAULT_SIZE.height) / 2, 6);
  });

  it('视口平移到远处：落点跟随视口，不再落在画布原点附近', () => {
    const result = computeTaskBatchPlacement(
      makeInput({ viewport: { x: -5000, y: -3000, zoom: 1 } }),
    );
    expect(result.mode).toBe('safe');
    // 可见世界矩形原点 = (5000, 3000)，安全区在其基础上再内缩 padding
    expect(
      insideRect(
        result.base,
        { ...SAFE, x: 5000 + SAFE.x, y: 3000 + SAFE.y },
        TASK_NODE_DEFAULT_SIZE.width,
        TASK_NODE_DEFAULT_SIZE.height,
      ),
    ).toBe(true);
  });

  it('引用资产在安全区内：锚定参考节点右侧邻近位置', () => {
    const reference: NodePosition = { x: 600, y: 300 };
    const result = computeTaskBatchPlacement(
      makeInput({ referencePositions: [reference] }),
    );
    expect(result.mode).toBe('safe');
    expect(result.base.x).toBeCloseTo(reference.x + TASK_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X, 6);
    expect(result.base.y).toBeCloseTo(reference.y, 6);
  });

  it('锚点被既有节点占据：环形搜索移到最近空闲位且不重叠', () => {
    // 既有节点恰好占据安全区中心（单节点锚点），真实尺寸 240×180
    const anchor = {
      x: SAFE.x + (SAFE.width - TASK_NODE_DEFAULT_SIZE.width) / 2,
      y: SAFE.y + (SAFE.height - TASK_NODE_DEFAULT_SIZE.height) / 2,
    };
    const obstacle = makeNode('occupied', anchor.x, anchor.y, { width: 240, height: 180 });
    const result = computeTaskBatchPlacement(
      makeInput({
        nodes: [obstacle],
        sizeSources: measuredSources({ occupied: { width: 240, height: 180 } }),
      }),
    );
    expect(result.mode).toBe('safe');
    const placed = {
      x: result.base.x,
      y: result.base.y,
      width: TASK_NODE_DEFAULT_SIZE.width,
      height: TASK_NODE_DEFAULT_SIZE.height,
    };
    expect(rectsIntersect(placed, { x: anchor.x, y: anchor.y, width: 240, height: 180 })).toBe(false);
  });

  it('containerSize 缺失：名义尺寸兜底并留痕 containerFallback', () => {
    const result = computeTaskBatchPlacement(makeInput({ containerSize: null }));
    expect(result.containerFallback).toBe(true);
    expect(result.mode).toBe('safe');
    expect(insideRect(result.base, SAFE, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height)).toBe(true);
  });

  it('高倍 zoom 下安全区小于批量：退化到全可见区且完整可见', () => {
    const result = computeTaskBatchPlacement(
      makeInput({ viewport: { x: 0, y: 0, zoom: 4 } }),
    );
    expect(result.mode).toBe('visible');
    // 可见世界矩形：容器尺寸 / zoom
    expect(insideRect(result.base, { x: 0, y: 0, width: 360, height: 225 }, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height)).toBe(true);
  });

  it('批量大于可见区（极端 zoom + 多任务）：不钳制、不重叠，落位以锚点为中心', () => {
    // 旧口径：钳制到可见区左上并允许与既有节点重叠。新口径：整块搜索到不重叠位置为止。
    const result = computeTaskBatchPlacement(
      makeInput({ viewport: { x: 0, y: 0, zoom: 4 }, count: 6 }),
    );
    expect(result.mode).toBe('unbounded');
    // 空画布无障碍：落位与既有节点零重叠是平凡满足；关键是不再钳制到可见区左上
    expect(result.base.x).not.toBeCloseTo(0, 6);
  });

  it('批量 4 个 perRow 3：两行网格整体落在安全区内', () => {
    const result = computeTaskBatchPlacement(makeInput({ count: 4 }));
    expect(result.mode).toBe('safe');
    for (const cell of batchCells(result.base, 4, 3, TASK_NODE_DEFAULT_SIZE)) {
      expect(
        insideRect(cell, SAFE, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height),
        `cell 应在安全区内`,
      ).toBe(true);
    }
  });

  it('引用不可见（安全区外）：环形搜索把落位拉回安全区', () => {
    const result = computeTaskBatchPlacement(
      makeInput({ referencePositions: [{ x: 2000, y: 1500 }] }),
    );
    expect(result.mode).toBe('safe');
    expect(insideRect(result.base, SAFE, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height)).toBe(true);
  });

  it('既有节点按真实有效尺寸占位：大节点不再被 240×180 估计掩盖', () => {
    // 既有节点实测 1200×800 覆盖锚点与其右邻域；旧实现按 240×180 估计会把批量放进大节点内部。
    const reference: NodePosition = { x: 600, y: 300 };
    const big = makeNode('big', 500, 100, { width: 1200, height: 800 });
    const result = computeTaskBatchPlacement(
      makeInput({
        referencePositions: [reference],
        nodes: [big],
        sizeSources: measuredSources({ big: { width: 1200, height: 800 } }),
      }),
    );
    const placed: OccupancyRect = {
      x: result.base.x,
      y: result.base.y,
      width: TASK_NODE_DEFAULT_SIZE.width,
      height: TASK_NODE_DEFAULT_SIZE.height,
    };
    // 落位不得与真实 1200×800 占位相交
    expect(rectsIntersect(placed, { x: 500, y: 100, width: 1200, height: 800 })).toBe(false);
    // 可见性优先级不变：结果仍完整落在可见区内
    expect(insideRect(result.base, VISIBLE, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height)).toBe(true);
  });

  it('容器节点按派生包围盒整体占位：批量不落进组框内部', () => {
    // 组成员横跨 300..1240，派生包围盒（含 padding 与标题高度）远大于 240×180 估计。
    const groupId = 'group-1';
    const m1 = makeNode('m1', 300, 200, { width: 240, height: 180 }, 'imageInput', groupId);
    const m2 = makeNode('m2', 1000, 200, { width: 240, height: 180 }, 'imageInput', groupId);
    const group = makeNode(groupId, 288, 160, { width: 964, height: 232 }, 'group');
    const nodes = [group, m1, m2];
    const derived = buildGroupDerivedSize({
      nodes,
      sizeSources: measuredSources({
        m1: { width: 240, height: 180 },
        m2: { width: 240, height: 180 },
      }),
    });
    const entry = derived.byGroupId[groupId];
    if (!entry) throw new Error('组派生几何缺失');
    const derivedRect: OccupancyRect = {
      x: entry.position.x,
      y: entry.position.y,
      width: entry.size.width,
      height: entry.size.height,
    };

    const result = computeTaskBatchPlacement(
      makeInput({
        referencePositions: [{ x: 500, y: 240 }],
        nodes,
        sizeSources: measuredSources({
          m1: { width: 240, height: 180 },
          m2: { width: 240, height: 180 },
        }),
      }),
    );
    const placed: OccupancyRect = {
      x: result.base.x,
      y: result.base.y,
      width: TASK_NODE_DEFAULT_SIZE.width,
      height: TASK_NODE_DEFAULT_SIZE.height,
    };
    // 锚点（参考节点右侧）在组框内部：落位必须搜索到组框之外，而不是按 240×180 估计落进组框
    expect(rectsIntersect(placed, derivedRect)).toBe(false);
  });

  it('安全区与可见区全被占满：无上限搜索在可见区外找到不重叠位置', () => {
    // 障碍墙覆盖锚点周边 ±2600×±2000（远超旧 8 环半径 2240），旧实现两档搜索耗尽后钳制重叠。
    const anchor = {
      x: SAFE.x + (SAFE.width - TASK_NODE_DEFAULT_SIZE.width) / 2,
      y: SAFE.y + (SAFE.height - TASK_NODE_DEFAULT_SIZE.height) / 2,
    };
    const nodes: GraphNode[] = [];
    const measured: Record<string, NodeSize> = {};
    for (let dx = -2600; dx <= 2600; dx += 260) {
      for (let dy = -2000; dy <= 2000; dy += 200) {
        const id = `wall-${dx}-${dy}`;
        nodes.push(makeNode(id, anchor.x + dx, anchor.y + dy, { width: 240, height: 180 }));
        measured[id] = { width: 240, height: 180 };
      }
    }
    const result = computeTaskBatchPlacement(
      makeInput({ nodes, sizeSources: measuredSources(measured) }),
    );
    expect(result.mode).toBe('unbounded');
    // 落位在可见区外（墙把可见区内全部候选位占满）
    expect(
      insideRect(result.base, VISIBLE, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height),
    ).toBe(false);
    // 与任何一个障碍墙节点都不相交
    const placed: OccupancyRect = {
      x: result.base.x,
      y: result.base.y,
      width: TASK_NODE_DEFAULT_SIZE.width,
      height: TASK_NODE_DEFAULT_SIZE.height,
    };
    for (const node of nodes) {
      expect(
        rectsIntersect(placed, {
          x: node.position.x,
          y: node.position.y,
          width: 240,
          height: 180,
        }),
        `与障碍 ${node.id} 相交`,
      ).toBe(false);
    }
  });

  it('返回批量包围盒与可见区包围盒（远处出生提示的判定输入）', () => {
    const result = computeTaskBatchPlacement(makeInput({ count: 4 }));
    expect(result.batchBounds.x).toBe(result.base.x);
    expect(result.batchBounds.y).toBe(result.base.y);
    expect(result.batchBounds.width).toBe(3 * TASK_NODE_DEFAULT_SIZE.width + 2 * TASK_BATCH_GAP_X);
    expect(result.batchBounds.height).toBe(2 * TASK_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y);
    expect(result.visibleBounds.x).toBeCloseTo(VISIBLE.x, 6);
    expect(result.visibleBounds.width).toBe(VISIBLE.width);
  });
});
