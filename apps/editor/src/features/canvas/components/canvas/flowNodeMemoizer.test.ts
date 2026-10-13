import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { reconcileFlowNodesById } from './flowNodeMemoizer';

const makeNode = (id: string, overrides: Partial<Node> = {}): Node => ({
  id,
  type: 'textInput',
  position: { x: 0, y: 0 },
  data: { id },
  draggable: true,
  connectable: true,
  ...overrides,
});

describe('reconcileFlowNodesById', () => {
  it('reuses unchanged node objects by id', () => {
    const dataA = { id: 'a' };
    const dataB = { id: 'b' };
    const dataC = { id: 'c' };

    const firstNodes = [
      makeNode('a', { data: dataA }),
      makeNode('b', { data: dataB }),
      makeNode('c', { data: dataC }),
    ];
    const first = reconcileFlowNodesById(new Map(), firstNodes);

    const nextNodes = [
      makeNode('a', { data: dataA }),
      makeNode('b', { data: dataB, position: { x: 10, y: 0 } }),
      makeNode('c', { data: dataC }),
    ];
    const second = reconcileFlowNodesById(first.nextById, nextNodes);

    expect(second.nodes[0]).toBe(first.nodes[0]);
    expect(second.nodes[1]).not.toBe(first.nodes[1]);
    expect(second.nodes[2]).toBe(first.nodes[2]);
    expect(second.stats).toEqual({ total: 3, reused: 2, updated: 1, created: 0, removed: 0 });
  });

  it('treats false and undefined boolean fields as equivalent', () => {
    const dataA = { id: 'a' };

    const first = reconcileFlowNodesById(new Map(), [makeNode('a', { data: dataA })]);
    const second = reconcileFlowNodesById(first.nextById, [makeNode('a', { data: dataA, selected: false })]);

    expect(second.nodes[0]).toBe(first.nodes[0]);
  });

  it('does not reuse when the data reference changes', () => {
    const first = reconcileFlowNodesById(new Map(), [makeNode('a', { data: { id: 'a' } })]);
    const second = reconcileFlowNodesById(first.nextById, [makeNode('a', { data: { id: 'a' } })]);

    expect(second.nodes[0]).not.toBe(first.nodes[0]);
  });

  it('reuses when only GraphNode.size changes', () => {
    const stableData = { label: 'A' };

    const prevGraphNode = {
      id: 'a',
      type: 'textInput',
      position: { x: 0, y: 0 },
      data: stableData,
      size: { width: 100, height: 50 },
    };

    const nextGraphNode = {
      ...prevGraphNode,
      size: { width: 101, height: 50 },
    };

    const first = reconcileFlowNodesById(new Map(), [makeNode('a', { data: prevGraphNode })]);
    const second = reconcileFlowNodesById(first.nextById, [makeNode('a', { data: nextGraphNode })]);

    expect(second.nodes[0]).toBe(first.nodes[0]);
  });

  it('does not reuse when GraphNode.data reference changes', () => {
    const prevGraphNode = {
      id: 'a',
      type: 'textInput',
      position: { x: 0, y: 0 },
      data: { label: 'A' },
    };

    const nextGraphNode = {
      ...prevGraphNode,
      data: { label: 'A' },
    };

    const first = reconcileFlowNodesById(new Map(), [makeNode('a', { data: prevGraphNode })]);
    const second = reconcileFlowNodesById(first.nextById, [makeNode('a', { data: nextGraphNode })]);

    expect(second.nodes[0]).not.toBe(first.nodes[0]);
  });

  it('counts removed nodes', () => {
    const first = reconcileFlowNodesById(new Map(), [makeNode('a'), makeNode('b')]);
    const second = reconcileFlowNodesById(first.nextById, [makeNode('a')]);

    expect(second.stats.removed).toBe(1);
  });

  it('preserves measured size when only node position changes', () => {
    const measured = { width: 240, height: 120 };
    const first = reconcileFlowNodesById(new Map(), [
      makeNode('a', {
        width: 240,
        height: 120,
        measured,
      }),
    ]);

    const second = reconcileFlowNodesById(first.nextById, [
      makeNode('a', {
        position: { x: 120, y: 48 },
        width: 240,
        height: 120,
      }),
    ]);

    const secondNode = second.nodes.at(0);
    expect(secondNode).toBeDefined();
    expect(secondNode).not.toBe(first.nodes.at(0));
    expect(secondNode?.position).toEqual({ x: 120, y: 48 });
    expect(secondNode?.measured).toBe(measured);
  });

  it('does not carry stale measured size across real size changes', () => {
    const first = reconcileFlowNodesById(new Map(), [
      makeNode('a', {
        width: 240,
        height: 120,
        measured: { width: 240, height: 120 },
      }),
    ]);

    const second = reconcileFlowNodesById(first.nextById, [
      makeNode('a', {
        width: 360,
        height: 180,
      }),
    ]);

    const secondNode = second.nodes.at(0);
    expect(secondNode?.width).toBe(360);
    expect(secondNode?.height).toBe(180);
    expect(secondNode?.measured).toBeUndefined();
  });
});
