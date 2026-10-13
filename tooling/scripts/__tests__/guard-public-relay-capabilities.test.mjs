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

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writePublicRelayPackage = (packagesDir, packageId, modelId, targetType) => {
  const packageDir = path.join(packagesDir, packageId);
  writeJson(path.join(packageDir, 'manifest.json'), {
    package_id: packageId,
    entry_model: { model_id: modelId, relative_path: 'runtime_model.json' },
    node_definition: { relative_path: 'node_definition.json' },
    resources: [],
  });
  writeJson(path.join(packageDir, 'runtime_model.json'), {
    model_id: modelId,
    runtime: {
      url_input_upload_mode: 'public_relay',
      url_input_upload_target_type: targetType,
      payload_rules: {
        'body.images': {
          kind: 'field',
          field_key: 'images',
          media_target: 'public_url',
          transforms: ['extractUrls'],
        },
      },
    },
  });
};

const runGuard = ({ packagesDir, registryPath }) =>
  spawnSync(process.execPath, [
    scriptPath,
    '--packages-dir',
    packagesDir,
    '--registry-json',
    registryPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

test('guard-public-relay-capabilities: 官方包所需 targetType 在注册表中即通过（端点可不配置）', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-public-relay-ok-'));
  const packagesDir = path.join(tempDir, 'packages');
  const registryPath = path.join(tempDir, 'registry.json');
  writePublicRelayPackage(packagesDir, 'pkg-ok', 'model-ok', 'self_hosted_image_public_url');
  writeJson(registryPath, {
    publicRelayTargets: {
      self_hosted_image_public_url: { endpoint: '' },
    },
  });

  const result = runGuard({ packagesDir, registryPath });
  fs.rmSync(tempDir, { recursive: true, force: true });

  // 端点是否配置是运行时的用户配置事实（用户自带语义），构建期守卫只做结构对账。
  assert.equal(result.status, 0);
  assert.match(result.stdout, /publicRelayRequirements=1/);
  assert.match(result.stdout, /targetTypes=self_hosted_image_public_url/);
});

test('guard-public-relay-capabilities: 缺失 targetType 时失败并列出 package 与 model', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-public-relay-missing-'));
  const packagesDir = path.join(tempDir, 'packages');
  const registryPath = path.join(tempDir, 'registry.json');
  writePublicRelayPackage(packagesDir, 'pkg-missing', 'model-missing', 'self_hosted_image_public_url');
  writeJson(registryPath, {
    publicRelayTargets: {
      cloudflare_image_public_url: { endpoint: 'https://relay.example.com/upload' },
    },
  });

  const result = runGuard({ packagesDir, registryPath });
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package_id=pkg-missing/);
  assert.match(result.stderr, /model_id=model-missing/);
  assert.match(result.stderr, /targetType=self_hosted_image_public_url/);
  assert.match(result.stderr, /public_relay_target_unsupported/);
});
