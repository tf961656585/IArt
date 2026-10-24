// @spec: CLI-055
//
// 顶层容器看板排布纯函数（spec docs/integrations/CLI与本地Agent集成.md §5.3）：
// 行高取最大、列数缺省推导、向上取整不缩小间距、原点保持、阅读序排序、显式 order 优先。

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_PACK_READING_ROW_TOLERANCE,
  computeContainerPack,
  deriveContainerPackColumns,
  orderContainersForPack,
  type ContainerPackInput,
} from '../containerPack';

const box = (x: number, y: number, width: number, height: number) => ({
  position: { x, y },
  size: { width, height },
});

const container = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): ContainerPackInput => ({ id, box: box(x, y, width, height) });

const placementOf = (
  result: ReturnType<typeof computeContainerPack>,
  id: string,
): { x: number; y: number } | undefined =>
  result.placements.find((placement) => placement.id === id)?.position;

describe('computeContainerPack', () => {
  it('行高取该行容器高度的最大值，下一行按行高 + gap 下移', () => {
    const result = computeContainerPack({
      containers: [
        container('a', 0, 0, 100, 50),
        container('b', 0, 0, 100, 200),
        container('c', 0, 0, 100, 60),
      ],
      columns: 2,
      gap: 10,
      snapGrid: 1,
    });

    expect(placementOf(result, 'a')).toEqual({ x: 0, y: 0 });
    expect(placementOf(result, 'b')).toEqual({ x: 110, y: 0 });
    // 第二行 y = 行高 200 + gap 10
    expect(placementOf(result, 'c')).toEqual({ x: 0, y: 210 });
  });

  it('列数缺省按 sqrt(N) 向上取整推导（大致方形看板），显式列数原样使用', () => {
    const five = Array.from({ length: 5 }, (_, index) =>
      container(`c${index}`, index * 10, 0, 10, 10),
    );
    expect(computeContainerPack({ containers: five, columns: null, gap: 0, snapGrid: 1 }).columns).toBe(3);
    expect(computeContainerPack({ containers: five, columns: 2, gap: 0, snapGrid: 1 }).columns).toBe(2);
    expect(deriveContainerPackColumns(1)).toBe(1);
    expect(deriveContainerPackColumns(0)).toBe(1);
    expect(deriveContainerPackColumns(9)).toBe(3);
  });

  it('原点保持：首格 = min(x) / min(y)（含负数坐标），不整体跳到画布原点', () => {
    const result = computeContainerPack({
      containers: [
        container('b', -40, 120, 100, 100),
        container('a', 300, 500, 100, 100),
      ],
      columns: 1,
      gap: 0,
      snapGrid: 1,
    });
    expect(result.origin).toEqual({ x: -40, y: 120 });
    expect(placementOf(result, 'b')).toEqual({ x: -40, y: 120 });
    expect(placementOf(result, 'a')).toEqual({ x: -40, y: 220 });
  });

  it('整块锚点吸附到最近网格点，格子内间距精确（不逐点取整）', () => {
    const result = computeContainerPack({
      containers: [
        container('a', 1, 1, 4, 4),
        container('b', 1, 1, 4, 4),
        container('c', 1, 1, 4, 4),
      ],
      columns: 3,
      gap: 0,
      snapGrid: 15,
    });

    const a = placementOf(result, 'a');
    const b = placementOf(result, 'b');
    const c = placementOf(result, 'c');
    if (a === undefined || b === undefined || c === undefined) throw new Error('placements missing');
    // 整块左上角吸附到最近网格点（1 → 0）；格子内保持精确间距，不再逐点取整。
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b.x - a.x).toBe(4);
    expect(c.x - b.x).toBe(4);
  });

  it('snapGrid <= 1 时坐标原样（不做对齐）', () => {
    const result = computeContainerPack({
      containers: [container('a', 7, 9, 10, 10)],
      columns: 1,
      gap: 3,
      snapGrid: 1,
    });
    expect(placementOf(result, 'a')).toEqual({ x: 7, y: 9 });
  });

  it('空输入：产出空 placements，列数仍给出可用值', () => {
    const result = computeContainerPack({ containers: [], columns: null, gap: 120, snapGrid: 15 });
    expect(result.placements).toEqual([]);
    expect(result.columns).toBe(1);
    expect(result.origin).toEqual({ x: 0, y: 0 });
  });
});

describe('orderContainersForPack', () => {
  it('阅读序：先 y 后 x；y 差在容差内视为同一行按 x 排', () => {
    const inputs = [
      container('bottom-right', 500, 300, 10, 10),
      container('bottom-left', 0, 300, 10, 10),
      container('top-right', 500, 0, 10, 10),
      container('top-left', 0, 0, 10, 10),
    ];
    const ordered = orderContainersForPack(inputs, []);
    expect(ordered.map((input) => input.id)).toEqual([
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
    expect(CONTAINER_PACK_READING_ROW_TOLERANCE).toBe(1);
  });

  it('显式 order 优先（重复 id 去重），未指定容器按阅读序跟排', () => {
    const inputs = [
      container('a', 0, 0, 10, 10),
      container('b', 100, 0, 10, 10),
      container('c', 200, 0, 10, 10),
    ];
    const ordered = orderContainersForPack(inputs, ['c', 'c', 'a']);
    expect(ordered.map((input) => input.id)).toEqual(['c', 'a', 'b']);
  });

  it('order 含未知 id 时只忽略该 id（有效性由调用方前置校验）', () => {
    const inputs = [container('a', 0, 0, 10, 10), container('b', 100, 0, 10, 10)];
    const ordered = orderContainersForPack(inputs, ['ghost', 'b']);
    expect(ordered.map((input) => input.id)).toEqual(['b', 'a']);
  });

  // @spec: AL-GC-005
  it('y 差 ≤1px 视为同一行；完全同坐标按插入序兜底（共享视觉阅读序原语）', () => {
    const sameRow = [
      container('right', 500, 301, 10, 10),
      container('left', 0, 300, 10, 10),
    ];
    expect(orderContainersForPack(sameRow, []).map((input) => input.id)).toEqual([
      'left',
      'right',
    ]);

    const samePoint = [
      container('second', 100, 100, 10, 10),
      container('first', 100, 100, 10, 10),
    ];
    expect(orderContainersForPack(samePoint, []).map((input) => input.id)).toEqual([
      'second',
      'first',
    ]);
  });
});
