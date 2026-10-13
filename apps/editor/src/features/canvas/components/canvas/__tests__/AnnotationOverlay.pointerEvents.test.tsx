import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type * as XyFlowNS from '@xyflow/react';
import { createNodeGraph, type NodeGraph } from '../../../types/nodeGraph';
import { useCanvasStore } from '../../../store/canvasStore';
import { AnnotationOverlay } from '../AnnotationOverlay';

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof XyFlowNS>('@xyflow/react');

  return {
    ...actual,
    useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
  };
});

vi.mock('../useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({
    selectAnnotations: vi.fn(),
    applySelectionCommand: vi.fn(),
    selectEntireCanvas: vi.fn(),
    selectNodes: vi.fn(),
  }),
}));

const resetCanvasStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
  });
};

const seedAnnotationGraph = () => {
  const graph: NodeGraph = createNodeGraph({
    name: 'Annotation Overlay Test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.id = 'graph-annotation-overlay-test';
  graph.annotations = [
    {
      id: 'ann-1',
      content: '注释',
      position: { x: 24, y: 36 },
      size: { width: 180, height: 72 },
      binding: { type: 'free' },
      style: { color: '#fef3c7', fontSize: 14 },
    },
  ];
  graph.nodes = [];

  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.selectedAnnotationIds = ['ann-1'];
  });
};

describe('AnnotationOverlay pointer events', () => {
  beforeEach(() => {
    resetCanvasStore();
    seedAnnotationGraph();
  });

  it('只允许注释实体接管事件，空白覆盖层必须保持点击穿透', () => {
    const { container } = render(
      <AnnotationOverlay onOpenContextMenu={() => undefined} />,
    );

    const overlayLayers = Array.from(
      container.querySelectorAll('.absolute.inset-0'),
    );
    expect(overlayLayers).toHaveLength(2);

    const outerLayer = overlayLayers[0];
    const innerLayer = overlayLayers[1];
    const annotationCard = container.querySelector('[role="button"]');

    expect(outerLayer?.className).toContain('pointer-events-none');
    expect(innerLayer?.className).toContain('pointer-events-none');
    expect(annotationCard?.className).toContain('pointer-events-auto');
  });
});
