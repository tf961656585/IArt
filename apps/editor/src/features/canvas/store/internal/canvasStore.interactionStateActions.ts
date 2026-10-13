import type { CanvasStoreGet, CanvasStoreSet, NodeGraphActions } from './canvasStore.core';

export const createCanvasInteractionStateActions = (
  set: CanvasStoreSet,
  _get: CanvasStoreGet,
): Pick<
  NodeGraphActions,
  | 'setDragging'
  | 'setConnecting'
  | 'setCanvasInteracting'
  | 'setCanvasInteractingDelayed'
  | 'markNodeAsPlaceholder'
  | 'markNodesAsPlaceholder'
  | 'markNodesAsFull'
  | 'clearPlaceholderUpgrade'
  | 'requestNodeTextEdit'
  | 'clearNodeTextEditRequest'
  | 'requestGroupRename'
  | 'clearGroupRenameRequest'
  | 'requestAgentDeleteConfirm'
  | 'clearAgentDeleteConfirmRequest'
> => ({
  setDragging: (isDragging) => {
    set((state) => {
      state.isDragging = isDragging;
    });
  },

  setConnecting: (isConnecting) => {
    set((state) => {
      state.isConnecting = isConnecting;
    });
  },

  setCanvasInteracting: (isInteracting) => {
    set((state) => {
      state.isCanvasInteracting = isInteracting;
    });
  },

  setCanvasInteractingDelayed: (isInteracting) => {
    set((state) => {
      state.isCanvasInteractingDelayed = isInteracting;
    });
  },

  // 占位壳态生命周期（spec：画布交互期渲染降级契约.md「占位壳契约」）。
  // store 启用了 immer MapSet 插件（canvasStore.ts），Set 的 add/delete/clear
  // 会通过 immer 产生新引用，保证订阅者收到更新通知。
  markNodeAsPlaceholder: (nodeId) => {
    if (!nodeId) return;
    set((state) => {
      state.ui.placeholderNodeIds.add(nodeId);
    });
  },

  // 启动期占位壳契约（spec：画布启动性能与Layout-Model架构.md「ReactFlow 双挂载的消除」）。
  // loadNodeGraph 完成后批量把新加载节点预置为占位壳态，让 NodeCanvas 在 waiting-interactive
  // 阶段以轻量子树挂载，避免首帧全图完整子树挂载压满主线程导致 rAF 调度不到、readiness 卡死。
  markNodesAsPlaceholder: (nodeIds) => {
    if (nodeIds.length === 0) return;
    set((state) => {
      const ids = state.ui.placeholderNodeIds;
      for (let i = 0; i < nodeIds.length; i += 1) {
        const id = nodeIds[i];
        if (id !== undefined && id !== '') {
          ids.add(id);
        }
      }
    });
  },

  markNodesAsFull: (nodeIds) => {
    if (nodeIds.length === 0) return;
    set((state) => {
      const ids = state.ui.placeholderNodeIds;
      for (let i = 0; i < nodeIds.length; i += 1) {
        const id = nodeIds[i];
        if (id !== undefined) {
          ids.delete(id);
        }
      }
    });
  },

  clearPlaceholderUpgrade: () => {
    set((state) => {
      state.ui.placeholderNodeIds.clear();
    });
  },

  // 程序化建边交互的文本节点编辑请求（spec：程序化建边交互.md「资产落定即连接」）。
  // 一次性 request：QuickPromptInput 创建空文本节点后写入 nodeId，TextInputNode 挂载并
  // 满足编辑前置条件时消费并清空。flag 持续到被消费，免疫"节点未挂载"竞态。
  requestNodeTextEdit: (nodeId) => {
    set((state) => {
      state.pendingTextEditNodeId = nodeId;
    });
  },

  clearNodeTextEditRequest: () => {
    set((state) => {
      state.pendingTextEditNodeId = null;
    });
  },

  // 组名内联编辑请求（spec：画布对象右键菜单.md「重命名组」——焦点进入组名内联编辑）。
  // 一次性 request：右键菜单写入 nodeId，GroupNode 挂载/订阅到该 id 时消费并清空。
  requestGroupRename: (nodeId) => {
    set((state) => {
      state.pendingGroupRenameNodeId = nodeId;
    });
  },

  clearGroupRenameRequest: () => {
    set((state) => {
      state.pendingGroupRenameNodeId = null;
    });
  },

  // Agent 删除确认请求（AG-CT-011：删除 Agent 必须经确认框，禁旁路）。
  // 一次性 request：不经确认的删除入口（键盘 Delete、工具栏、菜单、选中集删除）命中
  // Agent 节点时写入待删集合，确认框宿主（AgentDeleteConfirmHost）消费：
  // 确认才走 removeNodes 删除咽喉，取消清空本请求且不产生任何删除。
  requestAgentDeleteConfirm: (nodeIds) => {
    if (nodeIds.length === 0) {
      console.debug('[canvas] agent delete confirm skipped: empty node id set');
      return;
    }
    set((state) => {
      state.pendingAgentDeleteConfirmNodeIds = [...nodeIds];
    });
  },

  clearAgentDeleteConfirmRequest: () => {
    set((state) => {
      state.pendingAgentDeleteConfirmNodeIds = null;
    });
  },
});
