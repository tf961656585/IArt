'use client';

import { toast } from 'sonner';

import { useCanvasStore } from '../../store/canvasStore';
import { cancelAgentSessionForNode } from '@/features/agent/agentSessionStore';
import { DeleteAgentConfirmDialog } from './DeleteAgentConfirmDialog';

/**
 * Agent 删除确认框宿主（AG-CT-011：删除 Agent 必须经确认框，禁旁路）。
 *
 * 挂于 NodeCanvas 根容器（与 AgentNodeChrome 同层），订阅画布 store 的删除确认请求
 * 通道（`pendingAgentDeleteConfirmNodeIds`）。右键菜单、选中态工具栏、键盘 Delete、
 * 选中集删除等入口命中 Agent 节点时都写入该通道，由本宿主弹出钉死文案确认框：
 * - 确认 → 先串行终止每个节点的在途会话（全部收口后才动图形），再走 removeNodes
 *   同一删除咽喉（级联物理删除会话、产物成员保留原位），成功 toast 钉死文案；
 * - 取消 / Esc → 清空请求，不产生任何删除与终止。
 */
export function AgentDeleteConfirmHost() {
  const request = useCanvasStore((s) => s.pendingAgentDeleteConfirmNodeIds);
  const clearRequest = useCanvasStore((s) => s.clearAgentDeleteConfirmRequest);

  const handleConfirm = async () => {
    if (request === null || request.length === 0) {
      clearRequest();
      return;
    }
    const nodeIds = [...request];
    clearRequest();
    // 先在途终止再删除：串行取消全部在途请求，全部收口后才动图形
    //（与既有 chrome 删除顺序一致；removeNodes 咽喉的 agent 前置钩子随后收口会话作废）。
    for (const nodeId of nodeIds) {
      await cancelAgentSessionForNode(nodeId);
    }
    useCanvasStore.getState().removeNodes(nodeIds, undefined);
    toast.success('Agent 已删除，生成的内容保留在画布');
  };

  return (
    <DeleteAgentConfirmDialog
      request={request}
      onConfirm={() => void handleConfirm()}
      onCancel={clearRequest}
    />
  );
}

export default AgentDeleteConfirmHost;
