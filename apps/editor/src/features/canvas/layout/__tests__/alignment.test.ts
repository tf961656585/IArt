import { describe, expect, it } from 'vitest';
import { computeAlignment, isDistributeMode } from '../alignment';
import type { NodePosition, NodeSize } from '../../types';

const SNAP_GRID: [number, number] = [15, 15];

const makeNode = (id: string, x: number, y: number, w: number, h: number) => ({
  id,
  position: { x, y } as NodePosition,
  size: { width: w, height: h } as NodeSize,
});

/** 从 result 提取指定 id 的 position，断言非空后返回（简化测试中的空值守卫） */
const getPos = (result: Record<string, NodePosition> | null, id: string): NodePosition => {
  expect(result).not.toBeNull();
  if (!result) throw new Error('result is null');
  const pos = result[id];
  expect(pos).toBeDefined();
  if (!pos) throw new Error(`position ${id} is undefined`);
  return pos;
};

describe('computeAlignment 对齐模式', () => {
  it('左对齐：所有节点 x 等于最小 x（经 snap 吸附）', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 210, 90, 90, 60),
      makeNode('c', 60, 135, 90, 60),
    ];
    const result = computeAlignment(nodes, 'left', 0, SNAP_GRID);
    // min x = 60（已是 15 倍数）
    expect(getPos(result, 'a').x).toBe(60);
    expect(getPos(result, 'b').x).toBe(60);
    expect(getPos(result, 'c').x).toBe(60);
    // y 不变（但经 snap 吸附）
    expect(getPos(result, 'a').y).toBe(60);
    expect(getPos(result, 'b').y).toBe(90);
    expect(getPos(result, 'c').y).toBe(135);
  });

  it('右对齐：所有节点右边界等于最大右边界（经 snap 吸附）', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 210, 90, 105, 60),
      makeNode('c', 60, 135, 90, 60),
    ];
    const result = computeAlignment(nodes, 'right', 0, SNAP_GRID);
    // max right = 315 (b: 210+105)
    expect(getPos(result, 'a').x + 90).toBe(315);
    expect(getPos(result, 'b').x + 105).toBe(315);
    expect(getPos(result, 'c').x + 90).toBe(315);
  });

  it('水平居中：所有节点中心 x 等于选中集中心 x（经 snap 吸附）', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 300, 90, 90, 60),
    ];
    const result = computeAlignment(nodes, 'centerHorizontal', 0, SNAP_GRID);
    // minX=120, maxX=390, center=255
    expect(getPos(result, 'a').x + 45).toBe(255);
    expect(getPos(result, 'b').x + 45).toBe(255);
  });

  it('顶对齐：所有节点 y 等于最小 y（经 snap 吸附）', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 210, 90, 90, 60),
      makeNode('c', 60, 30, 90, 60),
    ];
    const result = computeAlignment(nodes, 'top', 0, SNAP_GRID);
    // min y = 30
    expect(getPos(result, 'a').y).toBe(30);
    expect(getPos(result, 'b').y).toBe(30);
    expect(getPos(result, 'c').y).toBe(30);
  });

  it('底对齐：所有节点底边界等于最大底边界（经 snap 吸附）', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 210, 90, 90, 105),
      makeNode('c', 60, 135, 90, 60),
    ];
    const result = computeAlignment(nodes, 'bottom', 0, SNAP_GRID);
    // max bottom = 195 (b: 90+105)
    expect(getPos(result, 'a').y + 60).toBe(195);
    expect(getPos(result, 'b').y + 105).toBe(195);
    expect(getPos(result, 'c').y + 60).toBe(195);
  });

  it('垂直居中：所有节点中心 y 等于选中集中心 y（经 snap 吸附）', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 210, 210, 90, 60),
    ];
    const result = computeAlignment(nodes, 'centerVertical', 0, SNAP_GRID);
    // minY=60, maxY=270, center=165
    expect(getPos(result, 'a').y + 30).toBe(165);
    expect(getPos(result, 'b').y + 30).toBe(165);
  });
});

describe('computeAlignment 分布模式', () => {
  it('水平分布：首尾不动（经 snap 吸附），中间节点均匀分布', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 300, 90, 90, 60),
      makeNode('c', 510, 135, 90, 60),
    ];
    const gap = 45;
    const result = computeAlignment(nodes, 'distributeHorizontal', gap, SNAP_GRID);
    // 首尾 x 经 snap 吸附（已是 15 倍数）
    expect(getPos(result, 'a').x % 15).toBe(0);
    expect(getPos(result, 'c').x % 15).toBe(0);
    // 中间节点 b 在首尾之间
    const posB = getPos(result, 'b');
    expect(posB.x).toBeGreaterThan(getPos(result, 'a').x);
    expect(posB.x).toBeLessThan(getPos(result, 'c').x);
    expect(posB.x % 15).toBe(0);
  });

  it('垂直分布：首尾不动（经 snap 吸附），中间节点均匀分布', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 300, 210, 90, 60),
      makeNode('c', 510, 360, 90, 60),
    ];
    const gap = 45;
    const result = computeAlignment(nodes, 'distributeVertical', gap, SNAP_GRID);
    expect(getPos(result, 'a').y % 15).toBe(0);
    expect(getPos(result, 'c').y % 15).toBe(0);
    const posB = getPos(result, 'b');
    expect(posB.y).toBeGreaterThan(getPos(result, 'a').y);
    expect(posB.y).toBeLessThan(getPos(result, 'c').y);
    expect(posB.y % 15).toBe(0);
  });
});

describe('computeAlignment 触发条件', () => {
  it('对齐模式需要至少 2 个节点，1 个返回 null', () => {
    const nodes = [makeNode('a', 120, 60, 90, 60)];
    const result = computeAlignment(nodes, 'left', 0, SNAP_GRID);
    expect(result).toBeNull();
  });

  it('分布模式需要至少 3 个节点，2 个返回 null', () => {
    const nodes = [
      makeNode('a', 120, 60, 90, 60),
      makeNode('b', 210, 90, 90, 60),
    ];
    const result = computeAlignment(nodes, 'distributeHorizontal', 45, SNAP_GRID);
    expect(result).toBeNull();
  });

  it('空数组返回 null', () => {
    const result = computeAlignment([], 'left', 0, SNAP_GRID);
    expect(result).toBeNull();
  });
});

describe('computeAlignment snap grid 吸附', () => {
  it('输出坐标吸附到 grid', () => {
    const nodes = [
      makeNode('a', 103, 52, 90, 60),
      makeNode('b', 207, 88, 90, 60),
    ];
    const result = computeAlignment(nodes, 'left', 0, SNAP_GRID);
    // 103 吸附到 105
    expect(getPos(result, 'a').x % 15).toBe(0);
    expect(getPos(result, 'b').x % 15).toBe(0);
  });
});

describe('isDistributeMode', () => {
  it('分布模式返回 true', () => {
    expect(isDistributeMode('distributeHorizontal')).toBe(true);
    expect(isDistributeMode('distributeVertical')).toBe(true);
  });

  it('对齐模式返回 false', () => {
    expect(isDistributeMode('left')).toBe(false);
    expect(isDistributeMode('right')).toBe(false);
    expect(isDistributeMode('top')).toBe(false);
    expect(isDistributeMode('bottom')).toBe(false);
    expect(isDistributeMode('centerHorizontal')).toBe(false);
    expect(isDistributeMode('centerVertical')).toBe(false);
  });
});
