import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { applyRenderPositionUpdatesToNodes } from './useFlowRenderState';

const makeNode = (id: string, x: number, y: number): Node => ({
  id,
  type: 'default',
  position: { x, y },
  data: { label: id },
  width: 120,
  height: 80,
  measured: { width: 120, height: 80 },
});

describe('useFlowRenderState render position updates', () => {
  it('dragging position 只更新命中的 render node，未命中节点保持引用稳定', () => {
    const nodeA = makeNode('node-a', 0, 0);
    const nodeB = makeNode('node-b', 200, 0);

    const nextNodes = applyRenderPositionUpdatesToNodes({
      nodes: [nodeA, nodeB],
      updates: [{ id: 'node-a', position: { x: 40, y: 80 } }],
    });

    expect(nextNodes[0]).not.toBe(nodeA);
    expect(nextNodes[0]?.position).toEqual({ x: 40, y: 80 });
    expect(nextNodes[0]?.measured).toBe(nodeA.measured);
    expect(nextNodes[1]).toBe(nodeB);
  });
});
