import type { GraphNode, GraphNodeData } from '../../types/node';
import type { AgentNodeData } from '../../types/agentNode';

/**
 * Agent 节点选中态工具栏的纯模型（spec docs/agent/02-Agent节点与画布投影.md「选中态工具栏」）。
 *
 * 与 chromeModel.ts（资产节点）平级：本文不做工具分组——Agent 节点没有媒体加工工具，
 * 工具栏固定两动作（使用 agent / 解散），动作执行在 AgentNodeChrome.hooks.ts，
 * 渲染与定位在 AgentNodeChrome.tsx（定位复用 useChromePlacement）。
 */

export type AgentChromeSelection = {
  /** 选中的 Agent 节点（保持 selectedNodeIds 顺序） */
  agentNodes: GraphNode[];
  /** 是否呈现 toolbar：选中集非空且全部为 agent 节点 */
  active: boolean;
  multi: boolean;
  /** 单选时该 Agent 节点（多选为 null） */
  single: GraphNode | null;
};

/** 选中集 → toolbar 选择态：仅当全部选中对象都是 Agent 节点时呈现（与资产节点同一口径）。 */
export const resolveAgentChromeSelection = (
  selectedNodeIds: readonly string[],
  nodesById: ReadonlyMap<string, GraphNode>,
): AgentChromeSelection => {
  const agentNodes: GraphNode[] = [];
  let nonAgent = false;
  for (const id of selectedNodeIds) {
    const node = nodesById.get(id);
    if (!node) continue;
    if (node.type === 'agent') {
      agentNodes.push(node);
    } else {
      nonAgent = true;
    }
  }
  const active = agentNodes.length > 0 && !nonAgent;
  return {
    agentNodes: active ? agentNodes : [],
    active,
    multi: agentNodes.length > 1,
    single: agentNodes.length === 1 ? (agentNodes[0] ?? null) : null,
  };
};

/**
 * Agent 节点 data 收窄（`agentSessionId` 字段判别，不用断言）。
 * 非 agent 类型或 data 形状不含会话引用时返回 null。
 */
export const resolveAgentNodeData = (node: GraphNode): AgentNodeData | null => {
  if (node.type !== 'agent') return null;
  const data: GraphNodeData = node.data;
  if (!('agentSessionId' in data)) return null;
  return data;
};

/** 节点持有的会话稳定引用（缺失或空串 → null）。 */
export const agentSessionIdOf = (node: GraphNode): string | null => {
  const data = resolveAgentNodeData(node);
  if (data === null) return null;
  return data.agentSessionId.length > 0 ? data.agentSessionId : null;
};
