import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyProbeFailure, probeBetterSqlite } from '../ensure-sqlite-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// 2026-11-10 实测原文（Node 25 上加载按 Node 24 编译的 better-sqlite3）。
const ABI_MISMATCH_STDERR = [
  '/path/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'was compiled against a different Node.js version using',
  'NODE_MODULE_VERSION 137. This version of Node.js requires',
  'NODE_MODULE_VERSION 141. Please try re-compiling or re-installing',
  'the module (for instance, using `npm rebuild` or `npm install`).',
].join('\n');

const makeTempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('只有 ABI 错配会被归类为可自动重建', () => {
  assert.equal(classifyProbeFailure(ABI_MISMATCH_STDERR), 'abi-mismatch');
  assert.equal(
    classifyProbeFailure("Error: Cannot find module 'better-sqlite3'"),
    'missing-module',
  );
  assert.equal(classifyProbeFailure('Error: out of memory'), 'other');
  assert.equal(classifyProbeFailure(''), 'other');
});

test('探测能真实打开内存库：用可控夹具验证成功路径', () => {
  const fixtureDir = makeTempDir('ensure-sqlite-ok-');
  const packageDir = path.join(fixtureDir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '0.0.0', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(packageDir, 'index.js'),
    'module.exports = class Database { constructor() {} close() {} };\n',
  );

  const probe = probeBetterSqlite({ cwd: fixtureDir });
  assert.equal(probe.ok, true, probe.stderr);
});

test('探测失败时透出原始 stderr，不静默', () => {
  const probe = probeBetterSqlite({ cwd: makeTempDir('ensure-sqlite-empty-') });
  assert.equal(probe.ok, false);
  assert.match(probe.stderr, /Cannot find module 'better-sqlite3'/);
  assert.equal(classifyProbeFailure(probe.stderr), 'missing-module');
});

test('仓库接线：后端测试入口先自愈原生模块 ABI', () => {
  const script = packageJson.scripts['test:backend'];
  assert.equal(
    script.startsWith('node ./tooling/scripts/ensure-sqlite-runtime.mjs &&'),
    true,
    `test:backend 必须以原生模块前置开头：${script}`,
  );
  assert.match(script, /node --import tsx --test/);
});
