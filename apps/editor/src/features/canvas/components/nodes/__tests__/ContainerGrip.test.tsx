import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ContainerGrip, type ContainerGripProps } from '../ContainerGrip';

/**
 * 屏幕恒定容器握把（spec：画布节点组.md AG-CN-019 / AG-CN-020）。
 *
 * 保护：
 * - 屏幕尺寸反算：所有尺寸写成「屏幕 px ÷ zoom」的画布 px（44 命中高、24 视觉高、
 *   宽度 max(88, min(240, 容器屏幕宽))——容器屏宽 < 88px 时保持 88px、允许略宽于容器）；
 * - 放置：above 走 bottom:100%（容器框上方），inside 走 top:0（顶边翻转进框内）；
 * - 拖动语义：按钮无 nodrag（拖动交回 React Flow 既有节点拖动链路），单击只调 onLocate；
 * - 标签：`label · 成员数`（零成员不显示 ` · 0`），单行省略；
 * - 常显 2×3 握把点（6 个圆点）。
 *
 * 本测试不引入 ReactFlowProvider（组件是纯展示层，不订阅视口）。
 */

const baseProps: ContainerGripProps = {
  containerId: 'group-1',
  label: '夜景改造',
  memberCount: 3,
  accent: 'var(--group-color)',
  zoom: 1,
  screenWidth: 360,
  placement: 'above',
  isDragging: false,
  onLocate: () => undefined,
};

const renderGrip = (overrides: Partial<ContainerGripProps> = {}): HTMLElement => {
  render(<ContainerGrip {...baseProps} {...overrides} />);
  return screen.getByTestId('container-grip');
};

afterEach(() => {
  cleanup();
});

describe('ContainerGrip 屏幕尺寸反算', () => {
  // @spec: AG-CN-019, AG-CN-020
  it('zoom=0.5 + 屏幕宽 360：命中高 88px（画布）、宽 480px、放置 above、无 nodrag、pill 48px、6 点、标签省略', () => {
    const grip = renderGrip({ zoom: 0.5, screenWidth: 360, placement: 'above' });

    expect(grip.getAttribute('data-placement')).toBe('above');
    expect(grip.getAttribute('data-container-id')).toBe('group-1');
    // 44 / 0.5 = 88 画布 px（屏幕恒 44）
    expect(grip.style.height).toBe('88px');
    // min(240, 360) / 0.5 = 480 画布 px（屏幕恒 240）
    expect(grip.style.width).toBe('480px');
    expect(grip.style.bottom).toBe('100%');
    // 无 nodrag：拖动交给 React Flow 既有节点拖动链路
    expect(grip.closest('.nodrag')).toBeNull();

    const pill = screen.getByTestId('container-grip-pill');
    // 24 / 0.5 = 48 画布 px（屏幕恒 24）
    expect(pill.style.height).toBe('48px');

    const label = screen.getByTestId('container-grip-label');
    expect(label.textContent).toBe('夜景改造 · 3');
    expect(label.style.textOverflow).toBe('ellipsis');

    expect(grip.querySelectorAll('i')).toHaveLength(6);
  });

  // @spec: AG-CN-019
  it('单击只调用一次 onLocate（定位走既有 locateToNode，不引入自定义拖动逻辑）', () => {
    const onLocate = vi.fn();
    const grip = renderGrip({ onLocate });

    fireEvent.click(grip);

    expect(onLocate).toHaveBeenCalledTimes(1);
  });

  // @spec: AG-CN-019
  it("placement='inside'（顶边翻转）走 top:0，不设 bottom", () => {
    const grip = renderGrip({ placement: 'inside' });

    expect(grip.getAttribute('data-placement')).toBe('inside');
    expect(grip.style.top).toBe('0px');
    expect(grip.style.bottom).toBe('');
  });

  // @spec: AG-CN-020
  it('宽度下限 88 屏幕 px（screenWidth=60）', () => {
    const grip = renderGrip({ zoom: 0.5, screenWidth: 60 });
    // max(88, min(240, 60)) / 0.5 = 176
    expect(grip.style.width).toBe('176px');
  });

  // @spec: AG-CN-020
  it('宽度上限 240 屏幕 px（screenWidth=1000）', () => {
    const grip = renderGrip({ zoom: 0.5, screenWidth: 1000 });
    // min(240, 1000) / 0.5 = 480
    expect(grip.style.width).toBe('480px');
  });

  // @spec: AG-CN-019
  it('零成员时标签不含「 · 0」', () => {
    renderGrip({ memberCount: 0 });
    expect(screen.getByTestId('container-grip-label').textContent).toBe('夜景改造');
  });

  // @spec: AG-CN-019
  it('拖动中光标为 grabbing', () => {
    const grip = renderGrip({ isDragging: true });
    expect(grip.style.cursor).toBe('grabbing');
  });
});
