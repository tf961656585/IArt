import { describe, expect, it } from 'vitest';
import cssColorModule from '@iart/utils/css-color';
const { cssColorToHex } = cssColorModule;

// 金值来源：Chromium 渲染像素实测（canvas getImageData，与 Electron 同源引擎），
// 与仓内既有 OKLab 公式（AgentToolProposalPanel.test.tsx parseColor）逐字节交叉一致。
describe('cssColorToHex — oklch 转换', () => {
  it('converts pure white/black exactly', () => {
    expect(cssColorToHex('oklch(1 0 0)')).toBe('#ffffff');
    expect(cssColorToHex('oklch(0 0 0)')).toBe('#000000');
  });

  it('converts Hub dark tokens (Chromium golden values)', () => {
    expect(cssColorToHex('oklch(0.165 0.012 277)')).toBe('#0d0e14');
    expect(cssColorToHex('oklch(0.97 0.003 277)')).toBe('#f4f5f7');
  });

  it('converts Hub light tokens (Chromium golden values)', () => {
    expect(cssColorToHex('oklch(0.96 0.003 277)')).toBe('#f1f2f4');
    expect(cssColorToHex('oklch(0.235 0.015 277)')).toBe('#1c1e25');
  });

  it('converts a mid-chroma reference value (Chromium golden)', () => {
    expect(cssColorToHex('oklch(0.5 0.1 120)')).toBe('#5c6b21');
  });

  it('supports percentage lightness and hue wrap-around', () => {
    expect(cssColorToHex('oklch(50% 0.1 120)')).toBe('#5c6b21');
    expect(cssColorToHex('oklch(1 0 480)')).toBe('#ffffff');
  });

  it('emits 8-digit hex for alpha values', () => {
    expect(cssColorToHex('oklch(1 0 0 / 0.5)')).toBe('#ffffff80');
    expect(cssColorToHex('oklch(1 0 0 / 50%)')).toBe('#ffffff80');
    expect(cssColorToHex('oklch(1 0 0 / 1)')).toBe('#ffffff');
  });
});

describe('cssColorToHex — hex/rgb 直通', () => {
  it('normalizes shorthand hex', () => {
    expect(cssColorToHex('#ABC')).toBe('#aabbcc');
    expect(cssColorToHex('#0d0e14')).toBe('#0d0e14');
    expect(cssColorToHex('#0D0E14CC')).toBe('#0d0e14cc');
  });

  it('normalizes legacy and modern rgb() syntax', () => {
    expect(cssColorToHex('rgb(13, 14, 20)')).toBe('#0d0e14');
    expect(cssColorToHex('rgb(13 14 20)')).toBe('#0d0e14');
    expect(cssColorToHex('rgba(255, 255, 255, 0.5)')).toBe('#ffffff80');
  });
});

describe('cssColorToHex — 非法输入', () => {
  it('returns null for unsupported formats (caller must not cross the native boundary)', () => {
    expect(cssColorToHex('red')).toBeNull();
    expect(cssColorToHex('')).toBeNull();
    expect(cssColorToHex('   ')).toBeNull();
    expect(cssColorToHex('oklch(bogus)')).toBeNull();
    expect(cssColorToHex('oklch(0.5 0.1)')).toBeNull();
    expect(cssColorToHex('oklch(0.5 0.1 120 / bogus)')).toBeNull();
    expect(cssColorToHex('hsl(120 50% 50%)')).toBeNull();
  });
});
