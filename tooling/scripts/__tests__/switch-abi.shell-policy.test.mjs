import test from 'node:test';
import assert from 'node:assert/strict';

import { __test_only__ } from '../switch-abi.mjs';

test('shouldUseShellOnWindows: 非 Windows 返回 false', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    assert.equal(__test_only__.shouldUseShellOnWindows('pnpm'), false);
    assert.equal(__test_only__.shouldUseShellOnWindows('pnpm.cmd'), false);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
    }
  }
});

test('shouldUseShellOnWindows: Windows 下只对 pnpm/cmd/bat 开 shell', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(__test_only__.shouldUseShellOnWindows('pnpm'), true);
    assert.equal(__test_only__.shouldUseShellOnWindows('pnpm.cmd'), true);
    assert.equal(__test_only__.shouldUseShellOnWindows('pnpm.exe'), false);
    assert.equal(__test_only__.shouldUseShellOnWindows('foo.bat'), true);
    assert.equal(__test_only__.shouldUseShellOnWindows('electron.exe'), false);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
    }
  }
});
