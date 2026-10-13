import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  statePath,
  workspaceFingerprint,
  loadState,
  saveState,
  assertWorkspaceBinding,
  runStage,
} from '../release-stage-state.mjs';

const silent = () => {};

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'release-stage-state-test-'));

const makeState = (overrides = {}) => ({
  schemaVersion: 1,
  version: '0.6.0',
  platform: 'darwin',
  fingerprint: { commitSha: 'abc123', dirtyHash: '' },
  stages: {},
  ...overrides,
});

test('statePath: 指向 .cache/desktop-release-state/<version>-<platform>.json', () => {
  const p = statePath({ version: '0.6.0', platform: 'darwin' });
  assert.equal(p.endsWith(path.join('.cache', 'desktop-release-state', '0.6.0-darwin.json')), true);
});

test('workspaceFingerprint: 干净工作区 dirtyHash 为空串', () => {
  const fp = workspaceFingerprint({
    runner: (args) => (args[0] === 'rev-parse' ? 'abc123\n' : ''),
  });
  assert.deepEqual(fp, { commitSha: 'abc123', dirtyHash: '' });
});

test('workspaceFingerprint: 脏工作区 dirtyHash 为 status+diff 的 sha1', () => {
  const status = ' M file.txt\n';
  const diff = 'diff --git a/file.txt b/file.txt\n';
  const fp = workspaceFingerprint({
    runner: (args) => {
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return status;
      if (args[0] === 'diff') return diff;
      return '';
    },
  });
  assert.equal(fp.commitSha, 'abc123');
  assert.equal(fp.dirtyHash, crypto.createHash('sha1').update(`${status}${diff}`).digest('hex'));
});

test('loadState/saveState: 缺失返回 null，写入后可回读', () => {
  const tempDir = makeTempDir();
  const filePath = path.join(tempDir, 'nested', 'state.json');

  assert.equal(loadState(filePath), null);

  const state = makeState();
  saveState(filePath, state);
  assert.deepEqual(loadState(filePath), state);
});

test('assertWorkspaceBinding: 无状态或指纹一致时放行', () => {
  assert.doesNotThrow(() => assertWorkspaceBinding(null, { commitSha: 'a', dirtyHash: '' }));
  const state = makeState();
  assert.doesNotThrow(() =>
    assertWorkspaceBinding(state, { commitSha: 'abc123', dirtyHash: '' }),
  );
});

test('assertWorkspaceBinding: commit 不一致时拒绝并指明 --force 口径', () => {
  const state = makeState();
  assert.throws(
    () => assertWorkspaceBinding(state, { commitSha: 'def456', dirtyHash: '' }),
    (err) => {
      assert.match(err.message, /版本 0\.6\.0 已有基于 abc123 的发布进度/);
      assert.match(err.message, /当前工作区为 def456/);
      assert.match(err.message, /--force/);
      assert.match(err.message, /只重置进度，不跳过任何门禁/);
      return true;
    },
  );
});

test('assertWorkspaceBinding: 脏工作区不一致时注明含未提交改动', () => {
  const state = makeState();
  assert.throws(
    () => assertWorkspaceBinding(state, { commitSha: 'abc123', dirtyHash: 'deadbeef' }),
    /含未提交改动/,
  );
});

test('runStage: isDone 命中时跳过，不执行 run', async () => {
  const state = makeState();
  let runCalls = 0;
  const logs = [];

  const result = await runStage(state, 'preflight', {
    isDone: () => true,
    run: () => {
      runCalls += 1;
    },
    log: (m) => logs.push(m),
  });

  assert.equal(result.skipped, true);
  assert.equal(runCalls, 0);
  assert.equal(state.stages.preflight, undefined, '跳过不得写入 done 记录');
});

test('runStage: 默认 isDone 按状态记录判定', async () => {
  const state = makeState({
    stages: { deps: { status: 'done', startedAt: 't', finishedAt: 't', durationMs: 1 } },
  });
  let runCalls = 0;

  const result = await runStage(state, 'deps', {
    run: () => {
      runCalls += 1;
    },
    log: silent,
  });

  assert.equal(result.skipped, true);
  assert.equal(runCalls, 0);
});

test('runStage: 执行成功写入 done 记录（含耗时与元数据）并立即落盘', async () => {
  const state = makeState();
  const persisted = [];
  let tick = 1000;

  const result = await runStage(state, 'build:darwin-arm64', {
    run: () => ({ artifacts: [{ name: 'a.dmg', sha512: 'x' }] }),
    persist: () => persisted.push(JSON.parse(JSON.stringify(state))),
    now: () => (tick += 500),
    log: silent,
  });

  assert.equal(result.skipped, false);
  const record = state.stages['build:darwin-arm64'];
  assert.equal(record.status, 'done');
  assert.equal(record.durationMs, 500);
  assert.equal(record.startedAt, new Date(1500).toISOString());
  assert.equal(record.finishedAt, new Date(2000).toISOString());
  assert.deepEqual(record.artifacts, [{ name: 'a.dmg', sha512: 'x' }]);
  assert.equal(persisted.length, 1, '成功后必须立即落盘');
  assert.equal(persisted[0].stages['build:darwin-arm64'].status, 'done');
});

test('runStage: run 失败不落 done 记录，重跑可恢复', async () => {
  const state = makeState();
  let persistCalls = 0;

  await assert.rejects(
    runStage(state, 'upload:darwin-x64', {
      run: () => {
        throw new Error('network boom');
      },
      persist: () => {
        persistCalls += 1;
      },
      log: silent,
    }),
    /network boom/,
  );

  assert.equal(state.stages['upload:darwin-x64'], undefined, '失败不得写入 done 记录');
  assert.equal(persistCalls, 0);

  // 重跑同一 stage 可恢复执行。
  const retry = await runStage(state, 'upload:darwin-x64', {
    run: () => ({ uploaded: true }),
    log: silent,
  });
  assert.equal(retry.skipped, false);
  assert.equal(state.stages['upload:darwin-x64'].status, 'done');
});
