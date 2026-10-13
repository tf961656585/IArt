import { useCallback, useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as XyFlowNS from '@xyflow/react';
import { OverlayEscapeDispatcher, useOverlayLayer } from '@iart/ui';

import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '../../../store/canvasStore';
import { createNodeGraph, type NodeGraph } from '../../../types/nodeGraph';
import { AnnotationOverlay } from '../AnnotationOverlay';
import { useNodeCanvasKeyboardShortcuts } from '../useNodeCanvasKeyboardShortcuts';

/**
 * 浮层堆栈 × 画布基底的接缝测试
 *（spec docs/editor/浮层堆栈管理.md「验收」：OVL-003 栈空透传、OVL-005 编辑态先于宿主）。
 *
 * 接缝性质：真实分发器（`OverlayEscapeDispatcher`）+ 真实画布基底处理器
 * （`useNodeCanvasKeyboardShortcuts`，栈空时唯一合法的栈外 Esc 消费面）+ 真实画布 /
 * PromptDock store + 真实 `AnnotationOverlay` 编辑态。浮层宿主用最小替身（同一个
 * `useOverlayLayer` 注册路径），不是自建监听。
 *
 * 保护两件事实：
 * 1. 栈空时 Esc 落到画布基底语义（清选择、焦点回画布），浮层不受影响；
 *    栈非空时 Esc 只关栈顶，基底不触发。
 * 2. 编辑态（注释编辑会话）作为独立层先退出，宿主浮层保持；再按才退宿主。
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof XyFlowNS>('@xyflow/react');
  return {
    ...actual,
    useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
  };
});

vi.mock('../useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => ({
    selectAnnotations: vi.fn(),
    applySelectionCommand: vi.fn(),
    selectEntireCanvas: vi.fn(),
    selectNodes: vi.fn(),
  }),
}));

const ANNOTATION_ID = 'ann-1';
const NODE_ID = 'node-1';

const graphWithAnnotation = (): NodeGraph => {
  const graph = createNodeGraph({
    name: 'overlay stack seam',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  graph.id = 'graph-overlay-stack-seam';
  graph.nodes = [];
  graph.annotations = [
    {
      id: ANNOTATION_ID,
      content: '注释',
      position: { x: 24, y: 36 },
      size: { width: 180, height: 72 },
      binding: { type: 'free' },
      style: { color: '#fef3c7', fontSize: 14 },
    },
  ];
  return graph;
};

/** 画布基底：真实处理器 + 真实画布 store（栈空时 Esc 的落点）。 */
function CanvasBaseHarness() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const clearCanvasSelection = useCallback(() => {
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
  }, []);

  useNodeCanvasKeyboardShortcuts({
    pendingPlacement: null,
    cancelPlacement: () => undefined,
    pendingAnnotationBinding: null,
    cancelAnnotationBinding: () => undefined,
    cancelMarquee: null,
    clearCanvasSelection,
    canvasRef,
  });

  return <div ref={canvasRef} tabIndex={-1} data-testid="canvas-root" />;
}

/** 浮层替身：与业务浮层同一条注册路径（`useOverlayLayer`），无自建 Esc 监听。 */
function OverlayDouble({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  useOverlayLayer({
    active: open,
    id: 'seam-overlay-double',
    onClose: () => {
      onClose();
      setOpen(false);
    },
  });
  if (!open) return null;
  return <div data-testid="overlay-double">浮层</div>;
}

const renderCanvasBase = () =>
  render(
    <>
      <OverlayEscapeDispatcher />
      <CanvasBaseHarness />
    </>,
  );

/** 模拟用户按 Esc：派发到 body，与真实按键路径一致（document 捕获 → 冒泡）。 */
const pressEscape = (target: Element = document.body) => {
  fireEvent.keyDown(target, { key: 'Escape', code: 'Escape' });
};

const selectedNodeIds = () => useCanvasStore.getState().selectedNodeIds;

beforeEach(() => {
  cleanup();
  usePromptDockStore.setState({
    form: 'generate',
    agentBinding: null,
    agentEntrySnapshot: null,
    agentEntryFocusToken: 0,
  });
  useCanvasStore.setState((state) => {
    state.nodeGraph = graphWithAnnotation();
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
  });
});

describe('OVL-003 栈空透传', () => {
  it('@spec: OVL-003 栈空按 Esc：画布基底语义执行（清选择、焦点回画布）', () => {
    renderCanvasBase();
    act(() => {
      useCanvasStore.setState((state) => {
        state.selectedNodeIds = [NODE_ID];
      });
    });
    expect(selectedNodeIds()).toEqual([NODE_ID]);

    pressEscape();

    expect(selectedNodeIds()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
  });

  it('@spec: OVL-003 栈非空按 Esc：只关栈顶层，画布基底不触发', () => {
    const closeOverlay = vi.fn();
    render(
      <>
        <OverlayEscapeDispatcher />
        <CanvasBaseHarness />
        <OverlayDouble onClose={closeOverlay} />
      </>,
    );
    act(() => {
      useCanvasStore.setState((state) => {
        state.selectedNodeIds = [NODE_ID];
      });
    });

    pressEscape();

    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('overlay-double')).toBeNull();
    // 基底未被触发：选择保留，焦点也未回画布。
    expect(selectedNodeIds()).toEqual([NODE_ID]);
    expect(document.activeElement).not.toBe(screen.getByTestId('canvas-root'));
  });

  // @spec: OVL-003
  it('栈顶退出后栈空：再按 Esc 才落回画布基底', () => {
    render(
      <>
        <OverlayEscapeDispatcher />
        <CanvasBaseHarness />
        <OverlayDouble onClose={() => undefined} />
      </>,
    );
    act(() => {
      useCanvasStore.setState((state) => {
        state.selectedNodeIds = [NODE_ID];
      });
    });

    pressEscape();
    expect(selectedNodeIds()).toEqual([NODE_ID]);

    pressEscape();

    expect(selectedNodeIds()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
  });
});

describe('OVL-005 编辑态先于宿主', () => {
  // @spec: OVL-005
  it('注释编辑态：一次 Esc 只退编辑态（宿主浮层保持），再按才退宿主', () => {
    const closeHost = vi.fn();
    render(
      <>
        <OverlayEscapeDispatcher />
        <CanvasBaseHarness />
        <OverlayDouble onClose={closeHost} />
        <AnnotationOverlay onOpenContextMenu={() => undefined} />
      </>,
    );

    act(() => {
      useCanvasStore.getState().setEditingAnnotation(ANNOTATION_ID);
    });
    expect(useCanvasStore.getState().editingAnnotationId).toBe(ANNOTATION_ID);

    pressEscape();

    // 编辑态先退：宿主浮层仍在，栈未落到宿主。
    expect(useCanvasStore.getState().editingAnnotationId).toBeNull();
    expect(closeHost).not.toHaveBeenCalled();
    expect(screen.getByTestId('overlay-double')).toBeInTheDocument();

    pressEscape();

    // 编辑态已退出，这次才轮到宿主浮层。
    expect(closeHost).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('overlay-double')).toBeNull();
  });

  it('@spec: OVL-005 注释编辑态（画布为宿主）：Esc 只退编辑态，画布基底不被触发', () => {
    render(
      <>
        <OverlayEscapeDispatcher />
        <CanvasBaseHarness />
        <AnnotationOverlay onOpenContextMenu={() => undefined} />
      </>,
    );
    act(() => {
      useCanvasStore.getState().setEditingAnnotation(ANNOTATION_ID);
    });
    expect(useCanvasStore.getState().editingAnnotationId).toBe(ANNOTATION_ID);

    pressEscape();

    // 判据用「焦点未回画布」：进入注释编辑态本身就会清空节点选择（store 语义），
    // 因此选择集合不能区分「编辑态退出」与「基底清选择」；焦点回画布是基底独有的动作。
    expect(useCanvasStore.getState().editingAnnotationId).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId('canvas-root'));

    pressEscape();

    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
  });
});
