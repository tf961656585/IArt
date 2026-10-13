import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * extractRuntimeFileKey 单元级回归测试。
 *
 * extractRuntimeFileKey 是 task-result-materializer.cts 的内部函数（未导出），
 * 无法直接调用。本测试通过双重策略验证收口：
 * 1. 静态契约校验：读取源文件文本，断言 local-media:// 分支委托给 utils.extractMediaFileKey，
 *    且 /files/ 与 /project-media/ 历史兼容分支保留（钉死重构契约，防止后续误删）。
 * 2. 动态行为校验：直接验证被委托方 utils.extractMediaFileKey 的 V2 行为（单一事实源）。
 *
 * 不使用 import.meta.url（CJS tsconfig 不允许），改用 process.cwd() 解析源文件路径
 * （node --test 与 tsx 默认 cwd 为仓库根）。
 */
const resolveSourcePath = () =>
  path.resolve(process.cwd(), 'apps/backend/src/local-server/task-result-materializer.cts');

void test('extractRuntimeFileKey: local-media:// branch delegates to utils.extractMediaFileKey', () => {
  const source = fs.readFileSync(resolveSourcePath(), 'utf-8');

  // local-media:// 分支必须委托给 utils.extractMediaFileKey（收口断言，获得 V2 spid_ 支持）
  assert.ok(
    source.includes('mediaFileKeyModule.extractMediaFileKey(normalizedUrl)'),
    'extractRuntimeFileKey local-media:// 分支必须委托 mediaFileKeyModule.extractMediaFileKey',
  );
  // 必须导入 media-file-key 模块
  assert.ok(
    source.includes("require('@iart/utils/media-file-key')"),
    'task-result-materializer 必须导入 @iart/utils/media-file-key',
  );
});

void test('extractRuntimeFileKey: retains /files/ and /project-media/ legacy compat branches', () => {
  const source = fs.readFileSync(resolveSourcePath(), 'utf-8');

  // 历史 /files/ 与 /project-media/ 兼容分支必须保留（重构不删除）
  assert.ok(
    source.includes("normalizedUrl.startsWith('/files/')"),
    'extractRuntimeFileKey 必须保留 /files/ 历史兼容分支',
  );
  assert.ok(
    source.includes("parsed.pathname.startsWith('/project-media/')"),
    'extractRuntimeFileKey 必须保留 /project-media/ 历史兼容分支',
  );
});

void test('extractRuntimeFileKey: delegated utils.extractMediaFileKey covers V2 spid_ URL', async () => {
  // 直接验证被委托方的行为（utils 单一事实源），确保 local-media:// 委托后获得 V2 支持
  const mediaFileKeyModule = await import('@iart/utils/media-file-key');

  // V2 URL：fileKey 不含 scope 段（本次 bug 的直接回归断言）
  assert.equal(
    mediaFileKeyModule.extractMediaFileKey('local-media://spid_0123456789abcdef01234567/processed/x.png'),
    'processed/x.png',
  );
  // V1 URL：兼容性
  assert.equal(
    mediaFileKeyModule.extractMediaFileKey('local-media://prj_0123456789abcdef0123456789abcdef/processed/x.png'),
    'processed/x.png',
  );
  // 非 local-media URL：返回 null（历史 /files/ /project-media/ 由 extractRuntimeFileKey 自己处理，不委托）
  assert.equal(mediaFileKeyModule.extractMediaFileKey('/files/x.png'), null);
});
