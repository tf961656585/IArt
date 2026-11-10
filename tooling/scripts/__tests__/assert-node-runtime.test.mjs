import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSupportedNodeRuntime,
  formatUnsupportedRuntimeMessage,
  inspectNodeRuntime,
  parseSupportedMajors,
  readSupportedRange,
} from '../assert-node-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const vitestConfigPath = path.join(repoRoot, 'vitest.config.ts');
const nvmrcPath = path.join(repoRoot, '.nvmrc');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

test('engines.node 只以主版本表达受支持的测试运行时', () => {
  assert.deepEqual(parseSupportedMajors('22.x || 24.x'), [22, 24]);
  assert.throws(() => parseSupportedMajors('>=22'), /只支持/);
  assert.throws(() => parseSupportedMajors(''), /为空/);
});

test('版本判定按主版本匹配，不依赖补丁号', () => {
  const supported = inspectNodeRuntime({ version: 'v24.13.0', supportedRange: '22.x || 24.x' });
  assert.equal(supported.ok, true);
  assert.equal(supported.major, 24);

  const unsupported = inspectNodeRuntime({ version: 'v25.6.0', supportedRange: '22.x || 24.x' });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.major, 25);
});

test('不受支持时给出可直接执行的切换指引', () => {
  const message = formatUnsupportedRuntimeMessage({ version: 'v25.6.0', range: '22.x || 24.x' });
  assert.match(message, /v25\.6\.0/);
  assert.match(message, /22\.x \|\| 24\.x/);
  assert.match(message, /nvm use 24/);
  assert.match(message, /139/);
});

test('assertSupportedNodeRuntime 在不支持版本上抛错、在支持版本上放行', () => {
  assert.throws(
    () => assertSupportedNodeRuntime({ version: 'v25.6.0', supportedRange: '22.x || 24.x' }),
    (error) => error.code === 'ERR_UNSUPPORTED_TEST_NODE_RUNTIME',
  );
  const result = assertSupportedNodeRuntime({ version: 'v24.13.0', supportedRange: '22.x || 24.x' });
  assert.equal(result.ok, true);
});

test('仓库配置：engines / .nvmrc / 测试脚本 / vitest globalSetup 四处一致', () => {
  const supportedMajors = parseSupportedMajors(readSupportedRange(packageJsonPath));

  // .nvmrc 必须指向受支持主版本，避免「装了 nvm 也切到不受支持的线」。
  const nvmrcMajor = Number(fs.readFileSync(nvmrcPath, 'utf8').trim().replace(/^v/, '').split('.')[0]);
  assert.equal(
    supportedMajors.includes(nvmrcMajor),
    true,
    `.nvmrc 指向 Node ${nvmrcMajor}，不在 engines.node 支持清单 [${supportedMajors.join(', ')}] 内`,
  );

  // 两个会构建后再跑 vitest 的入口必须把运行时前置放在第一位（避免白跑几分钟构建）。
  const guardCommand = 'node ./tooling/scripts/assert-node-runtime.mjs &&';
  for (const scriptName of ['test', 'test:integration']) {
    assert.equal(
      packageJson.scripts[scriptName].startsWith(guardCommand),
      true,
      `${scriptName} 必须以运行时前置开头：${guardCommand}`,
    );
  }

  // 绕过 package 脚本直接跑 vitest（npx vitest run / pnpm test:watch）时也要被拦住。
  assert.match(fs.readFileSync(vitestConfigPath, 'utf8'), /globalSetup:\s*\[[^\]]*assert-node-runtime\.mjs/);
});
