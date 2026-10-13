import { describe, expect, it } from 'vitest';
import {
  WINDOW_CHROME_IPC_CHANNELS,
  SetTitleBarOverlayRequestSchema,
  WINDOW_CHROME_INSETS,
} from '../src/window-chrome-ipc';

describe('WINDOW_CHROME_IPC_CHANNELS', () => {
  it('exposes set-title-bar-overlay channel name', () => {
    expect(WINDOW_CHROME_IPC_CHANNELS.SET_TITLE_BAR_OVERLAY).toBe('window:set-title-bar-overlay');
  });
});

describe('SetTitleBarOverlayRequestSchema', () => {
  it('accepts oklch color strings', () => {
    expect(
      SetTitleBarOverlayRequestSchema.parse({
        color: 'oklch(0.165 0.012 277)',
        symbolColor: 'oklch(0.97 0.003 277)',
      }),
    ).toEqual({
      color: 'oklch(0.165 0.012 277)',
      symbolColor: 'oklch(0.97 0.003 277)',
    });
  });

  it('accepts hex color strings', () => {
    expect(
      SetTitleBarOverlayRequestSchema.parse({ color: '#0a0a0a', symbolColor: '#ffffff' }),
    ).toEqual({ color: '#0a0a0a', symbolColor: '#ffffff' });
  });

  it('rejects empty color', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: '', symbolColor: '#fff' }),
    ).toThrow();
  });

  it('rejects empty symbolColor', () => {
    expect(() => SetTitleBarOverlayRequestSchema.parse({ color: '#000', symbolColor: '' })).toThrow();
  });

  it('rejects missing color field', () => {
    expect(() => SetTitleBarOverlayRequestSchema.parse({ symbolColor: '#fff' })).toThrow();
  });

  it('rejects missing symbolColor field', () => {
    expect(() => SetTitleBarOverlayRequestSchema.parse({ color: '#000' })).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() =>
      SetTitleBarOverlayRequestSchema.parse({ color: '#000', symbolColor: '#fff', extra: 1 }),
    ).toThrow();
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
