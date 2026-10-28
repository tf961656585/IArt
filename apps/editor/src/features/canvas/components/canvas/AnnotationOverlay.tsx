'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore as useReactFlowStore } from '@xyflow/react';
import { useOverlayLayer } from '@iart/ui';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '../../store/canvasStore';
import type { CanvasAnnotation, NodePosition } from '../../types';
import { resolveAnnotationPosition } from '../../utils/annotationLayout';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import { useCanvasSelectionBridge } from './useCanvasSelectionBridge';

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const safeZoom = (value: unknown): number => {
  const zoom = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return clampNumber(zoom, 0.1, 8);
};

const parseHexColor = (input: string): { r: number; g: number; b: number } | null => {
  if (!input || typeof input !== 'string') return null;
  const hex = input.trim().replace('#', '');
  if (hex.length === 3) {
    const r = Number.parseInt(hex.charAt(0) + hex.charAt(0), 16);
    const g = Number.parseInt(hex.charAt(1) + hex.charAt(1), 16);
    const b = Number.parseInt(hex.charAt(2) + hex.charAt(2), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }
  if (hex.length === 6) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }
  return null;
};

const hexToRgba = (hex: string, alpha: number): string => {
  const rgb = parseHexColor(hex);
  if (!rgb) return `rgba(0,0,0,${alpha})`;
  const a = clampNumber(alpha, 0, 1);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
};

type AnnotationOverlayProps = {
  onOpenContextMenu: (annotationId: string, clientX: number, clientY: number) => void;
};

export function AnnotationOverlay({ onOpenContextMenu }: AnnotationOverlayProps) {
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const selectedIds = useCanvasStore((state) => state.selectedAnnotationIds);
  const editingId = useCanvasStore((state) => state.editingAnnotationId);
  const setEditingAnnotation = useCanvasStore((state) => state.setEditingAnnotation);
  const updateAnnotationContent = useCanvasStore((state) => state.updateAnnotationContent);
  const updateAnnotationPosition = useCanvasStore((state) => state.updateAnnotationPosition);
  const updateAnnotationSize = useCanvasStore((state) => state.updateAnnotationSize);
  const { selectAnnotations } = useCanvasSelectionBridge();

  const transform = useReactFlowStore((state) => state.transform);

  const zoom = safeZoom((transform !== null && transform !== undefined ? transform[2] : undefined));

  // 辅助几何消费者·measured 可得（spec：画布注释.md「绑定契约」+ 画布节点尺寸管理架构.md）：
  // 绑定注释的派生位置读取被绑对象尺寸时，必须经统一尺寸解析入口 resolveEffectiveSize。
  // measured（lastMeasuredSizeByNodeId）是会话态 DOM 实测缓存，是 resolveEffectiveSize 主优先级；
  // desired / layoutModel 作为补充，覆盖节点未挂载/刚加载的场景。
  const measuredSizeByNodeId = useCanvasStore(
    (state) => state.ui.lastMeasuredSizeByNodeId,
  );
  const desiredSizeByNodeId = useCanvasStore(
    (state) => state.ui.desiredSizeByNodeId,
  );
  const layoutModelByNodeId = useCanvasStore(
    (state) => state.ui.layoutModelByNodeId,
  );

  const resolved = useMemo(() => {
    const annotations = (nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.annotations : undefined) ?? [];
    const nodes = (nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.nodes : undefined) ?? [];
    const sizeSources: EffectiveSizeSources = {
      // 测量缓存（DOM 实测）：注释跟随主优先级
      measuredByNodeId: measuredSizeByNodeId ?? undefined,
      // 测量缺失时回落到 desired（用户/producer 业务意图尺寸）
      desiredByNodeId: desiredSizeByNodeId ?? undefined,
      derivedByNodeId: undefined,
      defaultByNodeId: undefined,
      // 节点未挂载时回落到 Layout Model（启动期与未挂载节点稳定尺寸）
      layoutModelByNodeId: layoutModelByNodeId ?? undefined,
    };
    return annotations.map((ann) => ({
      ann,
      position: resolveAnnotationPosition(ann, { nodes, sizeSources }),
    }));
  }, [nodeGraph, measuredSizeByNodeId, desiredSizeByNodeId, layoutModelByNodeId]);

  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement | null>());
  const textareaRefCallbacks = useRef(new Map<string, (el: HTMLTextAreaElement | null) => void>());
  const setTextareaRef = useCallback((id: string) => {
    const cached = textareaRefCallbacks.current.get(id);
    if (cached) {
      return cached;
    }
    const callback = (el: HTMLTextAreaElement | null) => {
      textareaRefs.current.set(id, el);
    };
    textareaRefCallbacks.current.set(id, callback);
    return callback;
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const el = textareaRefs.current.get(editingId);
    if (!el) return;
    // 延迟一帧确保元素已挂载并可聚焦
    requestAnimationFrame(() => {
      el.focus();
      try {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      } catch {
        // ignore
      }
    });
  }, [editingId]);

  const dragStateRef = useRef<{
    annotationId: string;
    startClient: { x: number; y: number };
    startPosition: NodePosition;
    moved: boolean;
    /**
     * 多选拖拽快照：当 startDrag 时被拖注释已在多选集合中（且集合含多条自由注释），
     * 这里保存该集合中所有自由注释的 id 与起始位置，pointermove 时整体应用位移。
     * 单选场景此字段为 undefined，沿用单注释路径。
     */
    multiDragTargets: Array<{ id: string; startPosition: NodePosition }> | undefined;
  } | null>(null);

  const resizeStateRef = useRef<{
    annotationId: string;
    startClient: { x: number; y: number };
    startSize: { width: number; height: number };
    moved: boolean;
  } | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const currentZoom = zoomRef.current;

    const drag = dragStateRef.current;
    if (drag) {
      event.preventDefault();
      const dx = (event.clientX - drag.startClient.x) / currentZoom;
      const dy = (event.clientY - drag.startClient.y) / currentZoom;
      drag.moved = drag.moved || dx !== 0 || dy !== 0;
      // 多选拖拽：对所有选中的自由注释应用相同位移
      const targets = drag.multiDragTargets;
      if (targets !== undefined && targets.length > 0) {
        for (const target of targets) {
          updateAnnotationPosition(target.id, {
            x: target.startPosition.x + dx,
            y: target.startPosition.y + dy,
          });
        }
        return;
      }
      // 单选拖拽
      const next = { x: drag.startPosition.x + dx, y: drag.startPosition.y + dy };
      updateAnnotationPosition(drag.annotationId, next);
      return;
    }

    const resize = resizeStateRef.current;
    if (resize) {
      event.preventDefault();
      const dx = (event.clientX - resize.startClient.x) / currentZoom;
      const dy = (event.clientY - resize.startClient.y) / currentZoom;
      resize.moved = resize.moved || dx !== 0 || dy !== 0;
      updateAnnotationSize(resize.annotationId, {
        width: resize.startSize.width + dx,
        height: resize.startSize.height + dy,
      });
    }
  }, [updateAnnotationPosition, updateAnnotationSize]);

  const handlePointerUpRef = useRef<() => void>(() => {});

  const stopAllPointerOps = useCallback(() => {
    dragStateRef.current = null;
    resizeStateRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUpRef.current);
    window.removeEventListener('pointercancel', handlePointerUpRef.current);
  }, [handlePointerMove]);

  const handlePointerUp = useCallback(() => {
    const didMove = Boolean((dragStateRef.current !== null && dragStateRef.current !== undefined ? dragStateRef.current.moved : undefined) || (resizeStateRef.current !== null && resizeStateRef.current !== undefined ? resizeStateRef.current.moved : undefined));
    stopAllPointerOps();
    if (didMove) {
      useCanvasStore.getState().saveToHistory();
    }
  }, [stopAllPointerOps]);

  useEffect(() => {
    handlePointerUpRef.current = handlePointerUp;
  }, [handlePointerUp]);

  useEffect(() => {
    return () => {
      stopAllPointerOps();
    };
  }, [stopAllPointerOps]);

  const applyAnnotationSelection = useCallback((annotationId: string, append: boolean, reason: string) => {
    if (!append) {
      selectAnnotations([annotationId], reason);
      return;
    }
    const nextSelectedIds = selectedIds.includes(annotationId)
      ? selectedIds
      : [...selectedIds, annotationId];
    selectAnnotations(nextSelectedIds, reason);
  }, [selectAnnotations, selectedIds]);

  const startDrag = useCallback((annotation: CanvasAnnotation, position: NodePosition, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (editingId === annotation.id) return;
    if ((annotation.binding !== null && annotation.binding !== undefined ? annotation.binding.type : undefined) !== 'free') {
      // 绑定注释不可拖拽：派生位置由被绑对象决定。给出明确反馈避免用户以为功能坏了
      toast.info('绑定注释随对象移动，解绑后才能拖动');
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target !== null && target !== undefined && target.closest('[data-annotation-resize-handle]')) return;
    if (target !== null && target !== undefined && target.closest('textarea')) return;

    // 多选拖拽：被拖注释已在选中集合且集合有 >1 条自由注释时，保留选区并整体移动
    // 否则按"点选即单选"语义塌缩为单选
    const isAlreadySelected = selectedIds.includes(annotation.id);
    const allAnnotations = useCanvasStore.getState().nodeGraph?.annotations ?? [];
    const selectedFreeAnnotations = isAlreadySelected
      ? allAnnotations.filter(
          (ann) =>
            selectedIds.includes(ann.id) &&
            ann.binding?.type === 'free',
        )
      : [];
    const isMultiDrag = selectedFreeAnnotations.length > 1;

    if (!isAlreadySelected || !isMultiDrag) {
      selectAnnotations([annotation.id], 'annotation-drag-start');
    }
    // 多选场景：保留选区，不重新 select

    dragStateRef.current = {
      annotationId: annotation.id,
      startClient: { x: event.clientX, y: event.clientY },
      startPosition: position,
      moved: false,
      multiDragTargets: isMultiDrag
        ? selectedFreeAnnotations.map((ann) => ({
            id: ann.id,
            startPosition: { x: ann.position.x, y: ann.position.y },
          }))
        : undefined,
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  }, [editingId, handlePointerMove, handlePointerUp, selectAnnotations, selectedIds]);

  const startResize = useCallback((annotation: CanvasAnnotation, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectAnnotations([annotation.id], 'annotation-resize-start');

    resizeStateRef.current = {
      annotationId: annotation.id,
      startClient: { x: event.clientX, y: event.clientY },
      startSize: {
        width: annotation.size.width,
        height: annotation.size.height,
      },
      moved: false,
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  }, [handlePointerMove, handlePointerUp, selectAnnotations]);

  const handleDoubleClick = useCallback((annotationId: string) => {
    setEditingAnnotation(annotationId);
  }, [setEditingAnnotation]);

  const handleExitEdit = useCallback((annotationId: string) => {
    const current = useCanvasStore.getState().editingAnnotationId;
    if (current !== annotationId) return;
    useCanvasStore.getState().setEditingAnnotation(null);
    useCanvasStore.getState().saveToHistory();
  }, []);

  // 注释编辑态是独立浮层（spec docs/editor/浮层堆栈管理.md 核心规则 6）：编辑激活即入栈，
  // Esc 先退编辑态、再按才轮到宿主（画布基底）。替代原先 textarea 上的元素级 Esc 处理 +
  // stopPropagation 抢占；退出动作与 `handleExitEdit(editingId)` 完全同一路径。
  // `active` 与实际可见性同口径（被编辑的注释仍在本帧渲染集合内），注释消失/图层未渲染时不占栈位。
  const editingAnnotationVisible =
    editingId !== null && resolved.some(({ ann }) => ann.id === editingId);
  useOverlayLayer({
    active: editingAnnotationVisible,
    id: 'annotation-edit',
    onClose: () => {
      if (editingId !== null) handleExitEdit(editingId);
    },
  });

  if (!nodeGraph || resolved.length === 0) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-canvas-overlay pointer-events-none">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {resolved.map(({ ann, position }) => {
          const selected = selectedIds.includes(ann.id);
          const editing = editingId === ann.id;
          const hovered = hoveredId === ann.id;
          const color = (ann.style !== null && ann.style !== undefined ? ann.style.color : undefined) ?? '#fef3c7';
          const fontSize = (ann.style !== null && ann.style !== undefined ? ann.style.fontSize : undefined) ?? 14;

          return (
            <div
              key={ann.id}
              data-annotation-id={ann.id}
              role="button"
              tabIndex={0}
              className={cn(
                'pointer-events-auto absolute',
                'rounded-md',
                'border',
                'shadow-sm',
                'transition-opacity',
                // 未选中态可见性：白画布上空注释清晰可辨（spec：画布注释.md）
                selected || editing ? 'opacity-100' : 'opacity-90',
                'hover:opacity-100'
              )}
              style={{
                left: position.x,
                top: position.y,
                width: ann.size.width,
                height: ann.size.height,
                // 背景透明度提高到 0.35（未选中）/ 0.5（选中/hover/editing）
                backgroundColor: hexToRgba(color, selected || hovered || editing ? 0.5 : 0.35),
                // 边框对比度提升：未选中 0.55，选中 0.9
                borderColor: selected ? hexToRgba(color, 0.9) : hexToRgba(color, 0.55),
              }}
              onMouseEnter={() => setHoveredId(ann.id)}
              onMouseLeave={() => setHoveredId((prev) => (prev === ann.id ? null : prev))}
              onClick={(e) => {
                e.stopPropagation();
                applyAnnotationSelection(
                  ann.id,
                  e.ctrlKey || e.shiftKey || e.metaKey,
                  'annotation-click',
                );
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                applyAnnotationSelection(
                  ann.id,
                  e.ctrlKey || e.shiftKey || e.metaKey,
                  'annotation-keydown',
                );
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                handleDoubleClick(ann.id);
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                startDrag(ann, position, e);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                selectAnnotations([ann.id], 'annotation-context-menu');
                onOpenContextMenu(ann.id, e.clientX, e.clientY);
              }}
            >
              <div className="w-full h-full p-2">
                {editing ? (
                  <textarea
                    ref={setTextareaRef(ann.id)}
                    value={ann.content}
                    onChange={(e) => updateAnnotationContent(ann.id, e.target.value)}
                    className={cn(
                      'w-full h-full resize-none bg-transparent',
                      'outline-none text-sm leading-5',
                      'placeholder:text-muted-foreground'
                    )}
                    style={{
                      fontSize,
                      color: '#111827',
                    }}
                    placeholder="输入注释内容…"
                    onBlur={() => handleExitEdit(ann.id)}
                  />
                ) : (
                  <div
                    className={cn('w-full h-full select-none whitespace-pre-wrap text-sm leading-5')}
                    style={{
                      fontSize,
                      color: '#111827',
                    }}
                  >
                    {ann.content || (selected ? '双击编辑注释' : '')}
                  </div>
                )}
              </div>

              {/* Resize handle */}
              {(selected || editing) && (
                <div
                  data-annotation-resize-handle
                  className={cn(
                    'absolute right-1 bottom-1',
                    'h-3 w-3 rounded-sm',
                    'border bg-background/50',
                    'cursor-se-resize'
                  )}
                  style={{
                    borderColor: hexToRgba(color, 0.55),
                    backgroundColor: hexToRgba(color, 0.25),
                  }}
                  onPointerDown={(e) => startResize(ann, e)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AnnotationOverlay;
