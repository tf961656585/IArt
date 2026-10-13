import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * smart-split 缩略图修复回归测试（本次病灶的现象验证）。
 *
 * 病灶根因：`extractMediaFileKey` 不认 V2（spid_）前缀，对 V2 URL
 * `local-media://spid_.../processed/xxx.png` 错误返回 `spid_.../processed/xxx.png`
 * 作为 fileKey，导致 thumbnail repair 在 path.join(projectPath, 'media', fileKey)
 * 拼出错误路径，文件找不到，缩略图永远生成失败，日志反复输出：
 *   [warn] Thumbnail repair failed ... Local media file not found: spid_.../processed/xxx.png
 *
 * 修复后：`extractMediaFileKey` 经 parseLocalMediaUrl 复用 isLocalMediaScope，
 * 认 spid_ 为合法 scope，返回正确的 `processed/xxx.png` fileKey。
 *
 * 本测试直接断言被 media-asset-registry.cts:407 消费的 extractMediaFileKey 行为，
 * 覆盖病灶日志中出现的精确 URL 形态。
 */
void test('smart-split regression: extractMediaFileKey handles V2 spid_ URL (thumbnail repair fileKey)', async () => {
  const mediaFileKeyModule = await import('@iart/utils/media-file-key');

  // 病灶日志的精确 URL 形态：spid_ scope + processed/ 子路径
  const v2Url = 'local-media://spid_c4d6c4da6be043f499c11092/processed/tile-abc.png';
  const fileKey = mediaFileKeyModule.extractMediaFileKey(v2Url);

  // 核心断言：fileKey 必须是 processed/tile-abc.png，不含 scope 段
  // 修复前这里会返回 'spid_c4d6c4da6be043f499c11092/processed/tile-abc.png'，导致 file_not_found
  assert.equal(fileKey, 'processed/tile-abc.png');

  // 对比断言：修复前后的差异必须可观测
  assert.ok(
    fileKey !== null && !fileKey.startsWith('spid_'),
    'fileKey must not contain the spid_ scope segment (this was the regression)',
  );
});

void test('smart-split regression: thumbnail repair V1 URL backward compat (prj_)', async () => {
  const mediaFileKeyModule = await import('@iart/utils/media-file-key');

  // V1 URL：已存储的旧项目仍能正确解析
  const v1Url = 'local-media://prj_0123456789abcdef0123456789abcdef/processed/tile-abc.png';
  const fileKey = mediaFileKeyModule.extractMediaFileKey(v1Url);
  assert.equal(fileKey, 'processed/tile-abc.png');
});

void test('smart-split regression: resolveRuntimeProjectPathByRef symmetric for spid_ scope', async () => {
  // 验证索引对称化：按 spid_ 能查到 projectPath（矛盾二闭合）
  // 这使得 thumbnail repair 与 image processing 的完整链路对 V2 URL 可用
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-split-regression-'));
  const projectPath = path.join(tempDir, 'project.iartproj');
  const mediaDir = path.join(projectPath, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'manifest.json'), '{}');

  const { syncProjectScope, resolveRuntimeProjectPathByRef, clearRuntimeProjectScopesForTest } =
    await import('../project-media-scope.cts');

  const stableProjectId = 'spid_c4d6c4da6be043f499c11092';
  const projectRef = 'prj_0123456789abcdef0123456789abcdef';
  syncProjectScope({ stableProjectId, projectPath, projectRef });

  try {
    // 索引对称化：spid_ 能查到 projectPath
    const resolved = resolveRuntimeProjectPathByRef(stableProjectId);
    assert.equal(resolved, projectPath);
  } finally {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
