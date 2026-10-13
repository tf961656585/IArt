// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const taskMessageChannelEntry = `${workspaceRoot}/apps/desktop-shell/dist/task-message-channel.cjs`;

type TaskMessageChannelModule = {
  resolveTaskStateRendererChannel: (message: unknown) => string;
};

const loadTaskMessageChannelModule = (): TaskMessageChannelModule =>
  requireDesktop(taskMessageChannelEntry) as TaskMessageChannelModule;

describe('task message channel', () => {
  beforeAll(() => {
    if (!existsSync(taskMessageChannelEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('snapshot 走 task:state-snapshot 通道', () => {
    const { resolveTaskStateRendererChannel } = loadTaskMessageChannelModule();
    expect(resolveTaskStateRendererChannel({ type: 'task:state-snapshot' })).toBe(
      'task:state-snapshot',
    );
  });

  it('media asset 变更走 media-assets:changed 通道', () => {
    const { resolveTaskStateRendererChannel } = loadTaskMessageChannelModule();
    expect(resolveTaskStateRendererChannel({ type: 'media-assets:changed' })).toBe(
      'media-assets:changed',
    );
  });

  it('changed 和未知消息走 task:state-changed 通道', () => {
    const { resolveTaskStateRendererChannel } = loadTaskMessageChannelModule();
    expect(resolveTaskStateRendererChannel({ type: 'task:state-changed' })).toBe(
      'task:state-changed',
    );
    expect(resolveTaskStateRendererChannel({ type: 'unknown' })).toBe('task:state-changed');
  });
});
