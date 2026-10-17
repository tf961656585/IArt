import { describe, expect, it } from 'vitest';
import {
  HUB_INITIAL_TITLE_BAR_OVERLAY,
  WINDOW_CHROME_IPC_CHANNELS,
  SetNativeThemeSourceRequestSchema,
  SetTitleBarOverlayRequestSchema,
  WINDOW_CHROME_INSETS,
} from '../src/window-chrome-ipc';

describe('WINDOW_CHROME_IPC_CHANNELS', () => {
  it('exposes set-title-bar-overlay channel name', () => {
    expect(WINDOW_CHROME_IPC_CHANNELS.SET_TITLE_BAR_OVERLAY).toBe('window:set-title-bar-overlay');
  });
});

describe('SetTitleBarOverlayRequestSchema', () => {
  // 边界格式裁定（spec §7.2）：Electron 的 CSS 颜色解析器（ParseCSSColor）只认
  // hex/rgb()/hsl()/named，oklch 会静默解析失败回落白色（2026-10-16 实证缺陷）。
  // 跨 IPC 与窗口构造的 overlay 颜色一律 sRGB hex；oklch 只允许存在于 CSS 令牌层，
  // 由 packages/utils 的共享转换函数在边界折算。
  it('accepts sRGB hex color strings (#rrggbb / #rrggbbaa)', () => {
    expect(
      SetTitleBarOverlayRequestSchema.parse({ color: '#0d0e14', symbolColor: '#f4f5f7' }),
    ).toEqual({ color: '#0d0e14', symbolColor: '#f4f5f7' });
    expect(
      SetTitleBarOverlayRequestSchema.parse({ color: '#0d0e14cc', symbolColor: '#f4f5f7ff' }),
    ).toEqual({ color: '#0d0e14cc', symbolColor: '#f4f5f7ff' });
  });

  it('rejects oklch strings (parse failure silently falls back to white in Electron)', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({
        color: 'oklch(0.165 0.012 277)',
        symbolColor: 'oklch(0.97 0.003 277)',
      }),
    ).toThrow();
  });

  it('rejects rgb()/named colors (boundary format is hex only)', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: 'rgb(13, 14, 20)', symbolColor: '#ffffff' }),
    ).toThrow();
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: 'white', symbolColor: '#ffffff' }),
    ).toThrow();
  });

  it('rejects empty color', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: '', symbolColor: '#ffffff' }),
    ).toThrow();
  });

  it('rejects empty symbolColor', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: '#000000', symbolColor: '' }),
    ).toThrow();
  });

  it('rejects missing color field', () => {
    expect(() => SetTitleBarOverlayRequestSchema.parse({ symbolColor: '#ffffff' })).toThrow();
  });

  it('rejects missing symbolColor field', () => {
    expect(() => SetTitleBarOverlayRequestSchema.parse({ color: '#000000' })).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: '#000000', symbolColor: '#ffffff', extra: 1 }),
    ).toThrow();
  });
});

describe('SetNativeThemeSourceRequestSchema', () => {
  // system 直写裁定（spec §7.5）：themeSource 是 app 级单值，会反向覆盖渲染端
  // prefers-color-scheme 媒询；把 system 解析成 light/dark 再推送会让媒询从此只读
  // 到被写死的值，「跟随系统」自锁失效（2026-10-16 实证缺陷①）。system 必须直写。
  it('accepts light/dark/system (system is written through, not resolved)', () => {
    expect(SetNativeThemeSourceRequestSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
    expect(SetNativeThemeSourceRequestSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(SetNativeThemeSourceRequestSchema.parse({ theme: 'system' })).toEqual({
      theme: 'system',
    });
  });

  it('rejects unknown theme values', () => {
    expect(() => SetNativeThemeSourceRequestSchema.parse({ theme: 'auto' })).toThrow();
    expect(() => SetNativeThemeSourceRequestSchema.parse({ theme: '' })).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() => SetNativeThemeSourceRequestSchema.parse({ theme: 'dark', extra: 1 })).toThrow();
  });
});

describe('HUB_INITIAL_TITLE_BAR_OVERLAY', () => {
  it('carries sRGB hex values for the default dark tokens', () => {
    expect(HUB_INITIAL_TITLE_BAR_OVERLAY.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(HUB_INITIAL_TITLE_BAR_OVERLAY.symbolColor).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('WINDOW_CHROME_INSETS', () => {
  it('exposes macosTrafficLightWidth', () => {
    expect(WINDOW_CHROME_INSETS.macosTrafficLightWidth).toBe(84);
  });

  it('exposes hubTopBandHeight as the single top-band token', () => {
    expect(WINDOW_CHROME_INSETS.hubTopBandHeight).toBe(56);
  });
});
