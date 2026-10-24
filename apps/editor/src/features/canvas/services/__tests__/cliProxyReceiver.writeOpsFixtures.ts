/**
 * CLI 画布写命令测试共享种床（真实 store + setState 种节点，沿 cliProxyReceiver.canvasOps
 * 既有惯例）。抽出到独立模块只为避免单个测试文件超过 max-lines，不含任何被测逻辑。
 */

import { CliProxyCommandResponseSchema } from '@iart/contracts';
import type { CliProxyCommandResponse } from '@iart/contracts';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode, GroupNodeData, TextInputNodeData } from '../../types';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '../../utils/nodeOccupancy';

export const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-proxy-write-ops-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

export const resetStore = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
  });
};

export const addTextInputNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): void => {
  const node: GraphNode<TextInputNodeData> = {
    id,
    type: 'textInput',
    position: { x, y },
    data: {
      label: undefined,
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: undefined,
      customSeparator: undefined,
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
};

export const addGroupNode = (id: string, x = 0, y = 0): void => {
  const node: GraphNode<GroupNodeData> = {
    id,
    type: 'group',
    position: { x, y },
    data: {
      label: '节点组',
      description: undefined,
      runtimeRef: undefined,
      name: `组-${id}`,
      collapsed: false,
      color: '#22C55E',
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
};

export const findNode = (id: string): GraphNode | undefined =>
  useCanvasStore.getState().nodeGraph?.nodes.find((node) => node.id === id);

export const positionOf = (id: string): { x: number; y: number } | undefined => {
  const node = findNode(id);
  return node === undefined ? undefined : { x: node.position.x, y: node.position.y };
};

/** 消费端纪律断言：响应必须能通过契约 schema parse。 */
export const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

export const historyLength = (): number => useCanvasStore.getState().history.length;

/** 容器渲染框左上角（派生框，与画布投影同一 owner）；无派生 entry 回落存储 position。 */
export const derivedFrameOf = (id: string): { x: number; y: number } | undefined => {
  const store = useCanvasStore.getState();
  if (store.nodeGraph === null) return undefined;
  const derived = buildGroupDerivedSize({
    nodes: store.nodeGraph.nodes,
    sizeSources: buildCanvasSizeSources(store),
  }).byGroupId[id];
  return derived?.position ?? positionOf(id);
};
