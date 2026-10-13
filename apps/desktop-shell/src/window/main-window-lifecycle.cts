const normalizeStartUrl = (value: string | null | undefined) => {
  if (typeof value !== 'string') return 'about:blank';
  const trimmed = value.trim();
  return trimmed || 'about:blank';
};

type ClosedEventWindowLike = {
  once: (eventName: 'closed', listener: () => void) => unknown;
  on: (eventName: 'closed', listener: () => void) => unknown;
};

type WindowLike = ClosedEventWindowLike & {
  isDestroyed: () => boolean | undefined;
  isMinimized: () => boolean | undefined;
  restore: () => void;
  show: () => void;
  focus: () => void;
  loadURL: (url: string) => Promise<unknown>;
};

type MainWindowLifecycleOptions<TWindow extends WindowLike> = {
  createWindow: (startUrl: string) => TWindow | undefined;
  onWindowBound: (window: TWindow) => void | undefined;
  onWindowCleared: (window: TWindow, reason: string) => void | undefined;
};

export const createMainWindowLifecycle = <TWindow extends WindowLike>({
  createWindow,
  onWindowBound,
  onWindowCleared,
}: MainWindowLifecycleOptions<TWindow>) => {
  if (typeof createWindow !== 'function') {
    throw new TypeError('createWindow must be a function');
  }

  let windowRef: TWindow | null = null;

  const isWindowAlive = (win: TWindow | null | undefined) => {
    if (!win) return false;
    try {
      if (typeof win.isDestroyed === 'function') {
        return !win.isDestroyed();
      }
      return true;
    } catch {
      return false;
    }
  };

  const clearWindowRef = (reason: string, win: TWindow | null | undefined) => {
    if (!windowRef) return;
    if (win && windowRef !== win) return;
    const previous = windowRef;
    windowRef = null;
    try {
      if (onWindowCleared !== null && onWindowCleared !== undefined) {
        onWindowCleared(previous, reason);
      }
    } catch {
      // ignore
    }
  };

  const bindWindow = (win: TWindow | null | undefined) => {
    if (!win) return null;
    windowRef = win;
    try {
      if (onWindowBound !== null && onWindowBound !== undefined) {
        onWindowBound(win);
      }
    } catch {
      // ignore
    }

    const handleClosed = () => {
      clearWindowRef('closed', win);
    };
    try {
      if (typeof win.once === 'function') {
        win.once('closed', handleClosed);
      } else if (typeof win.on === 'function') {
        win.on('closed', handleClosed);
      }
    } catch {
      // ignore
    }
    return win;
  };

  const getAliveWindow = () => {
    if (isWindowAlive(windowRef)) {
      return windowRef;
    }
    if (windowRef) {
      clearWindowRef('destroyed', windowRef);
    }
    return null;
  };

  const ensureWindow = (startUrl = 'about:blank') => {
    const alive = getAliveWindow();
    if (alive) return alive;
    const next = createWindow(normalizeStartUrl(startUrl));
    return bindWindow(next);
  };

  const showOrRestore = (startUrl = 'about:blank') => {
    const win = ensureWindow(startUrl);
    if (!isWindowAlive(win)) {
      clearWindowRef('destroyed', win);
      return { ok: false, reason: 'window-unavailable' };
    }

    try {
      if (win !== null && win !== undefined) {
        if (typeof win.isMinimized === 'function' && win.isMinimized()) {
          win.restore();
        }
        if (typeof win.show === 'function') {
          win.show();
        }
        if (typeof win.focus === 'function') {
          win.focus();
        }
      }
      return { ok: true, window: win };
    } catch (error) {
      if (!isWindowAlive(win)) {
        clearWindowRef('destroyed', win);
        return { ok: false, reason: 'window-destroyed', error };
      }
      return { ok: false, reason: 'show-failed', error };
    }
  };

  const safeLoadURL = async (
    url: string,
    {
      createIfMissing = false,
      startUrl = 'about:blank',
    }: { createIfMissing: boolean | undefined; startUrl: string | undefined } = {
      createIfMissing: false,
      startUrl: 'about:blank',
    },
  ) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false, reason: 'invalid-url' };
    }

    let win = getAliveWindow();
    if (!win && createIfMissing) {
      win = ensureWindow(startUrl);
    }
    if (!win || !isWindowAlive(win)) {
      if (win) clearWindowRef('destroyed', win);
      return { ok: false, reason: 'window-unavailable' };
    }

    try {
      await win.loadURL(url);
      return { ok: true, window: win };
    } catch (error) {
      if (!isWindowAlive(win)) {
        clearWindowRef('destroyed', win);
        return { ok: false, reason: 'window-destroyed', error };
      }
      return { ok: false, reason: 'load-failed', error };
    }
  };

  return {
    bindWindow,
    getAliveWindow,
    ensureWindow,
    showOrRestore,
    safeLoadURL,
  };
};
