import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const createProjectFolder = (rootDir: string, name: string) => {
  const projectPath = path.join(rootDir, `${name}.iartproj`);
  const mediaDir = path.join(projectPath, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name }, null, 2),
    'utf-8',
  );
  return { projectPath, mediaDir };
};

void test('project-media-scope: resolveRuntimeProjectPathByRef resolves V2 stableProjectId (spid_) via scopeShadowTable', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-spid-'));
  const project = createProjectFolder(tempDir, 'project-spid');

  const { syncProjectScope, resolveRuntimeProjectPathByRef, clearRuntimeProjectScopesForTest } =
    await import('../project-media-scope.cts');

  const stableProjectId = 'spid_0123456789abcdef01234567';
  const projectRef = 'prj_0123456789abcdef0123456789abcdef';
  syncProjectScope({ stableProjectId, projectPath: project.projectPath, projectRef });

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // 索引对称化：按 spid_ 能查到 projectPath（之前只查 V1 projectPathByRef，spid_ 查不到）
  const resolved = resolveRuntimeProjectPathByRef(stableProjectId);
  assert.equal(resolved, project.projectPath);
});

void test('project-media-scope: resolveRuntimeProjectPathByRef resolves V1 projectRef (prj_) via refToStableId then fallback', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-prj-'));
  const project = createProjectFolder(tempDir, 'project-prj');

  const { syncProjectScope, resolveRuntimeProjectPathByRef, clearRuntimeProjectScopesForTest } =
    await import('../project-media-scope.cts');

  const stableProjectId = 'spid_aabbccddeeff001122334455';
  const projectRef = 'prj_0123456789abcdef0123456789abcdef';
  syncProjectScope({ stableProjectId, projectPath: project.projectPath, projectRef });

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // V1 prj_ 先经 refToStableId 反查走 V2 索引
  const resolved = resolveRuntimeProjectPathByRef(projectRef);
  assert.equal(resolved, project.projectPath);
});

void test('project-media-scope: resolveRuntimeProjectPathByRef falls back to V1 projectPathByRef when shadow table not synced', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-fallback-'));
  const project = createProjectFolder(tempDir, 'project-fallback');

  const { registerRuntimeProjectScope, resolveRuntimeProjectPathByRef, clearRuntimeProjectScopesForTest } =
    await import('../project-media-scope.cts');

  // registerRuntimeProjectScope 写入 V1-only 条目（无 stableProjectId IPC 同步）
  const registered = registerRuntimeProjectScope(project.projectPath);
  assert.ok(registered);
  const projectRef = registered.projectRef;

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // refToStableId 无条目，fallback 直接查 projectPathByRef
  const resolved = resolveRuntimeProjectPathByRef(projectRef);
  assert.equal(resolved, project.projectPath);
});

void test('project-media-scope: resolveRuntimeProjectPathByRef returns null for unregistered spid_', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-unreg-'));
  const { clearRuntimeProjectScopesForTest, resolveRuntimeProjectPathByRef } =
    await import('../project-media-scope.cts');

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const resolved = resolveRuntimeProjectPathByRef('spid_ffffffffffffffffffffffff');
  assert.equal(resolved, null);
});

void test('project-media-scope: resolveRuntimeProjectPathByRef returns null for invalid scope', async (t) => {
  const { clearRuntimeProjectScopesForTest, resolveRuntimeProjectPathByRef } =
    await import('../project-media-scope.cts');

  t.after(() => {
    clearRuntimeProjectScopesForTest();
  });

  assert.equal(resolveRuntimeProjectPathByRef('random'), null);
  assert.equal(resolveRuntimeProjectPathByRef(''), null);
});
