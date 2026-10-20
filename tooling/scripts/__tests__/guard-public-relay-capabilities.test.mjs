import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'tooling', 'scripts', 'guard-public-relay-capabilities.mjs');

/**
 * guard:public-relay-capabilities 的行为测试。
 *
 * 2026-10-20：校验对象由「已构建的能力包目录」改为「族模板产出的 sources」（模型能力包退场、
 * 包目录删除）。因此这里不再自造包目录，而是用 `--registry-json` 注入不同形态的 Backend
 * public relay 注册表，观察族模板声明的 targetType 是否被正确对账。
 *
 * 端点是否配置刻意不进断言：那是运行时的用户配置事实（2026-10-12 拍板），构建期只做
 * targetType 的结构对账。
 */

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const runGuard = (registryPath) =>
  spawnSync(process.execPath, ['--import', 'tsx', scriptPath, '--registry-json', registryPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

test('guard-public-relay-capabilities: 族模板声明的 targetType 都在注册表中即通过', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-public-relay-ok-'));
  const registryPath = path.join(tempDir, 'registry.json');
  // 全部 targetType 都登记（端点留空：端点不是构建期事实）
  writeJson(registryPath, {
    publicRelayTargets: {
      cloudflare_image_public_url: { endpoint: '' },
      self_hosted_image_public_url: { endpoint: '' },
    },
  });

  const result = runGuard(registryPath);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source=family-templates/);
  // 端点未配置不算错，但需求条数必须为正（否则门禁退化成空循环）
  const requirementCount = /publicRelayRequirements=(\d+)/.exec(result.stdout)?.[1];
  assert.ok(requirementCount !== undefined, 'stdout 必须报告需求条数');
  assert.ok(Number(requirementCount) > 0, '族模板扫描应产出至少一条公网中转需求');
});

test('guard-public-relay-capabilities: 注册表缺某个族声明的 targetType 时失败并点名', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-public-relay-missing-'));
  const registryPath = path.join(tempDir, 'registry.json');
  // 只登记 cloudflare：族模板里声明 self_hosted 的那几族必须被判红
  writeJson(registryPath, {
    publicRelayTargets: {
      cloudflare_image_public_url: { endpoint: '' },
    },
  });

  const result = runGuard(registryPath);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public_relay_target_unsupported/);
  assert.match(result.stderr, /targetType=self_hosted_image_public_url/);
  // 失败项必须能定位到具体族（package_id 在族模板口径下承载族 id）
  assert.match(result.stderr, /package_id=kling-image2video-v1/);
});
