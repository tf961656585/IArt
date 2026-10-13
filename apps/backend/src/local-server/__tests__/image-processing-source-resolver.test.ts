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

const writeMediaFile = (mediaDir: string, fileKey: string, content = 'image') => {
  const targetPath = path.join(mediaDir, fileKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  return targetPath;
};

const readErrorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';

const readErrorStatus = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 0;

const assertSourceError = (error: unknown, code: string, status: number) => {
  assert.equal(readErrorCode(error), code);
  assert.equal(readErrorStatus(error), status);
};

void test('image-processing-source-resolver: resolves local-media:// URL with project scope', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-processing-source-'));
  const project = createProjectFolder(tempDir, 'project-a');
  const fileKey = 'nested/source.png';
  const sourceFilePath = writeMediaFile(project.mediaDir, fileKey);

  const { resolveImageProcessingSource } = await import('../image-processing-source-resolver.cts');
  const { registerRuntimeProjectScope } = await import('../project-media-scope.cts');

  const registered = registerRuntimeProjectScope(project.projectPath);
  assert.ok(registered);
  const projectRef = registered.projectRef;

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const localMedia = resolveImageProcessingSource(
    project.projectPath,
    `local-media://${projectRef}/${fileKey}`,
  );
  assert.equal(localMedia.sourceFileKey, fileKey);
  assert.equal(localMedia.sourceFilePath, sourceFilePath);
  assert.equal(localMedia.mediaDir, project.mediaDir);
  assert.equal(localMedia.projectPath, project.projectPath);
});

void test('image-processing-source-resolver: resolves local-media:// URL with __global__ scope', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-processing-source-global-'));
  const globalMediaDir = path.join(tempDir, 'media');
  fs.mkdirSync(globalMediaDir, { recursive: true });
  const fileKey = 'global-characters/char.png';
  const sourceFilePath = writeMediaFile(globalMediaDir, fileKey);

  const { resolveImageProcessingSource } = await import('../image-processing-source-resolver.cts');
  const { registerGlobalMediaScope, clearRuntimeProjectScopesForTest } = await import('../project-media-scope.cts');

  const registered = registerGlobalMediaScope(globalMediaDir);
  assert.ok(registered);

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = resolveImageProcessingSource(
    '',
    `local-media://__global__/${fileKey}`,
  );
  assert.equal(result.sourceFileKey, fileKey);
  assert.equal(result.sourceFilePath, sourceFilePath);
  assert.equal(result.mediaDir, globalMediaDir);
});

void test('image-processing-source-resolver: resolves local-media:// URL with V2 stableProjectId (spid_) scope', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-processing-source-v2-'));
  const project = createProjectFolder(tempDir, 'project-v2');
  const fileKey = 'processed/tile.png';
  const sourceFilePath = writeMediaFile(project.mediaDir, fileKey);

  const { resolveImageProcessingSource } = await import('../image-processing-source-resolver.cts');
  const { syncProjectScope, clearRuntimeProjectScopesForTest } = await import('../project-media-scope.cts');

  // V2 scope：用 syncProjectScope 注册完整 scope 影子表（stableProjectId + projectPath + projectRef）
  const stableProjectId = 'spid_0123456789abcdef01234567';
  const projectRef = 'prj_0123456789abcdef0123456789abcdef';
  const shadow = syncProjectScope({ stableProjectId, projectPath: project.projectPath, projectRef });
  assert.ok(shadow);

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // 对 V2 spid_ URL 执行图像处理源解析，必须成功（不再抛 INVALID_URL）
  const result = resolveImageProcessingSource(
    project.projectPath,
    `local-media://${stableProjectId}/${fileKey}`,
  );
  assert.equal(result.sourceFileKey, fileKey);
  assert.equal(result.sourceFilePath, sourceFilePath);
  assert.equal(result.mediaDir, project.mediaDir);
  assert.equal(result.projectPath, project.projectPath);
});

void test('image-processing-source-resolver: second operation on V2 tile does not throw INVALID_URL', async (t) => {
  // 模拟 smart-split 二次操作：对 V2 URL 的 tile 再次 resolve
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-processing-source-v2-second-'));
  const project = createProjectFolder(tempDir, 'project-v2-second');
  const tileFileKey = 'processed/tile0.png';
  const sourceFilePath = writeMediaFile(project.mediaDir, tileFileKey);

  const { resolveImageProcessingSource } = await import('../image-processing-source-resolver.cts');
  const { syncProjectScope, clearRuntimeProjectScopesForTest } = await import('../project-media-scope.cts');

  const stableProjectId = 'spid_aabbccddeeff001122334455';
  const projectRef = 'prj_0123456789abcdef0123456789abcdef';
  syncProjectScope({ stableProjectId, projectPath: project.projectPath, projectRef });

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const tileUrl = `local-media://${stableProjectId}/${tileFileKey}`;
  const result = resolveImageProcessingSource(project.projectPath, tileUrl);
  assert.equal(result.sourceFileKey, tileFileKey);
  assert.equal(result.sourceFilePath, sourceFilePath);
  assert.equal(result.projectPath, project.projectPath);
});

void test('image-processing-source-resolver: rejects remote URL, unsupported format, and path traversal', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-processing-source-reject-'));
  const currentProject = createProjectFolder(tempDir, 'current');
  writeMediaFile(currentProject.mediaDir, 'source.png');
  // __global__ scope 必须注册，否则路径穿越 URL 会在 scope 解析阶段返回 null（INVALID_URL），
  // 无法到达 fileKey 安全校验阶段（INVALID_FILE_KEY）。
  const globalMediaDir = path.join(tempDir, 'global-media');
  fs.mkdirSync(globalMediaDir, { recursive: true });

  const { resolveImageProcessingSource } = await import('../image-processing-source-resolver.cts');
  const { registerRuntimeProjectScope, registerGlobalMediaScope, clearRuntimeProjectScopesForTest } = await import('../project-media-scope.cts');

  const registered = registerRuntimeProjectScope(currentProject.projectPath);
  assert.ok(registered);
  const registeredGlobal = registerGlobalMediaScope(globalMediaDir);
  assert.ok(registeredGlobal);

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Rejects remote URL
  assert.throws(
    () => resolveImageProcessingSource(currentProject.projectPath, 'https://example.test/source.png'),
    (error) => {
      assertSourceError(error, 'REMOTE_NOT_SUPPORTED', 400);
      return true;
    },
  );

  // Rejects non-local-media URL format
  assert.throws(
    () => resolveImageProcessingSource(currentProject.projectPath, '/files/source.png'),
    (error) => {
      assertSourceError(error, 'INVALID_URL', 400);
      return true;
    },
  );

  // Rejects path traversal in file key
  assert.throws(
    () => resolveImageProcessingSource(currentProject.projectPath, 'local-media://__global__/..%2Fsecret.png'),
    (error) => {
      assertSourceError(error, 'INVALID_FILE_KEY', 400);
      return true;
    },
  );
});
