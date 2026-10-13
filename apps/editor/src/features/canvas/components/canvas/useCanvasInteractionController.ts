'use client';

import { useCallback, type Dispatch, type MouseEvent, type RefObject, type SetStateAction } from 'react';
import type { Node } from '@xyflow/react';
import { toast } from 'sonner';
import {
  beginCanvasSelectionTrace,
  logCanvasDebugEvent,
} from '../../debug/canvasDebug';
import { useCanvasStore } from '../../store/canvasStore';
import type { ContextMenuTarget } from '../../types';
import {
  resolveNodeContextMenuBehavior,
  resolvePaneOrSelectionContextMenuTarget,
} from '../../utils/contextMenuTarget';
import type { ContainerGapGeometry } from '../../utils/containerGapHitTest';
import { resolveContainerGapHit } from '../../utils/containerGapHitTest';
import { enterAgentFormFromSelection, resolveAgentEntryNodeId } from '@/features/promptdock/agentEntry';
import { CANVAS_CONTEXT_MENU_SURFACE_SELECTOR } from './canvasContextMenuDom';
import type { CanvasSelectionCommand } from './useCanvasSelectionBridge';

type UseCanvasInteractionControllerArgs = {
  contextMenuOpen: boolean;
  setContextMenu: Dispatch<SetStateAction<{
    open: boolean;
    target: ContextMenuTarget | null;
    screenPosition: { x: number; y: number };
  }>>;
  closeContextMenu: () => void;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  /**
   * 容器（组 | Agent 容器）几何列表（flow 坐标，来自容器派生尺寸投影）。
   * 供空白右键判定「点落在哪个容器的背板空隙内」；空列表即无容器，直接走 pane。
   */
  containerGeometries: readonly ContainerGapGeometry[];
  applySelectionCommand: (
    command: CanvasSelectionCommand,
    reason: string,
  ) => void;
  selectNodes: (nodeIds: string[], reason: string) => void;
  selectAnnotations: (annotationIds: string[], reason: string) => void;
  clearCanvasSelection: () => void;
  pendingPlacement: { characterId: string } | null;
  createCharacterImageNode: (position: { x: number; y: number }, characterId: string) => Promise<void>;
  completePlacement: () => void;
  pendingAnnotationBinding: { annotationId: string } | null;
  bindAnnotation: (
    annotationId: string,
    target: { type: 'node'; nodeId: string },
  ) => boolean;
  cancelAnnotationBinding: () => void;
  startMarquee: (startScreenX: number, startScreenY: number) => void;
  skipNextPaneClickRef: RefObject<boolean>;
  cancelMarquee: () => void;
};

export const useCanvasInteractionController = ({
  contextMenuOpen,
  setContextMenu,
  closeContextMenu,
  screenToFlowPosition,
  containerGeometries,
  applySelectionCommand,
  selectNodes,
  selectAnnotations,
  clearCanvasSelection,
  pendingPlacement,
  createCharacterImageNode,
  completePlacement,
  pendingAnnotationBinding,
  bindAnnotation,
  cancelAnnotationBinding,
  startMarquee,
  skipNextPaneClickRef,
  cancelMarquee,
}: UseCanvasInteractionControllerArgs) => {
  /**
   * 等待模式（角色放置 / 注释绑定）期间，画布交互归该模式所有：对象菜单与空白区菜单均不打开
   *（spec：画布对象右键菜单.md §6.1.6「等待模式豁免」/ CM-006）。
   *
   * 条件跳过必须留痕（AGENTS.md）：菜单不打开时留 debug 痕迹，避免排查时只能靠人工逐函数追踪。
   */
  const isWaitingModeActive = pendingPlacement !== null || pendingAnnotationBinding !== null;
  const skipContextMenuInWaitingMode = useCallback(
    (source: 'pane' | 'node' | 'annotation') => {
      if (!isWaitingModeActive) return false;
      console.debug('[canvasContextMenu] waiting mode active: context menu skipped', { source });
      return true;
    },
    [isWaitingModeActive],
  );

  const handlePlacementClick = useCallback(
    (event: { clientX: number; clientY: number }) => {
      if (!pendingPlacement) return false;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      position.x -= 120;
      position.y -= 80;
      void createCharacterImageNode(position, pendingPlacement.characterId);
      completePlacement();
      return true;
    },
    [completePlacement, createCharacterImageNode, pendingPlacement, screenToFlowPosition],
  );

  const onNodeClick = useCallback(
    (event: MouseEvent, node: Node) => {
      closeContextMenu();
      const traceMeta = beginCanvasSelectionTrace({
        origin: 'node-click',
        reason: event.ctrlKey || event.shiftKey || event.metaKey ? 'append-click' : 'replace-click',
      });
      logCanvasDebugEvent('nodeCanvas:onNodeClick', {
        ...traceMeta,
        traceScope: 'canvas-selection',
        action: 'node-click',
        nodeId: node.id,
        selectionReason: event.ctrlKey || event.shiftKey || event.metaKey ? 'append-click' : 'replace-click',
        storeSelection: {
          nodeIds: useCanvasStore.getState().selectedNodeIds,
          annotationIds: useCanvasStore.getState().selectedAnnotationIds,
        },
        disableThrottle: true,
      });

      if (handlePlacementClick(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (pendingAnnotationBinding) {
        event.preventDefault();
        event.stopPropagation();
        const ok = bindAnnotation(pendingAnnotationBinding.annotationId, { type: 'node', nodeId: node.id });
        if (ok) {
          selectAnnotations([pendingAnnotationBinding.annotationId], 'bind-annotation-node');
          toast.success('已绑定到节点');
        } else {
          toast.error('这个对象已经有注释了，一个对象只能加一条');
        }
        return;
      }

      const append = event.ctrlKey || event.shiftKey || event.metaKey;
      if (append) {
        const storeState = useCanvasStore.getState();
        const currentNodeIds = storeState.selectedNodeIds;
        const isSelected = currentNodeIds.includes(node.id);
        const nextNodeIds = isSelected
          ? currentNodeIds.filter((id) => id !== node.id)
          : [...currentNodeIds, node.id];
        applySelectionCommand(
          {
            kind: 'replace-selection',
            selection: {
              nodeIds: nextNodeIds,
              annotationIds: storeState.selectedAnnotationIds,
            },
          },
          'node-click-append',
        );
        return;
      }

      selectNodes([node.id], 'node-click');
      // 选中驱动进入（spec docs/agent/06「选中驱动的进入—还原—粘滞」）：普通单击
      //（非 Shift/Ctrl 追加、非框选、非拖拽——拖拽不触发 node click）选中持有会话引用的
      // Agent 节点时进入其会话。点击当前已绑定节点为幂等操作（store 内早返回）；
      // 无会话引用的节点在此跳过并留痕（agentEntry 内）。
      enterAgentFormFromSelection(node.id);
    },
    [
      applySelectionCommand,
      bindAnnotation,
      closeContextMenu,
      handlePlacementClick,
      pendingAnnotationBinding,
      selectAnnotations,
      selectNodes,
    ],
  );

  const onPaneClick = useCallback(
    (event: MouseEvent) => {
      if (skipNextPaneClickRef.current) {
        skipNextPaneClickRef.current = false;
        return;
      }

      closeContextMenu();
      const traceMeta = beginCanvasSelectionTrace({
        origin: 'pane-click',
        reason: 'clear-selection',
      });
      logCanvasDebugEvent('nodeCanvas:onPaneClick', {
        ...traceMeta,
        traceScope: 'canvas-selection',
        action: 'pane-click',
        selectionReason: 'clear-selection',
        storeSelection: {
          nodeIds: useCanvasStore.getState().selectedNodeIds,
          annotationIds: useCanvasStore.getState().selectedAnnotationIds,
        },
        disableThrottle: true,
      });

      if (handlePlacementClick(event)) {
        return;
      }

      if (pendingAnnotationBinding) {
        cancelAnnotationBinding();
        toast.info('已取消注释绑定');
        return;
      }

      const activeElement =
        typeof document === "undefined"
          ? null
          : (document.activeElement as HTMLElement | null);
      const isTextEditSession =
        activeElement !== null &&
        activeElement !== undefined &&
        activeElement.closest('[data-canvas-selection-edit-session="true"]') !== null;
      if (isTextEditSession) {
        return;
      }

      clearCanvasSelection();
    },
    [cancelAnnotationBinding, clearCanvasSelection, closeContextMenu, handlePlacementClick, pendingAnnotationBinding, skipNextPaneClickRef],
  );

  const openPaneOrSelectionContextMenuAt = useCallback(
    (clientX: number, clientY: number) => {
      if (skipContextMenuInWaitingMode('pane')) return;
      const flowPosition = screenToFlowPosition({ x: clientX, y: clientY });
      const currentSelectedIds = useCanvasStore.getState().selectedNodeIds;
      setContextMenu({
        open: true,
        target: resolvePaneOrSelectionContextMenuTarget({
          position: flowPosition,
          selectedNodeIds: currentSelectedIds,
          containerHit: resolveContainerGapHit(flowPosition, containerGeometries),
        }),
        screenPosition: { x: clientX, y: clientY },
      });
    },
    [screenToFlowPosition, containerGeometries, setContextMenu, skipContextMenuInWaitingMode],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | globalThis.MouseEvent) => {
      event.preventDefault();
      openPaneOrSelectionContextMenuAt(event.clientX, event.clientY);
    },
    [openPaneOrSelectionContextMenuAt],
  );

  const onCanvasContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;

      const target = event.target as HTMLElement | null;
      const targetClosest =
        target !== null && target !== undefined
          ? target.closest.bind(target)
          : null;
      if (
        targetClosest &&
        targetClosest('input, textarea, [contenteditable="true"], [role="textbox"]')
      ) {
        return;
      }

      event.preventDefault();
      openPaneOrSelectionContextMenuAt(event.clientX, event.clientY);
    },
    [openPaneOrSelectionContextMenuAt],
  );

  const onNodeContextMenu = useCallback(
    (event: MouseEvent, node: Node) => {
      if (skipContextMenuInWaitingMode('node')) return;
      event.preventDefault();

      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const behavior = resolveNodeContextMenuBehavior({
        nodeId: node.id,
        position: flowPosition,
        selectedNodeIds: useCanvasStore.getState().selectedNodeIds,
      });

      if (behavior.selectionUpdate.kind === 'select-multi') {
        selectNodes(behavior.selectionUpdate.nodeIds, 'node-context-menu');
      } else if (behavior.selectionUpdate.kind === 'select-single') {
        selectNodes([behavior.selectionUpdate.nodeId], 'node-context-menu');
      }

      setContextMenu({
        open: true,
        target: behavior.target,
        screenPosition: { x: event.clientX, y: event.clientY },
      });
    },
    [screenToFlowPosition, selectNodes, setContextMenu, skipContextMenuInWaitingMode],
  );

  const openAnnotationContextMenu = useCallback(
    (annotationId: string, clientX: number, clientY: number) => {
      if (skipContextMenuInWaitingMode('annotation')) return;
      const flowPosition = screenToFlowPosition({ x: clientX, y: clientY });
      setContextMenu({
        open: true,
        target: { type: 'annotation', annotationId, position: flowPosition },
        screenPosition: { x: clientX, y: clientY },
      });
    },
    [screenToFlowPosition, setContextMenu, skipContextMenuInWaitingMode],
  );

  const handleCanvasMouseDownCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // 框选启动条件：Shift 按下 + 左键 + 点击目标不是节点/边/注释/资产 chrome DOM
      if (event.shiftKey && event.button === 0) {
        const target = event.target as HTMLElement | null;
        if (target !== null && target !== undefined) {
          const isNodeOrEdge = target.closest('[data-id]') !== null;
          const isAnnotation = target.closest('[data-annotation-id]') !== null;
          // 主菜单与子菜单同属菜单面：在任一面内按下都不启动框选
          const isContextMenu = target.closest(CANVAS_CONTEXT_MENU_SURFACE_SELECTOR) !== null;
          const isAssetChrome = target.closest('[data-asset-node-chrome]') !== null;
          if (!isNodeOrEdge && !isAnnotation && !isContextMenu && !isAssetChrome) {
            event.stopPropagation(); // 阻止 ReactFlow 平移
            startMarquee(event.clientX, event.clientY);
            return;
          }
        }
      }

      if (event.button !== 0 || !contextMenuOpen) return;

      const target = event.target as HTMLElement | null;
      const targetClosest =
        target !== null && target !== undefined
          ? target.closest.bind(target)
          : null;
      // 子菜单面板 portal 到 body，但仍是本组件的 React 子树，其 mousedown 会走到这里；
      // 只认主菜单会让子菜单内的点击被判成"点击菜单外"，在 mousedown 阶段就关掉菜单。
      if (targetClosest && targetClosest(CANVAS_CONTEXT_MENU_SURFACE_SELECTOR)) {
        return;
      }

      closeContextMenu();
      cancelMarquee();
    },
    [cancelMarquee, closeContextMenu, contextMenuOpen, startMarquee],
  );

  /**
   * 节点键盘等价（spec docs/agent/02「选中态工具栏·键盘等价」/ 06「键盘与焦点」）。
   *
   * Tab 聚焦由 React Flow 的节点容器承担（`.react-flow__node` 是 Tab 停靠点），
   * 键盘事件从它冒泡到画布根，本处理函数按 DOM 上的节点容器定位节点 id 再从 store 取
   * 事实（不使用渲染副本）。Enter 等价普通单击：选中该节点 + 选中驱动进入其会话。
   * Esc 不在此处——它是「退一层」（还原快照 / 清除选择），归画布键盘链。
   *
   * 以原生键盘事件为形参：调用点把它挂在画布根的原生监听上（React Flow 自己的节点容器
   * DOM 不由本组件渲染，画布根这一层才拿得到它的冒泡事件）。
   */
  const onCanvasKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const wrapper = target.closest('.react-flow__node[data-id]');
      if (wrapper === null) return;
      const nodeId = wrapper.getAttribute('data-id');
      if (nodeId === null || nodeId.length === 0) return;
      // 与普通单击同一适用范围：Agent 容器自身或其成员（spec 06「选中驱动的进入—还原—粘滞」）。
      // 判定与单击共用 agentEntry 的同一入口，不在键盘链里另写一份。
      if (resolveAgentEntryNodeId(nodeId) === null) return;
      event.preventDefault();
      selectNodes([nodeId], 'node-keyboard-enter');
      logCanvasDebugEvent('nodeCanvas:onCanvasKeyDown', {
        traceScope: 'canvas-selection',
        action: 'node-enter-key',
        nodeId,
        selectionReason: 'node-keyboard-enter',
        disableThrottle: true,
      });
      enterAgentFormFromSelection(nodeId);
    },
    [selectNodes],
  );

  return {
    onNodeClick,
    onPaneClick,
    onPaneContextMenu,
    onCanvasContextMenu,
    onNodeContextMenu,
    onCanvasKeyDown,
    openAnnotationContextMenu,
    handleCanvasMouseDownCapture,
  };
};
