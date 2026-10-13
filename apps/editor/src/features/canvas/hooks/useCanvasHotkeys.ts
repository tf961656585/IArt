'use client';

/**
 * 监听画板级快捷键
 * - Ctrl/Cmd + S: 保存
 * - Ctrl/Cmd + C: 复制选中节点
 * - Ctrl/Cmd + V: 粘贴节点
 * - Ctrl/Cmd + A: 全选
 * - Ctrl/Cmd + Shift + L: 自动整理
 * - Alt + L/R/C/T/M/B: 对齐选中节点（左/右/水平居中/顶/垂直居中/底）
 * - Alt + H/V: 分布选中节点（水平/垂直）
 * - T（无修饰）: 切换右侧工作区时间线
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { buildProjectDelta, useCanvasStore } from '../store/canvasStore';
import { persistNodeChanges } from '../storage';
import type { NodeGraph } from '../types';
import { useCanvasSelectionBridge } from '../components/canvas/useCanvasSelectionBridge';
import type { AlignmentMode } from '../layout/alignment';
import { useRightWorkspaceStore } from '@/features/rightworkspace/rightWorkspaceStore';

export function useCanvasHotkeys() {
  const markAsSaved = useCanvasStore((state) => state.markAsSaved);
  const syncPersistenceState = useCanvasStore((state) => state.syncPersistenceState);
  const { selectEntireCanvas, selectNodes } = useCanvasSelectionBridge();

  // 使用 ref 持有最新状态，避免频繁解绑/重绑事件监听
  const latestGraphRef = useRef<NodeGraph | null>(useCanvasStore.getState().nodeGraph ?? null);
  const latestSelectedNodeIdsRef = useRef<string[]>(useCanvasStore.getState().selectedNodeIds);
  const savingRef = useRef(false);
  const layoutInProgressRef = useRef(false);

  useEffect(() => {
    const unsubGraph = useCanvasStore.subscribe(
      (state) => state.nodeGraph,
      (next: NodeGraph | null) => {
        latestGraphRef.current = next ?? null;
      }
    );
    const unsubSelected = useCanvasStore.subscribe(
      (state) => state.selectedNodeIds,
      (next: string[]) => {
        latestSelectedNodeIdsRef.current = next;
      }
    );

    return () => {
      unsubGraph();
      unsubSelected();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 右侧工作区打包区快捷键：无修饰 T，焦点不在编辑面时 toggle。
      // 注意与 Alt+T（顶对齐）区分：Alt+T 有 altKey，不在此分支命中。
      if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
        }
        event.preventDefault();
        useRightWorkspaceStore.getState().toggle('packageArea');
        return;
      }

      // Alt 系列对齐快捷键（无 Ctrl/Cmd）：单独处理，在通用守卫之前
      if (event.altKey && !(event.metaKey || event.ctrlKey)) {
        // 不拦截输入控件
        const target = event.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
        }

        const key = event.key.toLowerCase();
        const alignMap: Record<string, AlignmentMode> = {
          l: 'left',
          r: 'right',
          c: 'centerHorizontal',
          t: 'top',
          m: 'centerVertical',
          b: 'bottom',
          h: 'distributeHorizontal',
          v: 'distributeVertical',
        };
        const mode = alignMap[key];
        if (mode) {
          event.preventDefault();
          handleAlignSelection(mode);
          return;
        }
        // 其他 Alt 组合不拦截
        return;
      }

      if (!(event.metaKey || event.ctrlKey)) return;

      // 不拦截输入控件，避免影响文本输入体验
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }

      const key = event.key.toLowerCase();

      // Ctrl/Cmd + Shift + L: 自动整理
      if (key === 'l' && event.shiftKey && !event.altKey) {
        event.preventDefault();
        void handleAutoLayout();
        return;
      }

      // Ctrl/Cmd + S: 保存
      if (key === 's' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handleSave();
        return;
      }

      // Ctrl/Cmd + C: 复制
      if (key === 'c' && !event.shiftKey && !event.altKey) {
        const selection =
          typeof window !== 'undefined' && typeof window.getSelection === 'function'
            ? window.getSelection()
            : null;
        const selectedText =
          selection !== null && selection !== undefined ? selection.toString() : '';
        if (selection && !selection.isCollapsed && selectedText.trim().length > 0) {
          return;
        }
        event.preventDefault();
        handleCopy();
        return;
      }

      // Ctrl/Cmd + V: 粘贴
      if (key === 'v' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handlePaste();
        return;
      }

      // Ctrl/Cmd + A: 全选
      if (key === 'a' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handleSelectAll();
        return;
      }
    };

    const handleSave = () => {
      const snapshot = useCanvasStore.getState();
      const graph = snapshot.nodeGraph;

      if (!graph) {
        toast.info('画布还没准备好，暂时无法保存');
        return;
      }
      if (useCanvasStore.getState().isClosing) {
        return;
      }
      if (savingRef.current) {
        return;
      }

      const { delta, expectedDirtyRevision } = buildProjectDelta(snapshot, undefined);
      if (!delta) {
        toast.success('内容已是最新');
        return;
      }

      savingRef.current = true;
      persistNodeChanges(delta)
        .then((result) => {
          const persistenceState =
            result !== null && result !== undefined ? result.persistenceState ?? null : null;
          if (persistenceState !== null) {
            syncPersistenceState(persistenceState);
          }
          markAsSaved(expectedDirtyRevision);
          toast.success('已保存');
        })
        .catch(() => {
          toast.error('保存失败，请稍后重试');
        })
        .finally(() => {
          savingRef.current = false;
        });
    };

    const handleCopy = () => {
      const graph = latestGraphRef.current;
      const selectedNodeIds = latestSelectedNodeIdsRef.current;

      if (!graph) {
        toast.info('画布还没准备好');
        return;
      }
      if (selectedNodeIds.length === 0) {
        toast.info('请先选择要复制的节点');
        return;
      }

      useCanvasStore.getState().copySelectedNodes();
      toast.success(`已复制 ${selectedNodeIds.length} 个节点`);
    };

    const handlePaste = () => {
      const graph = latestGraphRef.current;

      if (!graph) {
        toast.info('画布还没准备好');
        return;
      }

      const hasContent = useCanvasStore.getState().hasClipboardContent();
      if (!hasContent) {
        toast.info('剪贴板为空');
        return;
      }

      // 粘贴到默认位置（相对于原位置偏移）
      const pasted = useCanvasStore.getState().pasteNodes(undefined);
      if (pasted.nodeIds.length > 0) {
        selectNodes(pasted.nodeIds, 'hotkey-paste');
        toast.success(`已粘贴 ${pasted.nodeIds.length} 个节点`);
      }
    };

    const handleSelectAll = () => {
      const graph = latestGraphRef.current;

      if (!graph) {
        toast.info('画布还没准备好');
        return;
      }
      if (graph.nodes.length === 0) {
        toast.info('画布上还没有节点');
        return;
      }

      selectEntireCanvas('hotkey-select-all');
    };

    const handleAutoLayout = async () => {
      const graph = latestGraphRef.current;
      if (!graph || graph.nodes.length === 0) {
        toast.info('画布上还没有节点');
        return;
      }
      if (layoutInProgressRef.current) return;
      layoutInProgressRef.current = true;
      try {
        // 从 store 会话态缓存读 measured（与 autoLayoutContainer 兜底一致，不传 ref）
        const measured = useCanvasStore.getState().ui.lastMeasuredSizeByNodeId;
        const result = await useCanvasStore.getState().autoLayoutWithPreMeasure({
          measuredSizeByNodeId: measured,
          derivedSizeByNodeId: undefined,
        });
        if (!result) return;
        if (result.changedCount === 0) {
          toast.info('节点位置已经整齐，不用整理');
          return;
        }
        toast.success('整理完成', {
          description: `已调整 ${result.changedCount} 个节点`,
        });
      } finally {
        layoutInProgressRef.current = false;
      }
    };

    const handleAlignSelection = (mode: AlignmentMode) => {
      const graph = latestGraphRef.current;
      if (!graph) {
        toast.info('画布还没准备好');
        return;
      }
      const selectedNodeIds = latestSelectedNodeIdsRef.current;
      if (selectedNodeIds.length === 0) {
        toast.info('请先选中要操作的节点');
        return;
      }
      useCanvasStore.getState().alignSelection(mode);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [markAsSaved, selectEntireCanvas, selectNodes, syncPersistenceState]);
}

export default useCanvasHotkeys;
