// @vitest-environment node
import { describe, expect, it } from 'vitest';

describe('desktop/utils/devtools-policy.cjs', () => {
  it('always enables devtools shortcuts even when packaged flags are absent', async () => {
    const { shouldEnableDevToolsShortcuts } = await import('../../apps/desktop-shell/dist/utils/devtools-policy.cjs') as {
      shouldEnableDevToolsShortcuts: () => boolean;
    };
    const previous = process.env['IART_DEVTOOLS'];
    process.env['IART_DEVTOOLS'] = '';
    expect(shouldEnableDevToolsShortcuts()).toBe(true);
    process.env['IART_DEVTOOLS'] = 'false';
    expect(shouldEnableDevToolsShortcuts()).toBe(true);
    if (typeof previous === 'undefined') {
      delete process.env['IART_DEVTOOLS'];
    } else {
      process.env['IART_DEVTOOLS'] = previous;
    }
  });
});
