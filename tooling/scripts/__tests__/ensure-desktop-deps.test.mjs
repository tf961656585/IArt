import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureBetterSqlite3, ensureFfmpegStatic } from '../../dev/ensure-desktop-deps.mjs';

test('ensureBetterSqlite3: Node/Electron 隔离运行时已就绪时直接成功', () => {
  const runCalls = [];
  const activateCalls = [];
  const logs = [];

  const ok = ensureBetterSqlite3({
    probeInNode: () => true,
    probeInElectron: () => true,
    runCommand: (...args) => {
      runCalls.push(args);
      return true;
    },
    activateBetterSqlite3: (...args) => {
      activateCalls.push(args);
      return '/fake/native-modules/better-sqlite3/node';
    },
    logFn: (message) => logs.push(message),
    errorFn: () => {},
    pnpmCmd: 'pnpm',
  });

  assert.equal(ok, true);
  assert.equal(runCalls.length, 0);
  assert.equal(activateCalls.length, 0);
  assert.equal(logs.includes('better-sqlite3（Node/Electron 隔离运行时）已就绪。'), true);
});

test('ensureBetterSqlite3: 首次失败后走缓存层修复并复检', () => {
  const runCalls = [];
  const activateCalls = [];
  const nodeProbeResults = [false, true];
  const electronProbeResults = [true];

  const ok = ensureBetterSqlite3({
    probeInNode: () => nodeProbeResults.shift() ?? false,
    probeInElectron: () => electronProbeResults.shift() ?? false,
    runCommand: (...args) => {
      runCalls.push(args);
      return true;
    },
    activateBetterSqlite3: (...args) => {
      activateCalls.push(args);
      return '/fake/native-modules/better-sqlite3/node';
    },
    logFn: () => {},
    errorFn: () => {},
    pnpmCmd: 'pnpm',
  });

  assert.equal(ok, true);
  // 修复路径的注入点是 activate 函数：node 与 electron 两个运行时各激活一次。
  assert.equal(activateCalls.length, 2);
  assert.deepEqual(
    activateCalls.map(([arg]) => arg.runtime),
    ['node', 'electron'],
  );
  for (const [arg] of activateCalls) {
    assert.equal(arg.platform, process.platform);
    assert.equal(arg.arch, process.arch);
    assert.equal(typeof arg.buildFn, 'function');
  }
  // buildFn 内部仍调既有 sqlite:prepare，且两个运行时共享同一次编译。
  assert.equal(runCalls.length, 0, 'activate 被 mock 未触发 buildFn 时不应有编译命令');
  assert.equal(activateCalls[0][0].buildFn(), true);
  assert.equal(activateCalls[1][0].buildFn(), true, 'buildFn 只执行一次，重复调用返回缓存结果');
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], [
    'pnpm',
    ['run', 'sqlite:prepare', '--', '--verify'],
    'pnpm run sqlite:prepare -- --verify',
  ]);
});

test('ensureBetterSqlite3: 修复失败时返回 false 并输出错误', () => {
  const errors = [];

  const ok = ensureBetterSqlite3({
    probeInNode: () => false,
    probeInElectron: () => false,
    runCommand: () => false,
    activateBetterSqlite3: ({ buildFn }) => (buildFn() ? '/fake' : null),
    logFn: () => {},
    errorFn: (message) => errors.push(message),
    pnpmCmd: 'pnpm',
  });

  assert.equal(ok, false);
  assert.equal(errors.length, 2);
  assert.equal(errors[0], 'better-sqlite3 在 Node/Electron 隔离运行时仍不可用。');
});

test('ensureBetterSqlite3: 修复后复检仍失败时返回 false', () => {
  const errors = [];
  const nodeProbeResults = [false, false];
  const electronProbeResults = [];

  const ok = ensureBetterSqlite3({
    probeInNode: () => nodeProbeResults.shift() ?? false,
    probeInElectron: () => electronProbeResults.shift() ?? false,
    runCommand: () => true,
    activateBetterSqlite3: () => '/fake',
    logFn: () => {},
    errorFn: (message) => errors.push(message),
    pnpmCmd: 'pnpm',
  });

  assert.equal(ok, false);
  assert.equal(errors.length, 2);
});

const hostMachoArchs = process.arch === 'arm64' ? 'arm64' : 'x86_64';

const makeFfmpegReadyDeps = (overrides = {}) => ({
  resolveFfmpegPath: () => '/fake/node_modules/ffmpeg-static/ffmpeg',
  fileMachoArch: () => hostMachoArchs,
  probeFfmpegExecution: () => ({ ok: true, message: 'ffmpeg version fake' }),
  activateFfmpeg: () => null,
  fs: {
    existsSync: () => true,
    statSync: () => ({ size: 70_000_000 }),
  },
  ...overrides,
});

test('ensureFfmpegStatic: 当前二进制就绪时不触发激活/下载', () => {
  let activateCalls = 0;

  const ok = ensureFfmpegStatic({
    deps: makeFfmpegReadyDeps({
      activateFfmpeg: () => {
        activateCalls += 1;
        return '/fake/node_modules/ffmpeg-static/ffmpeg';
      },
    }),
  });

  assert.equal(ok, true);
  assert.equal(activateCalls, 0, '已就绪时不得调用 activateFfmpeg（即零网络）');
});

test('ensureFfmpegStatic: 二进制缺失时经缓存层激活并复检', () => {
  const activateArgs = [];
  let resolveCalls = 0;

  const ok = ensureFfmpegStatic({
    targetArch: 'x64',
    deps: makeFfmpegReadyDeps({
      resolveFfmpegPath: () => {
        resolveCalls += 1;
        // 第一次解析时缺失，激活后恢复。
        return resolveCalls === 1 ? null : '/fake/node_modules/ffmpeg-static/ffmpeg';
      },
      fileMachoArch: () => 'x86_64',
      activateFfmpeg: (arg) => {
        activateArgs.push(arg);
        return '/fake/node_modules/ffmpeg-static/ffmpeg';
      },
    }),
  });

  assert.equal(ok, true);
  assert.equal(activateArgs.length, 1);
  assert.deepEqual(activateArgs[0], { platform: process.platform, arch: 'x64' });
});

test('ensureFfmpegStatic: 缓存层获取失败时返回 false', () => {
  const ok = ensureFfmpegStatic({
    deps: makeFfmpegReadyDeps({
      resolveFfmpegPath: () => null,
      activateFfmpeg: () => null,
    }),
  });

  assert.equal(ok, false);
});
