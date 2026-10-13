import { afterEach, describe, expect, it, vi } from 'vitest';

import { revealTaskArchive } from '@iart/backend-sdk/electron-bridge';

describe('backend-sdk revealTaskArchive', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electron');
    vi.restoreAllMocks();
  });

  it('logs warning when task archive reveal returns non-ok result', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        revealTaskArchive: vi.fn(async () => ({ ok: false as const, reason: 'missing-project-path' })),
      },
    });

    await expect(revealTaskArchive('task-log-1', '/tmp/demo.iartproj')).resolves.toEqual({
      ok: false,
      reason: 'missing-project-path',
    });

    expect(warnSpy).toHaveBeenCalledWith('revealTaskArchive: request failed', {
      taskId: 'task-log-1',
      projectPath: '/tmp/demo.iartproj',
      reason: 'missing-project-path',
      result: { ok: false, reason: 'missing-project-path' },
    });
  });
});
