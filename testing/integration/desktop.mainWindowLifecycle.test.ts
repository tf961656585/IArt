// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

class MockWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  restoredCount = 0;
  shownCount = 0;
  focusedCount = 0;
  loadedUrls: string[] = [];

  readonly loadURL = vi.fn(async (url: string) => {
    this.loadedUrls.push(url);
  });

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.minimized = false;
    this.restoredCount += 1;
  }

  show() {
    this.shownCount += 1;
  }

  focus() {
    this.focusedCount += 1;
  }

  markDestroyed() {
    this.destroyed = true;
  }
}

const loadModule = async () => import('../../apps/desktop-shell/dist/window/main-window-lifecycle.cjs');

const assertMockWindow = (window: unknown): MockWindow => {
  if (window instanceof MockWindow) {
    return window;
  }
  throw new Error('unexpected_window_instance');
};

describe('desktop/window/main-window-lifecycle.cjs', () => {
  it('销毁后自动失效引用，并在下次 show 时重建', async () => {
    const { createMainWindowLifecycle } = await loadModule();
    const created: MockWindow[] = [];
    const lifecycle = createMainWindowLifecycle({
      createWindow: (startUrl: string) => {
        const win = new MockWindow();
        void win.loadURL(startUrl);
        created.push(win);
        return win;
      },
    });

    const first = assertMockWindow(lifecycle.ensureWindow('http://127.0.0.1:3000/hub'));
    expect(created).toHaveLength(1);

    first.markDestroyed();

    const result = lifecycle.showOrRestore('http://127.0.0.1:3001/hub');
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(2);
    const rebuilt = created[1];
    expect(rebuilt).toBeDefined();
    if (!rebuilt) {
      throw new Error('rebuilt_window_not_found');
    }
    expect(rebuilt.shownCount).toBe(1);
    expect(rebuilt.focusedCount).toBe(1);
  });

  it('窗口 closed 事件后会清理引用并触发回调', async () => {
    const { createMainWindowLifecycle } = await loadModule();
    const onWindowBound = vi.fn();
    const onWindowCleared = vi.fn();
    const lifecycle = createMainWindowLifecycle({
      createWindow: () => new MockWindow(),
      onWindowBound,
      onWindowCleared,
    });

    const win = assertMockWindow(lifecycle.ensureWindow('about:blank'));
    expect(onWindowBound).toHaveBeenCalledWith(win);
    expect(lifecycle.getAliveWindow()).toBe(win);

    win.emit('closed');

    expect(lifecycle.getAliveWindow()).toBeNull();
    expect(onWindowCleared).toHaveBeenCalledWith(win, 'closed');
  });

  it('safeLoadURL 在无窗口时按配置决定是否创建窗口', async () => {
    const { createMainWindowLifecycle } = await loadModule();
    const createWindow = vi.fn(() => new MockWindow());
    const lifecycle = createMainWindowLifecycle({ createWindow });

    const withoutCreate = await lifecycle.safeLoadURL('http://127.0.0.1:3000/hub');
    expect(withoutCreate.ok).toBe(false);
    expect(withoutCreate.reason).toBe('window-unavailable');
    expect(createWindow).toHaveBeenCalledTimes(0);

    const withCreate = await lifecycle.safeLoadURL('http://127.0.0.1:3000/hub', {
      createIfMissing: true,
      startUrl: 'about:blank',
    });
    expect(withCreate.ok).toBe(true);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });
});
