import { describe, expect, it } from 'vitest';
import { reconcileFlowNodesById } from '../flowNodeMemoizer';
import { mergeFlowNodeSizeByNodeId, toFlowNodes } from '../nodeCanvasFlowProjection';
import { selectStoreRenderFallbackSizeByNodeId } from '../../../store/selectors';
import type { CanvasLayoutSnapshotNode } from '../../../store/selectors';
import { useCanvasStore } from '../../../store/canvasStore';
import { createNodeGraph } from '../../../types/nodeGraph';
import type { GraphNode, NodePosition, NodeSize } from '../../../types';
import { nodeRegistry } from '../../../nodes/registry';
import {
  createTestNodeGraphParams,
} from '../../__tests__/fixtures/canvasTestBuilders';

const EMPTY_FLOW_NODE_PROJECTION_OPTIONS = {
  groupDerivedByNodeId: undefined,
  selectedNodeIdSet: undefined,
  realMeasuredByNodeId: undefined,
};

const firstNode = <T,>(items: readonly T[]): T => {
  const item = items[0];
  if (!item) throw new Error('expected at least one item');
  return item;
};

const createRegistryNode = (type: Parameters<typeof nodeRegistry.createNode>[0], id: string, position: NodePosition): GraphNode => {
  const node = nodeRegistry.createNode(type, position, undefined);
  if (node === null) {
    throw new Error(`expected registered node type: ${type}`);
  }
  return {
    ...node,
    id,
  };
};

describe('NodeCanvas render size integration', () => {
  it('render size 全量来自 transient/runtime/fallback，且可驱动 flowNode 更新', () => {
    const snapshotNode: CanvasLayoutSnapshotNode = {
      id: 'model-1',
      type: 'model',
      position: { x: 0, y: 0 },
      draggable: true,
    };

    const firstRenderSizeByNodeId: Record<string, NodeSize> = {
      'model-1': { width: 280, height: 160 },
    };

    const firstFlowNodes = toFlowNodes([snapshotNode], {
      ...EMPTY_FLOW_NODE_PROJECTION_OPTIONS,
      renderSizeByNodeId: firstRenderSizeByNodeId,
    });
    const first = reconcileFlowNodesById(new Map(), firstFlowNodes);
    expect(firstNode(first.nodes).width).toBe(280);
    expect(firstNode(first.nodes).height).toBe(160);

    const secondRenderSizeByNodeId: Record<string, NodeSize> = {
      'model-1': { width: 448, height: 388 },
    };
    const secondFlowNodes = toFlowNodes([snapshotNode], {
      ...EMPTY_FLOW_NODE_PROJECTION_OPTIONS,
      renderSizeByNodeId: secondRenderSizeByNodeId,
    });
    const second = reconcileFlowNodesById(first.nextById, secondFlowNodes);

    expect(firstNode(second.nodes).width).toBe(448);
    expect(firstNode(second.nodes).height).toBe(388);
    expect(firstNode(second.nodes)).not.toBe(firstNode(first.nodes));
    expect(second.stats).toEqual({ total: 1, reused: 0, updated: 1, created: 0, removed: 0 });
  });

  it('统一全图尺寸来源后，非组内节点拖拽收尾仍能拿到 render size', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('render-size-regression'));
    const nodes: GraphNode[] = [
      createRegistryNode('videoInput', 'node-free', { x: 40, y: 80 }),
      createRegistryNode('videoInput', 'node-grouped', { x: 240, y: 80 }),
    ];
    graph.nodes = nodes;

    const state: Parameters<typeof selectStoreRenderFallbackSizeByNodeId>[0] = {
      ...useCanvasStore.getState(),
      nodeGraph: graph,
      structureRevision: 1,
      dataRevision: 1,
      layoutRevision: 1,
      ui: {
        desiredSizeByNodeId: {
          'node-free': { size: { width: 300, height: 180 }, state: 'accepted', semanticKey: 'test' },
          'node-grouped': { size: { width: 260, height: 140 }, state: 'accepted', semanticKey: 'test' },
        },
        lastMeasuredSizeByNodeId: {},
        preLayoutMeasuring: false,
        placeholderNodeIds: new Set(),
        canvasContainerSize: null,
        groupDropTargetGroupId: null,
        groupDraggingId: null,
        layoutModelByNodeId: {
          'node-free': { width: 300, height: 180 },
          'node-grouped': { width: 260, height: 140 },
        },
      },
    };

    const fullRenderSizeByNodeId = selectStoreRenderFallbackSizeByNodeId(state);
    const flowNodeSizeByNodeId = mergeFlowNodeSizeByNodeId(fullRenderSizeByNodeId, {
      'node-free': { width: 360, height: 220 },
    });

    const flowNodes = toFlowNodes(
      [
        {
          id: 'node-free',
          type: 'videoInput',
          position: { x: 40, y: 80 },
          draggable: true,
        },
      ],
      {
        ...EMPTY_FLOW_NODE_PROJECTION_OPTIONS,
        renderSizeByNodeId: flowNodeSizeByNodeId,
      },
    );

    expect(fullRenderSizeByNodeId['node-free']).toEqual({ width: 300, height: 180 });
    expect(firstNode(flowNodes).width).toBe(360);
    expect(firstNode(flowNodes).height).toBe(220);
  });
});
