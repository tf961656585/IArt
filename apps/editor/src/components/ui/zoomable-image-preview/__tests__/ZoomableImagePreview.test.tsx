import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ZoomableImagePreview } from '../ZoomableImagePreview';

/**
 * 槽内交互守卫（`SLOT_INTERACTION_GUARD`）：
 * surface 的 pointerdown 会 `preventDefault` + `setPointerCapture` 启动平移；指针一旦被 surface 捕获，
 * 真机上随后的 mouseup / click 会被重定向到 surface，槽内按钮的 onClick 永远收不到——相册预览的
 * 「下一张」点击无效即此链路（jsdom 不实现指针捕获，看不见重定向本身，因此这里锁住它的前置条件：
 * 槽内按下不得进入 surface 的平移路径）。
 */

// jsdom（25.x）没有 PointerEvent 构造器：`fireEvent.pointerDown` 会退化成 `Event`，事件上没有
// `button`/`pointerId`，而缩放面板的平移分支要求 `button === 0` —— 不补这一步，本文件会整体假绿。
// Pointer Capture API 同样缺失，扣在原型上补齐；只在本测试文件生效。
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

if (typeof window !== 'undefined' && window.PointerEvent === undefined) {
  Object.defineProperty(window, 'PointerEvent', {
    value: TestPointerEvent,
    configurable: true,
    writable: true,
  });
}

for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (!Element.prototype[method]) {
    Object.defineProperty(Element.prototype, method, {
      value: method === 'hasPointerCapture' ? () => false : () => {},
      configurable: true,
      writable: true,
    });
  }
}

describe('ZoomableImagePreview 槽内交互守卫', () => {
  const renderPreview = (): HTMLElement => {
    const { container } = render(
      <ZoomableImagePreview
        src="/preview.png"
        zoomable
        bottomStartSlot={<button type="button">下一张</button>}
        toolbar={<button type="button">下载</button>}
      />,
    );
    return container.firstElementChild as HTMLElement;
  };

  it('槽内按下不启动 surface 平移；面板本体按下仍可平移（守卫不误伤面板手势）', () => {
    const surface = renderPreview();
    expect(surface.style.cursor).toBe('default');

    // 缩放 HUD（含档位切换）/ 底部插槽 / 工具栏：按下都不得落到 surface。
    // 槽位元素先一次性取齐再派发——按下 HUD 的档位按钮会让 Radix 菜单展开（模态），
    // 之后整棵树会被 aria-hidden，查询按可见性就取不到了。
    const slotButtons = ['切换缩放档位', '下一张', '下载'].map(
      (name) => [name, screen.getByRole('button', { name })] as const,
    );
    for (const [name, button] of slotButtons) {
      fireEvent.pointerDown(button, { button: 0 });
      expect(surface.style.cursor, `「${name}」按下不该启动 surface 平移`).toBe('default');
    }

    // 对照组：面板本体按下仍进入平移态——证明上面的绿色不是因为事件根本没派发到 surface。
    fireEvent.pointerDown(surface, { button: 0 });
    expect(surface.style.cursor).toBe('grabbing');
    fireEvent.pointerUp(surface, { button: 0 });
    expect(surface.style.cursor).toBe('default');
  });
});
