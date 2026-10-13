import { afterEach, describe, expect, it, vi } from 'vitest';

import * as electronBridgeModule from '../electronBridge';
import type { ElectronBridge } from '../electronBridge';
import { revealTaskArchive } from '../electronBridge';

const setElectronBridge = (bridge: Partial<ElectronBridge>): void => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: bridge,
  });
};

describe('electronBridge task reveal helpers', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electron');
    vi.restoreAllMocks();
  });

  it('不再公开 legacy task reveal 导出', () => {
    expect(electronBridgeModule).not.toHaveProperty('revealRequestLog');
    expect(electronBridgeModule).not.toHaveProperty('revealJobResult');
    expect(electronBridgeModule).not.toHaveProperty('revealTaskRequestLog');
    expect(electronBridgeModule).not.toHaveProperty('revealTaskResult');
  });

  it('returns not-in-electron when task archive bridge is missing', async () => {
    const result = await revealTaskArchive('task-1', null);
    expect(result).toEqual({ ok: false, reason: 'not-in-electron' });
  });

  it('returns missing-task-id for blank task archive input', async () => {
    setElectronBridge({
      revealTaskArchive: async () => ({ ok: true, dir: '/tmp/task-archives' }),
    });

    const result = await revealTaskArchive('   ', null);
    expect(result).toEqual({ ok: false, reason: 'missing-task-id' });
  });

  it('delegates task archive reveal to preload bridge with taskId', async () => {
    const revealTaskArchiveMock = vi.fn(async () => ({ ok: true as const, dir: '/tmp/task-archives' }));
    setElectronBridge({
      revealTaskArchive: revealTaskArchiveMock,
    });

    await expect(revealTaskArchive('task-req-1', '/tmp/demo.iartproj')).resolves.toEqual({
      ok: true,
      dir: '/tmp/task-archives',
    });

    expect(revealTaskArchiveMock).toHaveBeenCalledWith('task-req-1', '/tmp/demo.iartproj');
  });
});
