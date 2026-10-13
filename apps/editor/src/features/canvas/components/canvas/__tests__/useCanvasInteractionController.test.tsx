import React from 'react';
import { createPortal } from 'react-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useCanvasInteractionController } from '../useCanvasInteractionController';
import { cast } from '@/lib/utils';
import type { ContextMenuState } from '@/features/canvas/types/clipboard';
import type { ContainerGapGeometry } from '@/features/canvas/utils/containerGapHitTest';

/**
 * 画布根 mousedown capture 守卫的回归保护。
 *
 * 背景：子菜单面板（CanvasContextSubmenu）portal 到 body，DOM 上不在主菜单内，
 * 但仍是 CanvasContextMenu 的 React 子树——React 事件沿 React 树传播，所以子菜单内的
 * mousedown 会先经过画布根的 onMouseDownCapture。若该守卫只放行主菜单选择器，子菜单内的
 * 点击会被判成「点击菜单外」，菜单在 mousedown 阶段即被卸载，网格单元的 click 永不触发
 *（2026-09-10 网格行移入子菜单后「整理为网格」失效的根因）。
 *
 * 这里用真实 portal + fireEvent 复现传播路径，而不是直接调 handler，确保守卫真的覆盖
 * 子菜单这一层菜单面。
 */

const closeContextMenu = vi.fn();
const cancelMarquee = vi.fn();
const startMarquee = vi.fn();

// 选中态由用例注入（容器内空白推导的多选优先规则需要 >1 选中分支）
let mockSelectedNodeIds: string[] = [];

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../../store/canvasStore', () => {
  const useCanvasStore = Object.assign(() => undefined, {
    getState: () => ({
      selectedNodeIds: mockSelectedNodeIds,
      selectedAnnotationIds: [] as string[],
    }),
  });
  return { useCanvasStore };
});

type SetContextMenu = Parameters<typeof useCanvasInteractionController>[0]['setContextMenu'];

type HarnessProps = {
  contextMenuOpen?: boolean;
  withMainMenu?: boolean;
  withSubmenu?: boolean;
  pendingPlacement?: { characterId: string } | null;
  pendingAnnotationBinding?: { annotationId: string } | null;
  setContextMenu?: SetContextMenu;
  selectNodes?: (nodeIds: string[], reason: string) => void;
  containerGeometries?: readonly ContainerGapGeometry[];
};

const Harness = ({
  contextMenuOpen = true,
  withMainMenu = true,
  withSubmenu = true,
  pendingPlacement = null,
  pendingAnnotationBinding = null,
  setContextMenu = vi.fn(),
  selectNodes = () => undefined,
  containerGeometries = [],
}: HarnessProps) => {
  const controller = useCanvasInteractionController({
    contextMenuOpen,
    setContextMenu,
    closeContextMenu,
    screenToFlowPosition: (position) => position,
    containerGeometries,
    applySelectionCommand: () => undefined,
    selectNodes,
    selectAnnotations: () => undefined,
    clearCanvasSelection: () => undefined,
    pendingPlacement,
    createCharacterImageNode: async () => undefined,
    completePlacement: () => undefined,
    pendingAnnotationBinding,
    bindAnnotation: () => false,
    cancelAnnotationBinding: () => undefined,
    startMarquee,
    skipNextPaneClickRef: { current: false },
    cancelMarquee,
  });

  return (
    <div data-testid="canvas-root" onMouseDownCapture={controller.handleCanvasMouseDownCapture}>
      <div data-testid="canvas-pane" />
      <button
        type="button"
        data-testid="trigger-pane-menu"
        onClick={() =>
          controller.onPaneContextMenu(
            cast<Parameters<typeof controller.onPaneContextMenu>[0]>({
              preventDefault: () => undefined,
              clientX: 12,
              clientY: 34,
            }),
          )
        }
      />
      <button
        type="button"
        data-testid="trigger-pane-menu-far"
        onClick={() =>
          controller.onPaneContextMenu(
            cast<Parameters<typeof controller.onPaneContextMenu>[0]>({
              preventDefault: () => undefined,
              clientX: 500,
              clientY: 500,
            }),
          )
        }
      />
      <button
        type="button"
        data-testid="trigger-node-menu"
        onClick={() =>
          controller.onNodeContextMenu(
            cast<Parameters<typeof controller.onNodeContextMenu>[0]>({
              preventDefault: () => undefined,
              clientX: 12,
              clientY: 34,
            }),
            cast<Parameters<typeof controller.onNodeContextMenu>[1]>({ id: 'node-1' }),
          )
        }
      />
      {withMainMenu
        ? createPortal(
            <div data-canvas-context-menu>
              <button type="button" data-testid="main-menu-action">
                action
              </button>
            </div>,
            document.body,
          )
        : null}
      {withSubmenu
        ? createPortal(
            <div data-canvas-context-submenu>
              <button type="button" data-testid="tidy-grid-cell">
                cell
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};

describe('useCanvasInteractionController 菜单面 mousedown 守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('子菜单面板内的左键按下不关闭菜单（子菜单是菜单内，不是菜单外）', () => {
    render(<Harness />);

    fireEvent.mouseDown(screen.getByTestId('tidy-grid-cell'), { button: 0 });

    expect(closeContextMenu).not.toHaveBeenCalled();
    expect(cancelMarquee).not.toHaveBeenCalled();
  });

  it('主菜单面板内的左键按下不关闭菜单', () => {
    render(<Harness />);

    fireEvent.mouseDown(screen.getByTestId('main-menu-action'), { button: 0 });

    expect(closeContextMenu).not.toHaveBeenCalled();
  });

  it('shift+左键在子菜单内不启动框选，也不关闭菜单', () => {
    render(<Harness />);

    fireEvent.mouseDown(screen.getByTestId('tidy-grid-cell'), { button: 0, shiftKey: true });

    expect(startMarquee).not.toHaveBeenCalled();
    expect(closeContextMenu).not.toHaveBeenCalled();
    expect(cancelMarquee).not.toHaveBeenCalled();
  });

  // @spec: CM-018
  it('菜单外左键按下关闭菜单并取消框选', () => {
    render(<Harness />);

    fireEvent.mouseDown(screen.getByTestId('canvas-pane'), { button: 0 });

    expect(closeContextMenu).toHaveBeenCalledTimes(1);
    expect(cancelMarquee).toHaveBeenCalledTimes(1);
  });

  it('菜单未打开时菜单外按下不关闭也不取消框选', () => {
    render(<Harness contextMenuOpen={false} />);

    fireEvent.mouseDown(screen.getByTestId('canvas-pane'), { button: 0 });

    expect(closeContextMenu).not.toHaveBeenCalled();
    expect(cancelMarquee).not.toHaveBeenCalled();
  });

  it('子菜单内的右键按下不触发菜单外关闭', () => {
    render(<Harness />);

    fireEvent.mouseDown(screen.getByTestId('tidy-grid-cell'), { button: 2 });

    expect(closeContextMenu).not.toHaveBeenCalled();
  });
});

describe('useCanvasInteractionController 等待模式菜单豁免', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const buildSetContextMenu = () => {
    const states: ContextMenuState[] = [];
    // 控制器只以值形态调用 setContextMenu({...})，不传 updater；测试按值形态记录
    const setContextMenu: SetContextMenu = (action) => {
      if (typeof action === 'function') return;
      states.push(action);
    };
    return { states, setContextMenu };
  };

  // @spec: CM-001
  it('无等待模式时，空白区右键打开空白区菜单、节点右键打开对象菜单', () => {
    const { states, setContextMenu } = buildSetContextMenu();
    render(<Harness setContextMenu={setContextMenu} />);

    fireEvent.click(screen.getByTestId('trigger-pane-menu'));
    expect(states[0]?.target?.type).toBe('pane');

    fireEvent.click(screen.getByTestId('trigger-node-menu'));
    expect(states[1]?.target?.type).toBe('node');
  });

  // @spec: CM-006
  it('角色放置等待模式期间，空白区菜单与对象菜单均不打开（CM-006）', () => {
    const { states, setContextMenu } = buildSetContextMenu();
    render(<Harness setContextMenu={setContextMenu} pendingPlacement={{ characterId: 'char-1' }} />);

    fireEvent.click(screen.getByTestId('trigger-pane-menu'));
    fireEvent.click(screen.getByTestId('trigger-node-menu'));

    expect(states).toEqual([]);
  });

  // @spec: CM-006
  it('注释绑定等待模式期间，空白区菜单与对象菜单均不打开（CM-006）', () => {
    const { states, setContextMenu } = buildSetContextMenu();
    render(
      <Harness
        setContextMenu={setContextMenu}
        pendingAnnotationBinding={{ annotationId: 'ann-1' }}
      />,
    );

    fireEvent.click(screen.getByTestId('trigger-pane-menu'));
    fireEvent.click(screen.getByTestId('trigger-node-menu'));

    expect(states).toEqual([]);
  });
});

describe('useCanvasInteractionController 容器内空白目标推导', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedNodeIds = [];
  });

  const buildSetContextMenu = () => {
    const states: ContextMenuState[] = [];
    const setContextMenu: SetContextMenu = (action) => {
      if (typeof action === 'function') return;
      states.push(action);
    };
    return { states, setContextMenu };
  };

  // 触发点为 pane 触发器的 (12, 34)（screenToFlowPosition 为恒等换算）
  const groupGeometry: ContainerGapGeometry = {
    containerNodeId: 'group-1',
    containerKind: 'group',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };

  // @spec: CM-004, CM-026, CM-027
  it('选中 ≤1 且点落在容器空白内：目标为 containerGap，携带容器 id/种类，且不写选中', () => {
    const { states, setContextMenu } = buildSetContextMenu();
    const selectNodes = vi.fn();
    render(
      <Harness
        setContextMenu={setContextMenu}
        selectNodes={selectNodes}
        containerGeometries={[groupGeometry]}
      />,
    );

    fireEvent.click(screen.getByTestId('trigger-pane-menu'));

    expect(states[0]?.target).toEqual({
      type: 'containerGap',
      containerNodeId: 'group-1',
      containerKind: 'group',
      position: { x: 12, y: 34 },
    });
    // 容器内空白路径不改变选中：菜单动作显式绑定命中容器 id，不依赖选中态
    expect(selectNodes).not.toHaveBeenCalled();
  });

  // @spec: CM-022
  it('已选中 >1 个节点时多选优先：即便命中容器空白仍弹多选菜单', () => {
    mockSelectedNodeIds = ['n1', 'n2'];
    const { states, setContextMenu } = buildSetContextMenu();
    const selectNodes = vi.fn();
    render(
      <Harness
        setContextMenu={setContextMenu}
        selectNodes={selectNodes}
        containerGeometries={[groupGeometry]}
      />,
    );

    fireEvent.click(screen.getByTestId('trigger-pane-menu'));

    expect(states[0]?.target?.type).toBe('selection');
    expect(selectNodes).not.toHaveBeenCalled();
  });

  // @spec: CM-022
  it('选中 ≤1 且未命中任何容器：回落 pane 菜单', () => {
    const { states, setContextMenu } = buildSetContextMenu();
    render(
      <Harness
        setContextMenu={setContextMenu}
        containerGeometries={[groupGeometry]}
      />,
    );

    // (500, 500) 在容器几何之外：真空白属正常路径，回落 pane
    fireEvent.click(screen.getByTestId('trigger-pane-menu-far'));

    expect(states[0]?.target?.type).toBe('pane');
  });
});
