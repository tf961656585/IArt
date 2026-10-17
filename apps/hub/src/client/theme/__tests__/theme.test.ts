import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { HUB_INITIAL_TITLE_BAR_OVERLAY } from '@iart/contracts';
import cssColorModule from '@iart/utils/css-color';
const { cssColorToHex } = cssColorModule;
import {
  applyThemeToDocument,
  readThemePreference,
  resolveEffectiveTheme,
  type ThemePreference,
  writeThemePreference,
} from '../theme-store';
import { syncTitleBarOverlay } from '../sync-title-bar-overlay';
import { useTheme } from '../use-theme';

/**
 * Hub 主题应用链路测试（spec docs/hub/hub-renderer-architecture.md §8.1、
 * docs/hub/window-chrome.md §7）。
 *
 * 覆盖 2026-10-16 实证缺陷的回归与守卫：
 * ① nativeTheme.themeSource 必须按偏好直写（system 不解析）——把解析结果推送会
 *    反向污染 prefers-color-scheme 媒询，令「跟随系统」自锁恒深；
 * ② titleBarOverlay 配色必须折算成 sRGB hex 再过 IPC——oklch 原串会被 Electron
 *    颜色解析器静默拒绝、回落浅色白条；
 * ③ globals.css 令牌 ↔ contracts 初始 overlay 常量漂移守卫。
 *
 * 范式：subset-shape 假体 + 单步结构断言（对齐 electron-bridge-skill-targets.test.ts
 * 的 setElectronApi 注入），不使用双重断言。jsdom 不做 CSS 计算，令牌计算值由
 * getComputedStyle 假体按当前 .dark class 状态给出（模拟真实「先 toggle 再读值」时序）。
 */

type MediaListener = (event: MediaQueryListEvent) => void;

/** Hub 深浅两档令牌值（apps/hub/src/app/globals.css :root / .dark 的 --background/--foreground）。 */
const DARK_TOKENS = { background: 'oklch(0.165 0.012 277)', foreground: 'oklch(0.97 0.003 277)' };
const LIGHT_TOKENS = { background: 'oklch(0.96 0.003 277)', foreground: 'oklch(0.235 0.015 277)' };

const setElectronApi = (api: Record<string, unknown> | undefined): void => {
  (window as { electron?: unknown }).electron = api;
};

/**
 * 本测试环境的全局 localStorage 是无方法的空壳假体（探针实测：原型与自有键皆空），
 * 不能承载 theme-store 的真实读写。装一个内存版 Storage 替身——被测对象是
 * theme-store 的读写逻辑，不是浏览器 Storage 本体。
 */
const installMemoryStorage = (): void => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string): string | null => (store.has(key) ? (store.get(key) ?? null) : null),
      setItem: (key: string, value: string): void => void store.set(key, String(value)),
      removeItem: (key: string): void => void store.delete(key),
      clear: (): void => void store.clear(),
    },
  });
};

let mediaChangeListener: MediaListener | undefined;
let systemPrefersDark = false;
let matchMediaSpied = false;

/** 构造完整形状的 MediaQueryList 假体（零断言；matches 动态读共享变量）。 */
const createMediaQueryList = (query: string): MediaQueryList => ({
  matches: systemPrefersDark && query.includes('dark'),
  media: query,
  onchange: null,
  addListener: (): void => {},
  removeListener: (): void => {},
  addEventListener: (
    _type: string,
    listener: EventListener | EventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void => {
    mediaChangeListener =
      listener !== null && typeof listener === 'function' ? (listener as MediaListener) : undefined;
  },
  removeEventListener: (): void => {
    mediaChangeListener = undefined;
  },
  dispatchEvent: (): boolean => true,
});

/** 控制 prefers-color-scheme 媒询返回值；捕获 change 监听器供手动触发。
 * matches 在每次查询时动态读取共享变量——模拟媒询 change 后系统状态已真实翻转。 */
const setSystemPrefersDark = (dark: boolean): void => {
  systemPrefersDark = dark;
  if (matchMediaSpied) return;
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
    createMediaQueryList(query),
  );
  matchMediaSpied = true;
};

/** 按 .dark class 状态返回对应主题令牌的 getComputedStyle 假体；可用 overrides 制造非法值。 */
const stubComputedTokens = (
  overrides: Record<string, string> = {},
): void => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element) => {
    const dark = elt.classList.contains('dark');
    const tokens = dark ? DARK_TOKENS : LIGHT_TOKENS;
    return {
      getPropertyValue: (name: string) => {
        if (name === '--background') return overrides['--background'] ?? tokens.background;
        if (name === '--foreground') return overrides['--foreground'] ?? tokens.foreground;
        return '';
      },
    } as CSSStyleDeclaration;
  });
};

const createElectronApi = (): {
  platform: string;
  setNativeThemeSource: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
} => ({
  platform: 'win32',
  setNativeThemeSource: vi.fn(),
  setTitleBarOverlay: vi.fn(),
});

beforeEach(() => {
  installMemoryStorage();
  document.documentElement.className = '';
  mediaChangeListener = undefined;
  systemPrefersDark = false;
  matchMediaSpied = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  setElectronApi(undefined);
  document.documentElement.className = '';
});

describe('themeSource 直写矩阵（缺陷①回归：system 不解析）', () => {
  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'system'],
  ])('preference %s is written through to themeSource as %s', (pref, expected) => {
    setSystemPrefersDark(false);
    const api = createElectronApi();
    setElectronApi(api);
    applyThemeToDocument(pref as ThemePreference);
    expect(api.setNativeThemeSource).toHaveBeenCalledTimes(1);
    expect(api.setNativeThemeSource).toHaveBeenCalledWith(expected);
  });

  it('system resolves the DOM class via media query only (system dark → .dark on)', () => {
    setSystemPrefersDark(true);
    const api = createElectronApi();
    setElectronApi(api);
    applyThemeToDocument('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(api.setNativeThemeSource).toHaveBeenCalledWith('system');
  });

  it('system resolves the DOM class via media query only (system light → .dark off)', () => {
    setSystemPrefersDark(false);
    applyThemeToDocument('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('resolveEffectiveTheme reads the media query for system', () => {
    setSystemPrefersDark(true);
    expect(resolveEffectiveTheme('system')).toBe('dark');
    setSystemPrefersDark(false);
    expect(resolveEffectiveTheme('system')).toBe('light');
  });
});

describe('titleBarOverlay hex 折算（缺陷②回归）', () => {
  it('sends dark tokens as sRGB hex on win32', () => {
    setSystemPrefersDark(false);
    const api = createElectronApi();
    setElectronApi(api);
    stubComputedTokens();
    document.documentElement.classList.add('dark');
    applyThemeToDocument('dark');
    expect(api.setTitleBarOverlay).toHaveBeenCalledWith('#0d0e14', '#f4f5f7');
  });

  it('sends light tokens as sRGB hex on win32', () => {
    setSystemPrefersDark(false);
    const api = createElectronApi();
    setElectronApi(api);
    stubComputedTokens();
    syncTitleBarOverlay();
    expect(api.setTitleBarOverlay).toHaveBeenCalledWith('#f1f2f4', '#1c1e25');
  });

  it('skips overlay sync on non-win32 platforms', () => {
    setSystemPrefersDark(false);
    const api = { ...createElectronApi(), platform: 'darwin' };
    setElectronApi(api);
    stubComputedTokens();
    syncTitleBarOverlay();
    expect(api.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('skips overlay IPC and logs when token values cannot be converted', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    setSystemPrefersDark(false);
    const api = createElectronApi();
    setElectronApi(api);
    stubComputedTokens({ '--background': 'not-a-color' });
    document.documentElement.classList.add('dark');
    applyThemeToDocument('dark');
    expect(api.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
  });
});

describe('useTheme hook', () => {
  it('setPreference persists and pushes themeSource; media change re-applies', () => {
    setSystemPrefersDark(false);
    const api = createElectronApi();
    setElectronApi(api);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe('dark'); // 出厂默认深色
    act(() => {
      result.current.setPreference('system');
    });
    expect(readThemePreference()).toBe('system');
    expect(api.setNativeThemeSource).toHaveBeenCalledWith('system');
    expect(mediaChangeListener).toBeDefined();
    // 系统切换为深色：媒询状态翻转 → change 事件 → 重应用 → DOM 转深，themeSource 仍直写 system
    // （jsdom 不暴露 MediaQueryListEvent 构造器，用单步结构断言造事件假体——tsc 接受该方向断言）
    act(() => {
      setSystemPrefersDark(true);
      mediaChangeListener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(api.setNativeThemeSource).toHaveBeenLastCalledWith('system');
  });
});

describe('令牌漂移守卫：globals.css 令牌 ↔ contracts 初始 overlay 常量', () => {
  const readBlockToken = (blockSelector: string, token: string): string => {
    const cssPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../app/globals.css',
    );
    const css = fs.readFileSync(cssPath, 'utf8');
    const blockPattern = new RegExp(
      `${blockSelector.replace(/[[\](){}?*+^$|\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    );
    const block = blockPattern.exec(css)?.[1];
    expect(block, `globals.css 中找不到 ${blockSelector} 块`).toBeDefined();
    const tokenPattern = new RegExp(`--${token}:\\s*([^;]+);`);
    const value = tokenPattern.exec(block ?? '')?.[1];
    expect(value, `${blockSelector} 块中找不到 --${token}`).toBeDefined();
    return (value ?? '').trim();
  };

  it('.dark 令牌折算结果必须等于 contracts 初始 overlay 常量（改令牌必须同步常量）', () => {
    expect(cssColorToHex(readBlockToken('.dark', 'background'))).toBe(
      HUB_INITIAL_TITLE_BAR_OVERLAY.color,
    );
    expect(cssColorToHex(readBlockToken('.dark', 'foreground'))).toBe(
      HUB_INITIAL_TITLE_BAR_OVERLAY.symbolColor,
    );
  });

  it(':root 令牌必须可折算为合法 hex（overlay 运行时同步的前提）', () => {
    expect(cssColorToHex(readBlockToken(':root', 'background'))).toMatch(/^#[0-9a-f]{6}$/i);
    expect(cssColorToHex(readBlockToken(':root', 'foreground'))).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('偏好持久化', () => {
  it('writeThemePreference/readThemePreference round-trips and rejects garbage', () => {
    writeThemePreference('system');
    expect(readThemePreference()).toBe('system');
    localStorage.setItem('hub:theme', 'bogus');
    expect(readThemePreference()).toBe('dark'); // 非法值回退默认深色
  });
});
