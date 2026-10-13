import { describe, expect, it } from 'vitest';
import { computeLayoutWithElk } from '../elkLayoutEngine';
import type { GraphNode, NodePosition, NodeSize } from '../../types';

const SNAP_GRID: [number, number] = [15, 15];

const makeNode = (
  id: string,
  type: GraphNode['type'],
  position: { x: number; y: number },
  size: { width: number; height: number },
): GraphNode => ({
  id,
  type,
  position: position as NodePosition,
  data: {} as GraphNode['data'],
  draggable: undefined,
  size: size as NodeSize,
  style: undefined,
  groupId: undefined,
});

const buildSizeMap = (nodes: GraphNode[]): Map<string, NodeSize> => {
  const map = new Map<string, NodeSize>();
  for (const n of nodes) {
    map.set(n.id, n.size ?? { width: 220, height: 120 });
  }
  return map;
};

const assertNoOverlap = (
  positions: Record<string, NodePosition>,
  nodes: GraphNode[],
  sizeMap: Map<string, NodeSize>,
) => {
  const bboxes = nodes.map((n) => {
    const pos = positions[n.id];
    const size = sizeMap.get(n.id) ?? { width: 220, height: 120 };
    if (!pos) return null;
    return { id: n.id, minX: pos.x, minY: pos.y, maxX: pos.x + size.width, maxY: pos.y + size.height };
  });
  for (let i = 0; i < bboxes.length; i += 1) {
    for (let j = i + 1; j < bboxes.length; j += 1) {
      const a = bboxes[i];
      const b = bboxes[j];
      if (!a || !b) continue;
      const overlap = a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
      expect(overlap).toBe(false);
    }
  }
};

describe('computeLayoutWithElk 基本布局', () => {
  it('单列垂直摆放：positions 覆盖全部节点，x 相同、y 按输入顺序递增', async () => {
    const nodes = [
      makeNode('a', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('b', 'asset', { x: 0, y: 0 }, { width: 240, height: 140 }),
      makeNode('c', 'asset', { x: 0, y: 0 }, { width: 200, height: 100 }),
    ];
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    expect(Object.keys(positions).length).toBe(3);
    const posA = positions['a'];
    const posB = positions['b'];
    const posC = positions['c'];
    if (!posA || !posB || !posC) throw new Error('expected positions for a/b/c');
    // 单列：三节点 x 相同
    expect(posB.x).toBe(posA.x);
    expect(posC.x).toBe(posA.x);
    // 输入顺序即摆放顺序
    expect(posA.y).toBeLessThan(posB.y);
    expect(posB.y).toBeLessThan(posC.y);
    assertNoOverlap(positions, nodes, sizeMap);
  });
});

describe('computeLayoutWithElk 节点顺序稳定性', () => {
  it('按传入顺序摆放：交换输入顺序后垂直次序随之对应变化', async () => {
    const forward = [
      makeNode('a', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('b', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('c', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
    ];
    const reversed = [forward[2], forward[1], forward[0]].filter(
      (n): n is GraphNode => n !== undefined,
    );

    const forwardPositions = await computeLayoutWithElk(forward, buildSizeMap(forward), {
      snapGrid: SNAP_GRID,
    });
    const reversedPositions = await computeLayoutWithElk(reversed, buildSizeMap(reversed), {
      snapGrid: SNAP_GRID,
    });

    const fa = forwardPositions['a'];
    const fb = forwardPositions['b'];
    const fc = forwardPositions['c'];
    const ra = reversedPositions['a'];
    const rb = reversedPositions['b'];
    const rc = reversedPositions['c'];
    if (!fa || !fb || !fc || !ra || !rb || !rc) throw new Error('expected positions');
    expect(fa.y).toBeLessThan(fb.y);
    expect(fb.y).toBeLessThan(fc.y);
    expect(rc.y).toBeLessThan(rb.y);
    expect(rb.y).toBeLessThan(ra.y);
  });
});

describe('computeLayoutWithElk 孤立节点垂直摆列', () => {
  it('单列垂直栈排列：positions 覆盖全部、不重叠且不横向排布', async () => {
    const nodes = [
      makeNode('a', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('b', 'asset', { x: 0, y: 0 }, { width: 240, height: 140 }),
      makeNode('c', 'asset', { x: 0, y: 0 }, { width: 200, height: 100 }),
      makeNode('d', 'asset', { x: 0, y: 0 }, { width: 260, height: 160 }),
    ];
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    expect(Object.keys(positions).length).toBe(4);
    assertNoOverlap(positions, nodes, sizeMap);
    const first = positions['a'];
    const second = positions['b'];
    const third = positions['c'];
    const fourth = positions['d'];
    if (!first || !second || !third || !fourth) return;
    expect(second.x).toBe(first.x);
    expect(third.x).toBe(first.x);
    expect(fourth.x).toBe(first.x);
    expect(first.y).toBeLessThan(second.y);
    expect(second.y).toBeLessThan(third.y);
    expect(third.y).toBeLessThan(fourth.y);
  });

  it('孤立栈间距由 sizeMap.height 推进：异常大 height 会把后续节点推到极远 y（根因锁定）', async () => {
    // 回归根因：单列摆列用 size.height + nodeGap 推进 currentY。
    // 当 sizeMap 中某节点 height 异常大（如 content-visibility 膨胀的中间态占位值）时，
    // 它后面的孤立节点会被推到极远 y，形成"整理后巨大空隙"。这证明 sizeMap 必须在
    // 进入算法前由 Layout Model 矫正异常值（Layout-Model-Driven 范式下 Layout Model 是
    // 节点尺寸唯一业务事实源，applyDesiredFallback 已下线）。
    const nodes = [
      makeNode('top', 'imageInput', { x: 0, y: 0 }, { width: 320, height: 320 }),
      makeNode('anomaly', 'imageInput', { x: 0, y: 0 }, { width: 240, height: 5000 }),
      makeNode('bottom', 'imageInput', { x: 0, y: 0 }, { width: 240, height: 180 }),
    ];
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    const topY = positions['top']?.y ?? 0;
    const bottomY = positions['bottom']?.y ?? 0;
    // bottom 紧跟在 anomaly（height=5000）之后，被推到 ~5000+ px
    // 这正是"巨大空隙"现象的算法层根因——sizeMap 异常值直接传导到位置。
    expect(bottomY - topY).toBeGreaterThan(5000);
  });

  it('孤立栈在正常 sizeMap 下间距紧凑：矫正后不产生巨大空隙', async () => {
    // 对比用例：同样的三个节点，anomaly 的 height 经防线 C 矫正回 desired（180）后，
    // 孤立栈间距紧凑，bottom 紧跟 anomaly 下方，无巨大空隙。
    const nodes = [
      makeNode('top', 'imageInput', { x: 0, y: 0 }, { width: 320, height: 320 }),
      makeNode('anomaly', 'imageInput', { x: 0, y: 0 }, { width: 240, height: 180 }),
      makeNode('bottom', 'imageInput', { x: 0, y: 0 }, { width: 240, height: 180 }),
    ];
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    const topY = positions['top']?.y ?? 0;
    const bottomY = positions['bottom']?.y ?? 0;
    // 矫正后 bottom = top(0) + 320(top) + 120(gap) + 180(anomaly) + 120(gap) ≈ 740，远小于异常时的 5000+
    expect(bottomY - topY).toBeLessThan(800);
  });
});

describe('computeLayoutWithElk snap grid 吸附', () => {
  it('输出坐标均为 grid 倍数', async () => {
    const nodes = [
      makeNode('a', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('b', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
    ];
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    for (const id of Object.keys(positions)) {
      const pos = positions[id];
      if (!pos) continue;
      expect(pos.x % 15).toBe(0);
      expect(pos.y % 15).toBe(0);
    }
  });
});

describe('computeLayoutWithElk 组节点不参与布局', () => {
  it('调用层过滤组节点后：算法只对自由节点布局，组节点 position 不在输出', async () => {
    // 调用层（store action）已按 spec「组节点在布局中的地位」过滤掉组节点，
    // 算法只接收自由节点。此处模拟过滤后的输入。
    const freeNodes = [
      makeNode('a', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('b', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
    ];
    const sizeMap = buildSizeMap(freeNodes);

    const positions = await computeLayoutWithElk(freeNodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    expect(positions['a']).toBeDefined();
    expect(positions['b']).toBeDefined();
    // 组节点从未进入算法，自然不在输出中
    expect(positions['g']).toBeUndefined();
  });

  it('含大组节点的全局整理：自由节点间距不受组节点派生高度污染（不出现一堆上一堆下）', async () => {
    // 场景：调用层过滤掉 600x800 的组节点后，自由节点按输入顺序单列摆放。
    // 若组节点参与布局，其派生高度会作为条目推进 currentY，把后续自由节点推到极远 y；
    // 过滤后相邻自由节点间距应严格等于前者高度 + nodeGap(120)。
    const freeNodes = [
      makeNode('a', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('b', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
      makeNode('free', 'asset', { x: 0, y: 0 }, { width: 220, height: 120 }),
    ];
    const sizeMap = buildSizeMap(freeNodes);

    const positions = await computeLayoutWithElk(freeNodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });

    const a = positions['a'];
    const b = positions['b'];
    const free = positions['free'];
    if (!a || !b || !free) throw new Error('expected free node positions');
    // 120(高) + 120(gap) = 240，网格对齐后不变；组节点派生高度不得进入推进量
    expect(b.y - a.y).toBe(240);
    expect(free.y - b.y).toBe(240);
  });
});

describe('computeLayoutWithElk 网格摆放（容器内整理列数）', () => {
  const buildNodes = (count: number): GraphNode[] =>
    Array.from({ length: count }, (_, index) =>
      makeNode(`n${index}`, 'asset', { x: 0, y: 0 }, { width: 210, height: 120 }),
    );

  it('给出列数时按列数分行：行内从左到右、行间自上而下', async () => {
    const nodes = buildNodes(6);
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
      columns: 3,
    });

    const [n0, n1, n2, n3, n4, n5] = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map(
      (id) => positions[id],
    );
    if (!n0 || !n1 || !n2 || !n3 || !n4 || !n5) throw new Error('expected positions');
    // 第一行：y 相同、x 递增
    expect(n0.y).toBe(n1.y);
    expect(n1.y).toBe(n2.y);
    expect(n0.x).toBeLessThan(n1.x);
    expect(n1.x).toBeLessThan(n2.x);
    // 第二行从新的 x 起点开始、y 大于第一行
    expect(n3.y).toBe(n4.y);
    expect(n3.y).toBeGreaterThan(n0.y);
    expect(n3.x).toBe(n0.x);
    expect(n2.x).toBe(n5.x);
    assertNoOverlap(positions, nodes, sizeMap);
  });

  it('列数缺省或为 1 时与单列垂直摆放结果一致（全局整理口径不变）', async () => {
    const nodes = buildNodes(4);
    const sizeMap = buildSizeMap(nodes);

    const withoutColumns = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
    });
    const singleColumn = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
      columns: 1,
    });

    expect(singleColumn).toEqual(withoutColumns);
  });

  it('列数超过节点数时回落为一行摆放（不产生空列）', async () => {
    const nodes = buildNodes(3);
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
      columns: 10,
    });

    const ys = nodes.map((n) => positions[n.id]?.y);
    expect(new Set(ys).size).toBe(1);
  });

  it('网格摆放同样满足 snap grid 吸附', async () => {
    const nodes = buildNodes(6);
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
      columns: 4,
    });

    for (const id of Object.keys(positions)) {
      const pos = positions[id];
      if (!pos) continue;
      expect(pos.x % 15).toBe(0);
      expect(pos.y % 15).toBe(0);
    }
  });

  it('列宽取该列最大宽度、行高取该行最大高度：异形节点不重叠', async () => {
    const nodes = [
      makeNode('wide', 'asset', { x: 0, y: 0 }, { width: 400, height: 120 }),
      makeNode('tall', 'asset', { x: 0, y: 0 }, { width: 200, height: 300 }),
      makeNode('small', 'asset', { x: 0, y: 0 }, { width: 200, height: 120 }),
      makeNode('extra', 'asset', { x: 0, y: 0 }, { width: 200, height: 120 }),
    ];
    const sizeMap = buildSizeMap(nodes);

    const positions = await computeLayoutWithElk(nodes, sizeMap, {
      snapGrid: SNAP_GRID,
      columns: 2,
    });

    assertNoOverlap(positions, nodes, sizeMap);
    const small = positions['small'];
    const extra = positions['extra'];
    if (!small || !extra) throw new Error('expected positions');
    // 第二行必须让开第一行最高节点（tall 300），列 1 必须让开列 0 最宽节点（wide 400）
    expect(small.y).toBeGreaterThanOrEqual(300);
    expect(extra.y).toBeGreaterThanOrEqual(300);
    expect(small.x).toBe(0);
    expect(extra.x).toBeGreaterThanOrEqual(400);
  });
});
