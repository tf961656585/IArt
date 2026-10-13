import { describe, it, expect } from 'vitest';
import type { GraphNode, GraphNodeData, NodeGraph, NodeGroup } from '@/features/canvas/types';
import { buildClipboardPayloadFromSelection } from '@/features/canvas/clipboard/selectionPayload';

const makeNode = (id: string, x: number, y: number): GraphNode => ({
  id,
  type: 'textInput',
  position: { x, y },
  data: {} as GraphNodeData,
  draggable: true,
  size: { width: 100, height: 100 },
  style: undefined,
  groupId: undefined,
});

const makeGraph = (params: {
  nodes: GraphNode[];
  groups?: NodeGroup[];
}): NodeGraph => {
  const graph: NodeGraph = {
    id: 'ng_test',
    name: 'Test',
    status: 'draft',
    nodes: params.nodes,
    meta: {
      version: '1.0.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  if (params.groups) {
    graph.groups = params.groups;
  }
  return graph;
};

describe('buildClipboardPayloadFromSelection', () => {
  it('returns null when nothing selectable is selected', () => {
    const nodeGraph = makeGraph({ nodes: [] });
    const payload = buildClipboardPayloadFromSelection({
      nodeGraph,
      selectedNodeIds: [],
    });
    expect(payload).toBeNull();
  });

  it('builds payload from selected nodes without inferring group selection', () => {
    const nodeA = makeNode('a', 0, 0);
    const nodeB = makeNode('b', 200, 0);
    const nodeC = makeNode('c', 400, 0);
    const group1: NodeGroup = { id: 'g1', name: 'Group 1', nodeIds: ['a', 'b'], color: '#000' };
    const nodeGraph = makeGraph({
      nodes: [nodeA, nodeB, nodeC],
      groups: [group1],
    });

    const payload = buildClipboardPayloadFromSelection({
      nodeGraph,
      selectedNodeIds: ['a', 'b'],
    });

    expect(payload).not.toBeNull();
    expect(payload?.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(payload?.nodes.every((node) => Object.prototype.hasOwnProperty.call(node, 'selected'))).toBe(false);
    expect(payload?.groups).toBeUndefined();
    expect(payload?.centerPosition).toEqual({ x: 210, y: 60 });
  });

  it('does not preserve groups when only a subset of the group nodes is selected', () => {
    const nodeA = makeNode('a', 0, 0);
    const nodeB = makeNode('b', 200, 0);
    const group1: NodeGroup = { id: 'g1', name: 'Group 1', nodeIds: ['a', 'b'], color: '#000' };
    const nodeGraph = makeGraph({ nodes: [nodeA, nodeB], groups: [group1] });

    const payload = buildClipboardPayloadFromSelection({
      nodeGraph,
      selectedNodeIds: ['a'],
    });

    expect(payload).not.toBeNull();
    expect(payload?.groups).toBeUndefined();
  });
});
