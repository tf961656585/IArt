import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * HubTopBand 契约测试（spec docs/hub/window-chrome.md §6.1/§6.3）。
 *
 * jsdom 无 CSS 引擎，布局语义（带高对轴、hairline 对齐、拖拽命中）由真机几何核验
 * `pnpm verify:hub-title-band` 承担（AGENTS.md：布局类改动没有机械兜底）；本测试锁定
 * token 消费与拖拽区 class 契约不被静默改丢：带高必须来自 preload 桥常量、
 * 带容器必须 drag、交互控件选择器必须被 no-drag 豁免。
 */

const INSETS = { macosTrafficLightWidth: 84, hubTopBandHeight: 56 };

/** 最小 windowControlsOverlay 结构（jsdom 无此 API，测试自供）。 */
interface OverlayLike {
  getTitlebarAreaRect(): DOMRect | null;
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

async function importBand(platform: string, overlay?: OverlayLike) {
  vi.resetModules();
  vi.stubGlobal(
    'electron',
    platform === 'absent' ? undefined : { platform, windowChromeInsets: INSETS },
  );
  if (overlay) {
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
  }
  return await import('../HubTopBand');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
});

describe('HubTopBand', () => {
  it('带高消费 preload 桥常量，带容器 drag、交互控件 no-drag 豁免', async () => {
    const { HubTopBand } = await importBand('darwin');
    const { container } = render(
      <HubTopBand>
        <button type="button">动作</button>
        <input defaultValue="" />
        <span data-no-drag>说明</span>
      </HubTopBand>,
    );
    const band = container.firstElementChild as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.style.height).toBe('56px');
    expect(band.className).toContain('[-webkit-app-region:drag]');
    // 豁免选择器逐项在 class 契约中（组件注释与 spec §6.1 的豁免清单保持一致）
    for (const token of ['[&_button]', '[&_input]', '[&_select]', '[&_textarea]', '[&_a]', '[&_[data-no-drag]]']) {
      expect(band.className).toContain(`${token}:[-webkit-app-region:no-drag]`);
    }
    // 非 win32 无右让位
    expect(band.style.paddingRight).toBe('');
  });

  it('win32 下按 titlebarAreaRect 运行时预留 overlay 宽度 + 14px 间隙', async () => {
    const overlay: OverlayLike = {
      getTitlebarAreaRect: () => new DOMRect(0, 0, 900, 56),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const { HubTopBand } = await importBand('win32', overlay);
    // jsdom innerWidth = 1024 → overlay 宽 124 → 让位 124 + 14
    const { container } = render(
      <HubTopBand>
        <span>占位</span>
      </HubTopBand>,
    );
    const band = container.firstElementChild as HTMLElement;
    expect(band.style.height).toBe('56px');
    expect(band.style.paddingRight).toBe('138px');
  });

  it('缺 preload 桥（windowChromeInsets 不存在）在模块加载即失败，不静默降级', async () => {
    await expect(importBand('absent')).rejects.toThrow(/windowChromeInsets/);
  });
});
