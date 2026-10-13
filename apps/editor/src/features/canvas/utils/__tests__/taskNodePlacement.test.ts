import { describe, expect, it } from 'vitest';
import {
  computeTaskBatchPlacement,
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  type TaskBatchPlacementInput,
} from '../taskNodePlacement';
import { cast } from '@/lib/utils';
import type {
  GraphNode,
  GraphNodeData,
  GraphNodeType,
  NodeGraphViewport,
  NodePosition,
} from '../../types';
import { TASK_NODE_DEFAULT_SIZE } from '../../nodes/task/taskNodeFactory';

const CONTAINER = { width: 1440, height: 900 };

const makeNode = (id: string, x: number, y: number, type: GraphNodeType = 'imageInput'): GraphNode => ({
  id,
  type,
  position: { x, y },
  data: cast<GraphNodeData>({}),
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const makeInput = (overrides: Partial<TaskBatchPlacementInput>): TaskBatchPlacementInput => ({
  viewport: { x: 0, y: 0, zoom: 1 } satisfies NodeGraphViewport,
  containerSize: CONTAINER,
  nodes: [],
  count: 1,
  nodeSize: TASK_NODE_DEFAULT_SIZE,
  perRow: 3,
  referencePositions: [],
  ...overrides,
});

/** 默认视口（0,0,1）+ 1440×900 容器的安全区：fitView padding 20/20/35/20。 */
const SAFE = {
  x: CONTAINER.width * 0.2,
  y: CONTAINER.height * 0.2,
  width: CONTAINER.width * 0.6,
  height: CONTAINER.height * (1 - 0.2 - 0.35),
};

const insideRect = (p: NodePosition, rect: typeof SAFE, w: number, h: number): boolean =>
  p.x >= rect.x - 1e-6 &&
  p.y >= rect.y - 1e-6 &&
  p.x + w <= rect.x + rect.width + 1e-6 &&
  p.y + h <= rect.y + rect.height + 1e-6;

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
    // 既有节点恰好占据安全区中心（单节点锚点）
    const anchor = {
      x: SAFE.x + (SAFE.width - TASK_NODE_DEFAULT_SIZE.width) / 2,
      y: SAFE.y + (SAFE.height - TASK_NODE_DEFAULT_SIZE.height) / 2,
    };
    const result = computeTaskBatchPlacement(
      makeInput({ nodes: [makeNode('occupied', anchor.x, anchor.y)] }),
    );
    expect(result.mode).toBe('safe');
    // 与既有节点占位估计矩形（240×180）不相交
    const occupied = { x: anchor.x, y: anchor.y, width: 240, height: 180 };
    const placed = {
      x: result.base.x,
      y: result.base.y,
      width: TASK_NODE_DEFAULT_SIZE.width,
      height: TASK_NODE_DEFAULT_SIZE.height,
    };
    const intersects =
      placed.x < occupied.x + occupied.width &&
      occupied.x < placed.x + placed.width &&
      placed.y < occupied.y + occupied.height &&
      occupied.y < placed.y + placed.height;
    expect(intersects).toBe(false);
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

  it('批量大于可见区（极端 zoom + 多任务）：钳制到可见区左上，可见性优先于防重叠', () => {
    const result = computeTaskBatchPlacement(
      makeInput({ viewport: { x: 0, y: 0, zoom: 4 }, count: 6 }),
    );
    expect(result.mode).toBe('clamped');
    expect(result.base.x).toBeCloseTo(0, 6);
    expect(result.base.y).toBeCloseTo(0, 6);
  });

  it('批量 4 个 perRow 3：两行网格整体落在可见区内', () => {
    const result = computeTaskBatchPlacement(makeInput({ count: 4 }));
    expect(result.mode).toBe('safe');
    const columnWidth = TASK_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X;
    const rowHeight = TASK_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y;
    for (let index = 0; index < 4; index += 1) {
      const cell = {
        x: result.base.x + (index % 3) * columnWidth,
        y: result.base.y + Math.floor(index / 3) * rowHeight,
      };
      expect(
        insideRect(cell, SAFE, TASK_NODE_DEFAULT_SIZE.width, TASK_NODE_DEFAULT_SIZE.height),
        `cell ${index} 应在安全区内`,
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
});
