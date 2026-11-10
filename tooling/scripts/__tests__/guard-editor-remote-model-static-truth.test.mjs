import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guardPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'guard-editor-remote-model-static-truth.mjs',
);

const writeTree = (root, files) => {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
};

const runGuard = (root) =>
  spawnSync(process.execPath, [guardPath, '--root', root], { encoding: 'utf8' });

test('干净树通过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-truth-clean-'));
  writeTree(root, {
    'apps/editor/src/features/models/model.ts': 'export const modelLabel = "x";\n',
  });

  const result = runGuard(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /通过/);
});

test('旧的静态模型常量回流即失败', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-truth-legacy-'));
  writeTree(root, {
    'apps/editor/src/features/models/model.ts': 'export const MODEL_OPTIONS = [];\n',
  });

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[legacy-constant:MODEL_OPTIONS\]/);
});

test('硬编码 modelId 字面量失败，测试文件豁免', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-truth-modelid-'));
  writeTree(root, {
    'apps/editor/src/features/models/a.ts': "const config = { modelId: 'some-remote-model' };\n",
    'apps/editor/src/features/models/__tests__/a.test.ts': "const config = { modelId: 'some-remote-model' };\n",
  });

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[hardcoded-modelId\] \/apps\/editor\/src\/features\/models\/a\.ts:1/);
  assert.doesNotMatch(result.stderr, /__tests__\/a\.test\.ts/);
});
