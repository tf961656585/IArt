import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CanvasContextSubmenu } from './CanvasContextSubmenu';
import {
  SUBMENU_CLOSE_DELAY_MS,
  SUBMENU_OPEN_DELAY_MS,
  useCanvasContextSubmenu,
} from './CanvasContextSubmenu.hooks';
import type { ContextMenuSubmenuTrigger } from '../../../types/clipboard';

/**
 * 子菜单交互与生命周期（spec：docs/editor/画布对象右键菜单.md CM-021）。
 *
 * 宿主由最小 harness 承担：真实宿主 CanvasContextMenu 的接线在
 * `__tests__/CanvasContextMenu.test.tsx` 中覆盖。
 */

const buildTrigger = (
  overrides?: Partial<ContextMenuSubmenuTrigger>,
): ContextMenuSubmenuTrigger => ({
  kind: 'submenu',
  id: 'autoLayoutContainer',
  label: '整理本组',
  icon: undefined,
  disabled: undefined,
  items: [
    {
      kind: 'customRow',
      id: 'autoLayoutContainerGrid',
      label: '整理为网格',
      content: <button type="button">网格第一格</button>,
    },
  ],
  ...overrides,
});

function Harness({
  trigger,
  onClose = () => {},
  onRequestClose = () => {},
}: {
  trigger: ContextMenuSubmenuTrigger;
  onClose?: () => void;
  onRequestClose?: (restoreFocus: boolean) => void;
}) {
  const submenu = useCanvasContextSubmenu({ open: true });
  return (
    <div>
      <button
        type="button"
        data-testid="trigger"
        onMouseEnter={(event) => submenu.scheduleOpen(event.currentTarget, trigger)}
        onMouseLeave={submenu.scheduleClose}
        onClick={(event) => {
          if (!submenu.openImmediately(event.currentTarget, trigger)) onClose();
        }}
      >
        整理本组
      </button>
      <CanvasContextSubmenu
        request={submenu.request}
        onPointerEnter={submenu.cancelScheduledClose}
        onPointerLeave={submenu.scheduleClose}
        onRequestClose={onRequestClose}
      />
    </div>
  );
}

describe('CanvasContextSubmenu 子菜单', () => {
  // @spec: CM-021
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('未展开时不渲染子菜单面板', () => {
    render(<Harness trigger={buildTrigger()} />);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('网格第一格')).toBeNull();
  });

  it('指针停留达打开延迟后展开，未达延迟不展开', () => {
    render(<Harness trigger={buildTrigger()} />);

    fireEvent.mouseEnter(screen.getByTestId('trigger'));
    act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS - 1); });
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('menu', { name: '整理本组' })).toBeInTheDocument();
  });

  it('键盘/点击激活立即展开，焦点交给子菜单内第一个可用控件', () => {
    render(<Harness trigger={buildTrigger()} />);

    fireEvent.click(screen.getByTestId('trigger'));

    expect(screen.getByText('网格第一格')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '网格第一格' }));
  });

  it('指针离开后达关闭延迟才收起，进入子菜单可取消关闭', () => {
    render(<Harness trigger={buildTrigger()} />);
    fireEvent.click(screen.getByTestId('trigger'));

    fireEvent.mouseLeave(screen.getByTestId('trigger'));
    const panel = screen.getByRole('menu', { name: '整理本组' });
    fireEvent.mouseEnter(panel);
    act(() => { vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS * 2); });
    expect(screen.getByRole('menu', { name: '整理本组' })).toBeInTheDocument();

    fireEvent.mouseLeave(panel);
    act(() => { vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS); });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('禁用的触发项不展开（不可展开即不外泄子菜单内容）', () => {
    render(<Harness trigger={buildTrigger({ disabled: true })} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('trigger'));
    fireEvent.mouseEnter(screen.getByTestId('trigger'));
    act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS * 2); });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('子菜单内按 ArrowLeft 收起并把焦点交还触发项', () => {
    const onRequestClose = vi.fn();
    render(<Harness trigger={buildTrigger()} onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('trigger'));

    fireEvent.keyDown(screen.getByText('网格第一格'), { key: 'ArrowLeft' });

    expect(onRequestClose).toHaveBeenCalledWith(true);
  });

  it('行内控件已消费的方向键不被子菜单截获', () => {
    const onRequestClose = vi.fn();
    render(<Harness trigger={buildTrigger()} onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('trigger'));

    // 行内控件先 preventDefault（如网格行的左右键在同一预览上移动焦点），子菜单让行内语义优先
    const cell = screen.getByRole('button', { name: '网格第一格' });
    cell.addEventListener('keydown', (event) => event.preventDefault());
    fireEvent.keyDown(cell, { key: 'ArrowLeft' });

    expect(onRequestClose).not.toHaveBeenCalled();
  });

  // @spec: CM-029
  it('子菜单挂在 body 顶层，不受主菜单容器裁剪', () => {
    render(<Harness trigger={buildTrigger()} />);
    fireEvent.click(screen.getByTestId('trigger'));

    const panel = screen.getByRole('menu', { name: '整理本组' });
    expect(panel).toHaveAttribute('data-canvas-context-submenu');
    expect(panel.parentElement).toBe(document.body);
  });
});

/** 子菜单内 ↑↓ roving 导航（spec §5.5）：标准按钮行以 role=menuitem 进导航序列。 */
const buildActionTrigger = (): ContextMenuSubmenuTrigger => ({
  kind: 'submenu',
  id: 'autoLayoutContainer',
  label: '整理本组',
  icon: undefined,
  disabled: undefined,
  items: [
    {
      kind: 'action',
      id: 'submenu-action-1',
      label: '子项一',
      shortcut: undefined,
      icon: undefined,
      disabled: undefined,
      destructive: undefined,
      action: vi.fn(),
    },
    {
      kind: 'action',
      id: 'submenu-action-2',
      label: '子项二',
      shortcut: undefined,
      icon: undefined,
      disabled: true,
      destructive: undefined,
      action: vi.fn(),
    },
    {
      kind: 'action',
      id: 'submenu-action-3',
      label: '子项三',
      shortcut: undefined,
      icon: undefined,
      disabled: undefined,
      destructive: undefined,
      action: vi.fn(),
    },
  ],
});

describe('CanvasContextSubmenu 子菜单内键盘导航', () => {
  // @spec: CM-010
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const expand = () => {
    render(<Harness trigger={buildActionTrigger()} />);
    fireEvent.click(screen.getByTestId('trigger'));
  };

  const menuitem = (name: string) => screen.getByRole('menuitem', { name });

  const pressOn = (key: string) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) throw new Error('无焦点元素');
    fireEvent.keyDown(active, { key });
  };

  it('子菜单行为 role=menuitem，键盘展开后焦点在第一个可用项', () => {
    expand();

    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    // 禁用的子项二在序列外可见，但不占导航位
    expect(menuitem('子项二')).toBeDisabled();
    expect(document.activeElement).toBe(menuitem('子项一'));
  });

  it('ArrowDown/Up 在可用项间移动、跳过禁用项并循环', () => {
    expand();

    // 子项一向下 → 跳过禁用的子项二 → 子项三
    pressOn('ArrowDown');
    expect(document.activeElement).toBe(menuitem('子项三'));

    // 末项再向下 → 绕回首项
    pressOn('ArrowDown');
    expect(document.activeElement).toBe(menuitem('子项一'));

    // 首项向上 → 绕回末项
    pressOn('ArrowUp');
    expect(document.activeElement).toBe(menuitem('子项三'));

    pressOn('ArrowUp');
    expect(document.activeElement).toBe(menuitem('子项一'));
  });

  it('Home 跳首可用项，End 跳末可用项', () => {
    expand();

    pressOn('End');
    expect(document.activeElement).toBe(menuitem('子项三'));

    pressOn('Home');
    expect(document.activeElement).toBe(menuitem('子项一'));
  });

  it('ArrowLeft 仍收起子菜单并把焦点交还触发项（导航不截获收起语义）', () => {
    const onRequestClose = vi.fn();
    render(<Harness trigger={buildActionTrigger()} onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(document.activeElement).toBe(menuitem('子项一'));

    fireEvent.keyDown(menuitem('子项一'), { key: 'ArrowLeft' });

    expect(onRequestClose).toHaveBeenCalledWith(true);
  });
});
