import type * as ReactNS from 'react';
import { useEffect } from 'react';
import type * as XyFlowNS from '@xyflow/react';
import { vi } from 'vitest';
import { createNodeGraph, type NodeGraph } from '../../../types/nodeGraph';
import { useCanvasStore } from '../../../store/canvasStore';
import type { GraphNode } from '../../../types';
import {
  useCanvasSelectionBridge,
} from '../useCanvasSelectionBridge';

type FlowNodeLike = {
  id?: string;
  selected?: boolean;
} & Record<string, unknown>;

type FlowEdgeLike = {
  id?: string;
  selected?: boolean;
} & Record<string, unknown>;

export type MockReactFlowProps = {
  children?: React.ReactNode;
  onEdgeClick?: (event: MouseEvent, edge: FlowEdgeLike) => void;
  onNodeClick?: (event: MouseEvent, node: FlowNodeLike) => void;
  nodes?: FlowNodeLike[];
  edges?: FlowEdgeLike[];
  onNodesChange?: (
    changes: Array<{ id: string; type: 'select'; selected: boolean }>,
  ) => void;
  onEdgesChange?: (
    changes: Array<{ id: string; type: 'select'; selected: boolean }>,
  ) => void;
  onPaneClick?: (event: MouseEvent) => void;
  onSelectionChange?: (params: {
    nodes: FlowNodeLike[];
    edges: FlowEdgeLike[];
  }) => void;
} & Record<string, unknown>;

const hoistedMockRuntime = vi.hoisted(() => ({
  reactFlowProps: null as MockReactFlowProps | null,
  flowNodes: [] as FlowNodeLike[],
  flowEdges: [] as FlowEdgeLike[],
}));
const mockRuntime = hoistedMockRuntime;

const forbiddenSelectionDualWriteMessage =
  'NodeCanvas selection tests forbid ReactFlow setNodes/setEdges dual write';

vi.mock('@xyflow/react', async () => {
  const ReactModule = await vi.importActual<typeof ReactNS>('react');
  const actual = await vi.importActual<typeof XyFlowNS>('@xyflow/react');

  return {
    ...actual,
    ReactFlow: (props: MockReactFlowProps) => {
      mockRuntime.reactFlowProps = props;
      mockRuntime.flowNodes = Array.isArray(props.nodes) ? [...props.nodes] : [];
      mockRuntime.flowEdges = Array.isArray(props.edges) ? [...props.edges] : [];
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'mock-reactflow' },
        props.children as React.ReactNode,
      );
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      getNodes: () => mockRuntime.flowNodes,
      getEdges: () => mockRuntime.flowEdges,
      setNodes: () => {
        throw new Error(forbiddenSelectionDualWriteMessage);
      },
      setEdges: () => {
        throw new Error(forbiddenSelectionDualWriteMessage);
      },
      fitView: vi.fn(),
    }),
    useStore: (
      selector: (state: {
        edges: FlowEdgeLike[];
        nodes: FlowNodeLike[];
        transform: [number, number, number];
      }) => unknown,
    ) =>
      selector({
        edges: mockRuntime.flowEdges,
        nodes: mockRuntime.flowNodes,
        transform: [0, 0, 1],
      }),
  };
});

vi.mock('../../../hooks/useCanvasOverviewMode', () => ({
  useCanvasOverviewMode: () => ({
    isOverview: false,
    preparingExit: false,
    onMoveStart: vi.fn(),
    onMoveEnd: vi.fn(),
  }),
}));

vi.mock('../../nodes', () => ({
  nodeTypes: {},
}));

vi.mock('../CanvasOverviewLayer', () => ({
  CanvasOverviewLayer: () => null,
}));

vi.mock('../AnnotationOverlay', () => ({
  AnnotationOverlay: () => null,
}));

vi.mock('../CanvasContextMenu', () => ({
  CanvasContextMenu: () => null,
}));

vi.mock('../../NodeExecutionToolbar', () => ({
  NodeExecutionToolbar: () => null,
}));

vi.mock('../../character/CharacterDock', () => ({
  CharacterDock: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { NodeCanvas as NodeCanvasComponent } from '../NodeCanvas';

export type CanvasSelectionCommandTestDriver = {
  applySelectionCommand: (command: {
    kind: "replace-selection";
    selection: {
      nodeIds: string[];
      annotationIds: string[];
    };
  }, reason: string) => void;
  selectEntireCanvas: (reason: string) => void;
  selectNodes: (nodeIds: string[], reason: string) => void;
};

const canvasSelectionCommandDriverState: {
  current: CanvasSelectionCommandTestDriver | null;
} = {
  current: null,
};

function CanvasSelectionCommandDriver() {
  const { applySelectionCommand, selectEntireCanvas, selectNodes } =
    useCanvasSelectionBridge();

  useEffect(() => {
    canvasSelectionCommandDriverState.current = {
      applySelectionCommand,
      selectEntireCanvas,
      selectNodes,
    };
    return () => {
      canvasSelectionCommandDriverState.current = null;
    };
  }, [applySelectionCommand, selectEntireCanvas, selectNodes]);

  return null;
}

const NodeCanvas = () => (
  <>
    <CanvasSelectionCommandDriver />
    <NodeCanvasComponent />
  </>
);
const canvasStore = useCanvasStore;

const makeGraphNode = (
  overrides: Partial<GraphNode> & Pick<GraphNode, 'id' | 'type' | 'position' | 'data'>,
): GraphNode => ({
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
  ...overrides,
});

export const resetCanvasStore = () => {
  canvasSelectionCommandDriverState.current = null;
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.structureRevision = 0;
    state.positionRevision = 0;
    state.layoutRevision = 0;
    state.ui.desiredSizeByNodeId = {};
  });
};

export const createPrimaryClickEvent = (position: {
  clientX: number;
  clientY: number;
} & Partial<Pick<MouseEvent, 'ctrlKey' | 'shiftKey' | 'metaKey'>>): MouseEvent =>
  new MouseEvent('click', {
    button: 0,
    bubbles: true,
    cancelable: true,
    ctrlKey: position.ctrlKey ?? false,
    shiftKey: position.shiftKey ?? false,
    metaKey: position.metaKey ?? false,
    clientX: position.clientX,
    clientY: position.clientY,
  });

export const seedMinimalGraph = () => {
  const graph: NodeGraph = createNodeGraph({
    name: 'NodeCanvas Selection Test Graph',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.id = 'graph-nodecanvas-selection-test';
  graph.nodes = [
    makeGraphNode({
      id: 'node-1',
      type: 'textInput',
      position: { x: 0, y: 0 },
      data: {
        label: '文本节点',
        segments: [],
        separator: 'comma',
        customSeparator: '',
        lastExecutionId: undefined,
        lastSourceNodeId: undefined,
        lastSourcePortId: undefined,
        promptPresetSnapshots: undefined,
        taskInfo: undefined,
        promptInterview: undefined,
        description: undefined,
        runtimeRef: undefined,
      },
    }),
    makeGraphNode({
      id: 'node-2',
      type: 'textInput',
      position: { x: 240, y: 0 },
      data: {
        label: '目标文本节点',
        segments: [],
        separator: 'comma',
        customSeparator: '',
        lastExecutionId: undefined,
        lastSourceNodeId: undefined,
        lastSourcePortId: undefined,
        promptPresetSnapshots: undefined,
        taskInfo: undefined,
        promptInterview: undefined,
        description: undefined,
        runtimeRef: undefined,
      },
    }),
  ];

  mockRuntime.flowNodes = graph.nodes.map((node) => ({
    id: node.id,
    selected: false,
  }));
  // 连线已整体下线：渲染层不承载边，mock 的 flowEdges 恒为空。
  mockRuntime.flowEdges = [];

  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
  });
};

export const getCanvasSelectionCommandDriver =
  (): CanvasSelectionCommandTestDriver => {
    const driver = canvasSelectionCommandDriverState.current;
    if (driver === null) {
      throw new Error('Canvas selection command test driver is not ready');
    }
    return driver;
  };

export { canvasStore as useCanvasStore, mockRuntime, NodeCanvas };
