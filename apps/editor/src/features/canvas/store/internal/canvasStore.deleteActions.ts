import type { NodeGraphActions } from './canvasStore.core';
import type { CanvasStoreSet, CanvasStoreGet } from './canvasStore.core';

export const createCanvasDeleteActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet
): Pick<NodeGraphActions, 'deleteSelectedElements'> => ({
  deleteSelectedElements: () => {
    const {
      selectedNodeIds,
      selectedAnnotationIds,
    } = get();

    if (
      selectedNodeIds.length === 0 &&
      selectedAnnotationIds.length === 0
    ) {
      return;
    }

    // Agent 删除必须经确认框（AG-CT-011 禁旁路）：选中集含 Agent 节点（含无成员的
    // 单节点形态 Agent）时转删除确认请求，本入口不直接删除。确认后由确认框宿主
    // （AgentDeleteConfirmHost）走 removeNodes 同一删除咽喉——键盘 Delete、工具栏
    // 删除、选中集右键删除等选中集级入口全部经此收口，不存在绕过确认的路径。
    const selectedGraph = get().nodeGraph;
    if (selectedGraph) {
      const hasAgentSelection = selectedNodeIds.some((id) => {
        const node = selectedGraph.nodes.find((n) => n.id === id);
        return node !== undefined && node.type === 'agent';
      });
      if (hasAgentSelection) {
        set((state) => {
          state.pendingAgentDeleteConfirmNodeIds = [...selectedNodeIds];
        });
        return;
      }
    }

    // 记录删除前的注释 ID 集合，用于后续计算级联删除后剩余需删除的元素
    const preSnapshot = get().nodeGraph;
    const preAnnotationIds = new Set(
      preSnapshot !== null && preSnapshot !== undefined && Array.isArray(preSnapshot.annotations)
        ? preSnapshot.annotations.map((a) => a.id)
        : []
    );

    // 开启批量模式，抑制各子 action 的 saveToHistory
    set((state) => {
      state.historyBatchActive = true;
    });

    // 1. 删除选中的节点（内部会级联删除关联边和绑定注释）
    if (selectedNodeIds.length > 0) {
      get().removeNodes(selectedNodeIds, undefined);
    }

    // 2. 计算剩余需删除的注释：selectedAnnotationIds 中未被上述操作级联删除的注释
    if (selectedAnnotationIds.length > 0) {
      const postSnapshot2 = get().nodeGraph;
      const currentAnnotationIds = new Set(
        postSnapshot2 !== null && postSnapshot2 !== undefined && Array.isArray(postSnapshot2.annotations)
          ? postSnapshot2.annotations.map((a) => a.id)
          : []
      );
      for (const annotationId of selectedAnnotationIds) {
        if (currentAnnotationIds.has(annotationId) && preAnnotationIds.has(annotationId)) {
          get().removeAnnotation(annotationId);
        }
      }
    }

    // 关闭批量模式，统一保存一次历史
    set((state) => {
      state.historyBatchActive = false;
    });
    get().saveToHistory();
  },
});
