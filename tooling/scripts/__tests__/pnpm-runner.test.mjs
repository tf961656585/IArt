import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPnpmSpawnTarget,
  resolvePnpmCommand,
  shouldUseShellOnWindows,
} from '../../lib/pnpm-runner.mjs';

test('resolvePnpmCommand defaults to pnpm and allows an explicit override', () => {
  assert.equal(resolvePnpmCommand({}), 'pnpm');
  assert.equal(resolvePnpmCommand({ IART_PNPM_COMMAND: 'C:/tools/pnpm.exe' }), 'C:/tools/pnpm.exe');
  assert.equal(resolvePnpmCommand({ IART_PNPM_COMMAND: '  ' }), 'pnpm');
});

test('shouldUseShellOnWindows supports pnpm exe/cmd/bat install shapes', () => {
  assert.equal(shouldUseShellOnWindows('pnpm', 'win32'), true);
  assert.equal(shouldUseShellOnWindows('pnpm.cmd', 'win32'), true);
  assert.equal(shouldUseShellOnWindows('pnpm.exe', 'win32'), false);
  assert.equal(shouldUseShellOnWindows('C:/tools/pnpm.exe', 'win32'), false);
  assert.equal(shouldUseShellOnWindows('C:/tools/pnpm.cmd', 'win32'), true);
  assert.equal(shouldUseShellOnWindows('pnpm', 'linux'), false);
});

test('buildPnpmSpawnTarget resolves command once and keeps caller spawn options', () => {
  const target = buildPnpmSpawnTarget({
    cwd: 'C:/repo',
    stdio: 'inherit',
    env: { IART_PNPM_COMMAND: 'pnpm.exe' },
  });

  assert.equal(target.command, 'pnpm.exe');
  assert.equal(target.options.cwd, 'C:/repo');
  assert.equal(target.options.stdio, 'inherit');
  assert.equal(target.options.shell, false);
});

