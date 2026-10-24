/**
 * `canvas.layout --plan` 测试专用节点种床（批次 1b）。
 *
 * 既有种床（createTestGraph / resetStore / addTextInputNode / addGroupNode / positionOf …）
 * 原样复用 `cliProxyReceiver.writeOpsFixtures`（不改其断言）；本文件只补充计划测试需要的
 * 节点形态：Agent 容器（嵌套容器判定）与折叠组（no_layout_output 跳过口径）。
 */

import { useCanvasStore } from '../../store/canvasStore';
import type { AgentNodeData, GraphNode, GroupNodeData } from '../../types';

const pushNode = (node: GraphNode): void => {
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
};

/** Agent 容器节点（可持有成员，也可作为组的成员——嵌套容器判定用）。 */
export const addAgentNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): void => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x, y },
    data: {
      label: `Agent-${id}`,
      agentSessionId: `session-${id}`,
      collapsed: false,
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId,
  };
  pushNode(node);
};

/** 折叠态组（容器内整理返回 null，计划执行按 no_layout_output 跳过）。 */
export const addCollapsedGroupNode = (id: string, x = 0, y = 0): void => {
  const node: GraphNode<GroupNodeData> = {
    id,
    type: 'group',
    position: { x, y },
    data: {
      label: '节点组',
      description: undefined,
      runtimeRef: undefined,
      name: `组-${id}`,
      collapsed: true,
      color: '#22C55E',
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  pushNode(node);
};
