import { afterEach, describe, expect, it } from 'vitest';

import type { ElectronBridge } from '../electronBridge';
import { revealFilesUrl } from '../electronBridge';

const setElectronBridge = (bridge: Partial<ElectronBridge>): void => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: bridge,
  });
};

describe('electronBridge.revealFilesUrl', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electron');
  });

  it('returns not-in-electron when window.electron is missing', async () => {
    const result = await revealFilesUrl('/files/a.png', null);
    expect(result).toEqual({ ok: false, reason: 'not-in-electron' });
  });

  it('returns missing-url for blank input', async () => {
    setElectronBridge({
      revealFilesUrl: async () => ({
        ok: true,
        fileKey: 'a.png',
        dir: '/tmp/media',
        filePath: '/tmp/media/a.png',
      }),
    });
    const result = await revealFilesUrl('   ', null);
    expect(result).toEqual({ ok: false, reason: 'missing-url' });
  });
});
