export type RuntimeFlags = {
  /**
   * Electron 开发期（未打包）标记：
   * - true: 允许注入更重的调试日志/错误捕获
   * - false: 默认不启用（避免影响正式包体验）
   */
  electronDev: boolean;
};

const DEFAULT_FLAGS: RuntimeFlags = { electronDev: false };
const GLOBAL_KEY = '__IART_RUNTIME_FLAGS__';
const EVENT_NAME = 'iart:runtime-flags';

const normalizeRuntimeFlags = (raw: unknown): RuntimeFlags => {
  if (!raw || typeof raw !== 'object' || !('electronDev' in raw)) {
    return { ...DEFAULT_FLAGS };
  }
  return { electronDev: Boolean(raw.electronDev) };
};

const readFlags = (): RuntimeFlags => {
  const anyGlobal = globalThis as typeof globalThis & { [GLOBAL_KEY]: unknown | undefined };
  return normalizeRuntimeFlags(anyGlobal[GLOBAL_KEY]);
};

export const getRuntimeFlags = (): RuntimeFlags => readFlags();

export const setRuntimeFlags = (patch: Partial<RuntimeFlags>): RuntimeFlags => {
  const next = { ...readFlags(), ...patch };
  next.electronDev = Boolean(next.electronDev);

  const anyGlobal = globalThis as typeof globalThis & { [GLOBAL_KEY]: RuntimeFlags | undefined };
  anyGlobal[GLOBAL_KEY] = next;

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }));
    } catch {
      // ignore
    }
  }
  return next;
};

export const subscribeRuntimeFlags = (handler: (flags: RuntimeFlags) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }

  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    handler(normalizeRuntimeFlags(event.detail));
  };

  window.addEventListener(EVENT_NAME, listener as EventListener);
  return () => window.removeEventListener(EVENT_NAME, listener as EventListener);
};

export const isElectronDev = (): boolean => Boolean(readFlags().electronDev);
