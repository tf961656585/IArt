import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useReconciledFlowNodes } from './flowNodeMemoizer';

const EDGE_ID = 'edge-1';

const edgeData: Edge[] = [
  {
    id: EDGE_ID,
    source: 'node-1',
    sourceHandle: 'out',
    target: 'node-2',
    targetHandle: 'in',
    type: 'default',
  },
];

const makeInitialNodes = (): Node[] => [
  {
    id: 'node-1',
    type: 'default',
    position: { x: 0, y: 0 },
    data: { label: 'Source' },
    width: 240,
    height: 120,
    measured: { width: 240, height: 120 },
    handles: [
      {
        id: 'out',
        type: 'source',
        position: Position.Right,
        x: 240,
        y: 60,
        width: 1,
        height: 1,
      },
    ],
  },
  {
    id: 'node-2',
    type: 'default',
    position: { x: 360, y: 0 },
    data: { label: 'Target' },
    width: 240,
    height: 120,
    measured: { width: 240, height: 120 },
    handles: [
      {
        id: 'in',
        type: 'target',
        position: Position.Left,
        x: 0,
        y: 60,
        width: 1,
        height: 1,
      },
    ],
  },
];

const makeMovedNodesWithoutMeasuredOrHandles = (): Node[] => [
  {
    id: 'node-1',
    type: 'default',
    position: { x: 120, y: 40 },
    data: { label: 'Source' },
    width: 240,
    height: 120,
  },
  {
    id: 'node-2',
    type: 'default',
    position: { x: 480, y: 40 },
    data: { label: 'Target' },
    width: 240,
    height: 120,
  },
];

const getRenderedEdgeCount = (container: HTMLElement): number => container.querySelectorAll('.react-flow__edge').length;

function RawFlowHarness({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <div style={{ width: 960, height: 640 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

function ReconciledFlowHarness({ rawNodes, edges }: { rawNodes: Node[]; edges: Edge[] }) {
  const { nodes } = useReconciledFlowNodes(rawNodes);

  return (
    <div style={{ width: 960, height: 640 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

describe('useReconciledFlowNodes + ReactFlow edge continuity', () => {
  it('没有连续性保留时，边数据仍在但位置更新后 edge DOM 会消失', async () => {
    expect(edgeData.map((edge) => edge.id)).toEqual([EDGE_ID]);

    const { container, rerender } = render(<RawFlowHarness nodes={makeInitialNodes()} edges={edgeData} />);

    await waitFor(() => {
      expect(getRenderedEdgeCount(container)).toBe(1);
    });

    rerender(<RawFlowHarness nodes={makeMovedNodesWithoutMeasuredOrHandles()} edges={edgeData} />);

    await waitFor(() => {
      expect(edgeData.map((edge) => edge.id)).toEqual([EDGE_ID]);
      expect(getRenderedEdgeCount(container)).toBe(0);
    });
  });

  it('保住 measured 连续性后，边数据仍在且位置更新后 edge DOM 继续存在', async () => {
    expect(edgeData.map((edge) => edge.id)).toEqual([EDGE_ID]);

    const { container, rerender } = render(<ReconciledFlowHarness rawNodes={makeInitialNodes()} edges={edgeData} />);

    await waitFor(() => {
      expect(getRenderedEdgeCount(container)).toBe(1);
    });

    rerender(<ReconciledFlowHarness rawNodes={makeMovedNodesWithoutMeasuredOrHandles()} edges={edgeData} />);

    await waitFor(() => {
      expect(edgeData.map((edge) => edge.id)).toEqual([EDGE_ID]);
      expect(getRenderedEdgeCount(container)).toBe(1);
    });
  });
});
