// @spec: AL-GC-005
//
// 视觉阅读序与重排差异共享原语（readingOrder.ts）的行为锁定：
// 先按 y 分行（容差 1px）、行内按 x、完全同坐标按插入序兜底；排位变化输出槽位差。

import { describe, expect, it } from 'vitest';

import {
  computeOrderChanges,
  orderByReadingPosition,
  READING_ORDER_ROW_TOLERANCE_PX,
} from '../readingOrder';

const node = (id: string, x: number, y: number) => ({ id, position: { x, y } });

describe('orderByReadingPosition', () => {
  it('先按 y 分行、行内按 x 升序', () => {
    const ordered = orderByReadingPosition([
      node('bottom-right', 500, 300),
      node('top-right', 500, 0),
      node('bottom-left', 0, 300),
      node('top-left', 0, 0),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
  });

  it('y 差不超过 1px 视为同一行（2px 则分行）', () => {
    expect(READING_ORDER_ROW_TOLERANCE_PX).toBe(1);
    // 差 1px：同一行，行内按 x → 左侧在先
    const sameRow = orderByReadingPosition([node('left', 0, 101), node('right', 100, 100)]);
    expect(sameRow.map((entry) => entry.id)).toEqual(['left', 'right']);
    // 差 2px：分行，y 小的整行在先 → 右侧在先
    const nextRow = orderByReadingPosition([node('left', 0, 102), node('right', 100, 100)]);
    expect(nextRow.map((entry) => entry.id)).toEqual(['right', 'left']);
  });

  it('完全同坐标时按插入序兜底（稳定）', () => {
    const ordered = orderByReadingPosition([node('second', 0, 0), node('first', 0, 0)]);
    expect(ordered.map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('不修改输入数组', () => {
    const input = [node('b', 0, 10), node('a', 0, 0)];
    const ordered = orderByReadingPosition(input);
    expect(ordered).not.toBe(input);
    expect(input.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('computeOrderChanges', () => {
  it('顺序未变时 contentReordered=false、无槽位差', () => {
    const visual = [node('a', 0, 0), node('b', 0, 100)];
    expect(computeOrderChanges(visual, [node('a', 0, 0), node('b', 0, 100)])).toEqual({
      contentReordered: false,
      orderChanges: [],
    });
  });

  it('显式 order 打乱阅读序时报出 0 基槽位变化', () => {
    const visual = [node('a', 0, 0), node('b', 0, 100), node('c', 0, 200)];
    const layout = [node('c', 0, 200), node('a', 0, 0), node('b', 0, 100)];
    const summary = computeOrderChanges(visual, layout);
    expect(summary.contentReordered).toBe(true);
    expect(summary.orderChanges).toEqual([
      { nodeId: 'c', fromSlot: 2, toSlot: 0 },
      { nodeId: 'a', fromSlot: 0, toSlot: 1 },
      { nodeId: 'b', fromSlot: 1, toSlot: 2 },
    ]);
  });

  it('布局序中的越界 id 只占槽位：已存在节点的槽位以各自序列下标为准', () => {
    const visual = [node('a', 0, 0)];
    const layout = [node('ghost', 0, 0), node('a', 0, 0)];
    // ghost 不在视觉序里，不产生自身槽位差；但它占用布局序 0 号槽，a 的槽位由 0 变 1。
    expect(computeOrderChanges(visual, layout)).toEqual({
      contentReordered: true,
      orderChanges: [{ nodeId: 'a', fromSlot: 0, toSlot: 1 }],
    });
  });
});
