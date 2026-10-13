'use client';

import { useEffect } from 'react';

import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { agentSessionIdOf } from '@/features/canvas/components/chrome/agentChromeModel';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { GraphNode } from '@/features/canvas/types';
import { openAgentSessionView } from '@/features/rightworkspace/rightWorkspaceStore';
import { enterAgentFormForSelection, usePromptDockStore } from './promptDockStore';

/**
 * 选中驱动的进入与还原（spec docs/agent/06「形态切换入口·选中驱动的进入—还原—粘滞」）。
 *
 * 判定粒度是 **Agent 容器作用域**（Agent 节点自身 ∪ 其成员节点）而非单个节点：
 * 点容器里的素材与点容器头同效——都视为选中这个 agent（`docs/agent/Agent容器作用域选择-design.md`）。
 *
 * 分层：本模块是画布选择事实源（canvasStore）与 PromptDock 形态/绑定（promptDockStore）
 * 之间的唯一桥——画布点击/键盘只调 `enterAgentFormFromSelection`，还原观察者由画布挂载
 * `usePromptDockAgentEntryRestore`。进入与还原的判定规则全部落在 promptDockStore，
 * 本模块只负责「从画布侧取事实、按事实调用」。进入的同一动作把该会话的会话视图带到
 * 右侧工作区（选中驱动打开，spec 06「历史承载与会话视图」）。
 */

/**
 * 节点所属的 Agent 容器作用域锚点：节点自身是 Agent 节点时取自身；
 * 否则取它所属的容器（`groupId` 指向的节点）且该容器是 Agent 节点时取该容器。
 *
 * 返回 null = 不在任何 Agent 容器作用域内：自由节点、普通组（节点组）的成员、
 * 组节点自身、指向不存在容器的悬空 `groupId`。成员关系是单层直属（Agent 容器
 * 不得成为 Agent 容器的成员），故不做递归。
 */
const resolveAgentScopeNode = (
  nodes: readonly GraphNode[],
  node: GraphNode,
): GraphNode | null => {
  if (node.type === 'agent') return node;
  const containerId = node.groupId;
  if (typeof containerId !== 'string' || containerId.length === 0) return null;
  const container = nodes.find((candidate) => candidate.id === containerId) ?? null;
  return container !== null && container.type === 'agent' ? container : null;
};

/**
 * 节点对应的 Agent 容器作用域锚点 id；不在任何 Agent 容器作用域内返回 null。
 *
 * 键盘等价入口在选中前用它判定 Enter 是否被消费（`useCanvasInteractionController`），
 * 与普通单击共用同一判定，不各写一份。
 */
export const resolveAgentEntryNodeId = (nodeId: string): string | null => {
  const nodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
  const node = nodes.find((candidate) => candidate.id === nodeId) ?? null;
  if (node === null) return null;
  return resolveAgentScopeNode(nodes, node)?.id ?? null;
};

export function enterAgentFormFromSelection(nodeId: string): boolean {
  const nodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
  const node = nodes.find((candidate) => candidate.id === nodeId) ?? null;
  if (node === null) {
    console.debug('[promptDock] selection entry skipped: node not found', { nodeId });
    return false;
  }
  const agentNode = resolveAgentScopeNode(nodes, node);
  if (agentNode === null) {
    // 画布上绝大多数节点（自由节点、普通组成员）走这里：不是跳过异常，只是选中驱动的适用范围。
    console.debug('[promptDock] selection entry skipped: node is not in an agent container scope', {
      nodeId,
      nodeType: node.type,
      groupId: node.groupId ?? null,
    });
    return false;
  }
  const agentSessionId = agentSessionIdOf(agentNode);
  if (agentSessionId === null) {
    console.debug('[promptDock] selection entry skipped: agent node has no session ref', {
      nodeId: agentNode.id,
    });
    return false;
  }
  // 会话记录缺失（Bundle 导入的画布、会话已级联删除、撤销恢复）不进入：
  // 不重建已删除会话，也不把用户带到一个空会话里（spec 06「无会话节点」「空态与无会话状态」）。
  const session = useAgentSessionStore.getState().sessionsById[agentSessionId];
  if (session === undefined) {
    console.debug('[promptDock] selection entry skipped: agent session is gone', {
      nodeId: agentNode.id,
      agentSessionId,
    });
    return false;
  }
  // 绑定与待还原快照的锚点恒为该 Agent 容器节点（由成员点击进入也绑容器，不绑成员）。
  const entered = enterAgentFormForSelection(agentNode.id, agentSessionId);
  // 选中驱动打开会话视图（spec 06「历史承载与会话视图」）：进入的同一动作把该会话视图
  // 带到右侧工作区——已展示该会话时幂等（store 内早返回），手动关闭后重击即重开，
  // 展示其他会话时互斥切换。上面的跳过分支已带走了无会话/会话缺失的节点。
  if (entered) {
    openAgentSessionView(agentSessionId);
  }
  return entered;
}

/**
 * 选中集是否仍停在该 Agent 容器作用域内（容器自身 ∪ 其成员节点）。
 *
 * 判据取「非空且全部落在作用域内」：多选同容器成员（Shift 追加、多选若干产物）算停住；
 * 点空白、选中作用域外对象、选择集以任何方式跨出作用域都算离开——
 * spec 06「选中集离开该 Agent 容器作用域即恢复快照」。
 */
const isSelectionHeldByEntryScope = (
  nodes: readonly GraphNode[],
  selectedNodeIds: readonly string[],
  entryNodeId: string,
): boolean => {
  if (selectedNodeIds.length === 0) return false;
  for (const id of selectedNodeIds) {
    if (id === entryNodeId) continue;
    const node = nodes.find((candidate) => candidate.id === id) ?? null;
    if (node === null || node.groupId !== entryNodeId) return false;
  }
  return true;
};

/**
 * 选择集变化 → 还原（未粘滞时）。返回是否发生了还原（供键盘链判定是否已消费 Esc）。
 */
export function restoreAgentEntryIfSelectionLeft(selectedNodeIds: readonly string[]): boolean {
  const snapshot = usePromptDockStore.getState().agentEntrySnapshot;
  if (snapshot === null) return false;
  const nodes = useCanvasStore.getState().nodeGraph?.nodes ?? [];
  if (isSelectionHeldByEntryScope(nodes, selectedNodeIds, snapshot.nodeId)) return false;
  return usePromptDockStore.getState().restoreAgentEntrySnapshot('selection-left');
}

/**
 * 画布侧挂载的还原观察者（NodeCanvas）。
 *
 * 订阅画布选择事实源：选择集以任何方式变化（点击、框选、全选、右键选、Esc 清空、
 * 撤销恢复……）都会走到这里，判定统一由 `restoreAgentEntryIfSelectionLeft` 承担，
 * 不为每条选择路径各写一份还原。
 */
export function usePromptDockAgentEntryRestore(): void {
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  useEffect(() => {
    restoreAgentEntryIfSelectionLeft(selectedNodeIds);
  }, [selectedNodeIds]);
}

/**
 * Esc 退一层（spec 06「键盘与焦点」）：存在待还原快照时还原快照，否则由调用方按
 * 既有画布 Esc 行为处置（清除选择、焦点回画布）。返回是否消费了本次 Esc。
 */
export function restoreAgentEntryOnEscape(): boolean {
  const snapshot = usePromptDockStore.getState().agentEntrySnapshot;
  if (snapshot === null) return false;
  return usePromptDockStore.getState().restoreAgentEntrySnapshot('escape');
}
