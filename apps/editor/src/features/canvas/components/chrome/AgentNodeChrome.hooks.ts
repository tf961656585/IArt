'use client';

import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import { useCanvasStore } from '../../store/canvasStore';
import { enterAgentFormForNode, usePromptDockStore } from '@/features/promptdock/promptDockStore';
import {
  agentSessionIdOf,
  resolveAgentChromeSelection,
} from './agentChromeModel';
import { getGroupMembers } from '../../services/groupMembership';
import type { AgentChromeState } from './AgentNodeChrome.types';
import type { GraphNode } from '../../types/node';

/**
 * Agent 节点选中态工具栏状态层（spec docs/agent/02「选中态工具栏」「撤销重做与删除」；
 * 解散/删除双动作口径见 AG-CT-010 / AG-CT-011）。
 *
 * 三个动作全部落在既有锚点，不在画布侧实现会话/输入面逻辑：
 * - 使用 agent → PromptDock `enterAgentFormForNode`（切 agent 形态并绑定该会话）；
 * - 解散（仅容器形态）→ store `dissolveAgentContainer`（成员关系变更事务，纯可逆，
 *   不删节点、不触碰会话）；
 * - 删除 → 只写删除确认请求通道（`requestAgentDeleteConfirm`），确认后由
 *   AgentDeleteConfirmHost 走 removeNodes 同一删除咽喉（先在途终止再删除）——
 *   工具栏、右键菜单、键盘 Delete 三条删除入口同一确认通道，禁旁路。
 * 会话视图开合不设工具栏动作：随选中驱动进入打开（spec 06），收起走面板关闭钮与 Esc。
 */

/** 选中集 → toolbar 状态（仅全部为 Agent 节点时 active）。 */
export function useAgentChromeState(): AgentChromeState {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodeGraph = useCanvasStore((s) => s.nodeGraph);

  const nodesById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of nodeGraph?.nodes ?? []) map.set(node.id, node);
    return map;
  }, [nodeGraph]);

  const selection = useMemo(
    () => resolveAgentChromeSelection(selectedNodeIds, nodesById),
    [selectedNodeIds, nodesById],
  );

  const single = selection.single;
  const agentSessionId = single ? agentSessionIdOf(single) : null;
  const singleNodeId = single === null ? null : single.id;

  // 「使用 agent」在已处于该会话时为幂等操作（spec 02「选中态工具栏」）：
  // 读 PromptDock 的形态与绑定事实源，按钮据此置为已用态，不给用户一个点了没反应的按钮。
  const alreadyInSession = usePromptDockStore(
    useCallback(
      (state) =>
        singleNodeId !== null &&
        agentSessionId !== null &&
        state.form === 'agent' &&
        state.agentBinding !== null &&
        state.agentBinding.nodeId === singleNodeId &&
        state.agentBinding.agentSessionId === agentSessionId,
      [agentSessionId, singleNodeId],
    ),
  );

  // 「解散」可用性（AG-CT-010）：仅容器形态（有成员）的 Agent 节点可解散；
  // 无成员已呈单节点形态、无组织关系可解除，不出现该项（与右键菜单同一门）。
  const dissolvableNodeIds = useMemo(() => {
    if (nodeGraph === null || nodeGraph === undefined) return [];
    const dissolvable: string[] = [];
    for (const node of selection.agentNodes) {
      if (getGroupMembers(nodeGraph, node.id).length > 0) {
        dissolvable.push(node.id);
      }
    }
    return dissolvable;
  }, [nodeGraph, selection.agentNodes]);

  return { selection, single, agentSessionId, alreadyInSession, dissolvableNodeIds };
}

export type AgentChromeActions = ReturnType<typeof useAgentChromeActions>;

/**
 * 工具栏动作：使用 agent / 解散 / 删除（确认框）。
 *
 * 解散是成员关系变更事务（不删节点、不触碰会话），多选时合批为一条历史；
 * 删除不直接执行：只把待删集合写入确认请求通道，确认后由 AgentDeleteConfirmHost
 * 串行 await 终止在途（每个节点取消完成后才执行删除）再走 removeNodes。
 */
export function useAgentChromeActions() {
  /**
   * 使用 agent：进入该节点的会话（切 agent 形态 + 绑定），不弹 draft 去向确认
   *（2026-09-20 裁撤：draft 按形态独立保存，进入不覆盖生成式草稿）。
   * 节点无会话引用时留痕跳过；已处于该会话时 store 幂等早返回（按钮本身按已用态呈现）。
   */
  const useAgent = useCallback((nodeId: string, agentSessionId: string | null) => {
    if (agentSessionId === null) {
      console.debug('[agentChrome] use-agent skipped: node has no session ref', { nodeId });
      return;
    }
    enterAgentFormForNode(nodeId, agentSessionId);
  }, []);

  // 删除：只开确认请求（确认框宿主消费）。删除入口（工具栏按钮 / 键盘 Delete）统一至此，
  // 不存在不经确认的删除路径。
  const requestDelete = useCallback((nodeIds: readonly string[]) => {
    if (nodeIds.length === 0) {
      console.debug('[agentChrome] delete-confirm skipped: empty selection');
      return;
    }
    useCanvasStore.getState().requestAgentDeleteConfirm([...nodeIds]);
  }, []);

  const cancelDelete = useCallback(() => {
    useCanvasStore.getState().clearAgentDeleteConfirmRequest();
  }, []);

  // 解散：逐容器解除成员关系（无成员容器由 store 动作 debug 留痕跳过）；
  // 多选合批为一条成员关系历史（historyBatchActive 既有合批模式），成功反馈用钉死文案。
  const dissolve = useCallback(
    (nodeIds: readonly string[]) => {
      const ids = [...nodeIds];
      if (ids.length === 0) return;
      const store = useCanvasStore.getState();
      useCanvasStore.setState((state) => {
        state.historyBatchActive = true;
      });
      let dissolvedCount = 0;
      for (const id of ids) {
        if (store.dissolveAgentContainer(id)) dissolvedCount += 1;
      }
      useCanvasStore.setState((state) => {
        state.historyBatchActive = false;
      });
      useCanvasStore.getState().saveToHistory();
      if (dissolvedCount === 0) {
        console.debug('[agentChrome] dissolve skipped: no dissolvable agent container', {
          nodeIds: ids,
        });
        return;
      }
      toast.success('容器已解散，Agent 和生成内容都保留');
    },
    [],
  );

  return {
    useAgent,
    requestDelete,
    cancelDelete,
    dissolve,
  };
}
