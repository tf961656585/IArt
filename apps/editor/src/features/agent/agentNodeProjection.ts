/**
 * Agent 节点画布投影（spec 02-Agent节点与画布投影.md「创建事实」）。
 *
 * 唯一创建事实：PromptDock 的 agent 提交被 Backend `agent:accepted` 受理；一次提交恰好
 * 创建一个 Agent 节点（等价于任务主链「受理响应是投影创建的唯一触发事实」）。
 * 后续 token/complete/error 与项目恢复只更新会话数据，绝不再建节点。
 *
 * 落位遵循 docs/runtime/画布节点定位.md 与既有视口锚定落位口径（与任务节点同源）：
 * 视口安全区 → 可见区 → 钳制；参考资产右侧邻近锚定。
 */

import type { AgentNodeData, GraphNode, NodePosition } from '@/features/canvas/types/node';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { normalizeViewport } from '@/features/canvas/components/canvas/nodeCanvasConstants';
import { computeTaskBatchPlacement } from '@/features/canvas/utils/taskNodePlacement';
import { AGENT_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/agent/agentNodeFactory';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';

/** 会话标题截断长度（spec 02：会话摘要标题由首条用户消息文本生成）。 */
export const AGENT_SESSION_TITLE_MAX_LENGTH = 30;

/** 无文本内容时的会话标题兜底（例如仅带图片引用的首条消息；不与「新会话」动作同名）。 */
export const AGENT_SESSION_TITLE_FALLBACK = '未命名会话';

/**
 * 由首条用户消息生成会话标题：取首段文本、折叠空白、按上限截断。
 * 纯函数，便于单测与渲染层复用。
 */
export const resolveAgentSessionTitle = (content: unknown): string => {
  const text = readFirstText(content);
  if (!text) return AGENT_SESSION_TITLE_FALLBACK;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return AGENT_SESSION_TITLE_FALLBACK;
  return collapsed.length > AGENT_SESSION_TITLE_MAX_LENGTH
    ? `${collapsed.slice(0, AGENT_SESSION_TITLE_MAX_LENGTH)}…`
    : collapsed;
};

const readFirstText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return '';
};

/** 会话现有 Agent 节点（节点 ↔ 会话 1:1，禁止重复创建）。 */
export const findAgentNodeBySessionId = (agentSessionId: string): GraphNode<AgentNodeData> | null => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return null;
  const node = graph.nodes.find(
    (candidate) =>
      candidate.type === 'agent' &&
      (candidate.data as AgentNodeData).agentSessionId === agentSessionId,
  );
  return node ? (node as GraphNode<AgentNodeData>) : null;
};

/** 参考资产引用 → 画布资产节点 position（命中不了不阻断落位，留痕跳过）。 */
const collectReferenceNodePositions = (
  referenceAssetIds: ReadonlyArray<string>,
): NodePosition[] => {
  if (referenceAssetIds.length === 0) return [];
  const nodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
  const positions: NodePosition[] = [];
  for (const assetId of referenceAssetIds) {
    const node = nodes.find(
      (candidate) =>
        candidate.type === 'asset' && (candidate.data as AssetNodeData).assetId === assetId,
    );
    if (node) {
      positions.push(node.position);
    } else {
      console.debug('[agentProjection] reference node missing, placement anchor skipped', {
        assetId,
      });
    }
  }
  return positions;
};

/**
 * 受理后创建 Agent 节点并选中（一次提交恰好一个节点）。
 * 返回 null 表示画布未就绪或节点已存在（调用方按失败收口，不重试）。
 */
export const createAgentNodeForAcceptance = (params: {
  agentSessionId: string;
  referenceAssetIds?: ReadonlyArray<string>;
}): GraphNode<AgentNodeData> | null => {
  const store = useCanvasStore.getState();
  const graph = store.nodeGraph;
  if (!graph) {
    console.debug('[agentProjection] nodeGraph not ready, agent node not created', {
      agentSessionId: params.agentSessionId,
    });
    return null;
  }

  const existing = findAgentNodeBySessionId(params.agentSessionId);
  if (existing) {
    // 幂等：同一会话不建第二个节点（节点 ↔ 会话 1:1，spec 02）。
    console.debug('[agentProjection] agent node already exists, reuse', {
      agentSessionId: params.agentSessionId,
      nodeId: existing.id,
    });
    return existing;
  }

  const referencePositions = collectReferenceNodePositions(params.referenceAssetIds ?? []);
  const placement = computeTaskBatchPlacement({
    viewport: normalizeViewport(graph.viewport),
    containerSize: store.ui.canvasContainerSize,
    nodes: graph.nodes,
    count: 1,
    nodeSize: AGENT_NODE_DEFAULT_SIZE,
    perRow: 1,
    referencePositions,
  });

  const node = store.addNode('agent', placement.base, { agentSessionId: params.agentSessionId });
  if (!node) {
    console.debug('[agentProjection] addNode returned null', {
      agentSessionId: params.agentSessionId,
    });
    return null;
  }

  // 创建后选中新节点：提交的第一时间用户反馈；节点由构造保证在视口内，不移动视口
  //（会话视图的打开由消费方按选中节点接管，spec 06「首次提交」）。
  store.projectSelectionContract({
    selectedNodeIds: [node.id],
    selectedAnnotationIds: [],
    editingAnnotationId: null,
    pendingAnnotationBinding: null,
  });

  console.debug('[agentProjection] agent node created', {
    agentSessionId: params.agentSessionId,
    nodeId: node.id,
    placementMode: placement.mode,
  });

  return node as GraphNode<AgentNodeData>;
};
