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

const expectErrorCode = async (run: () => Promise<unknown>, code: string) => {
  try {
    await run();
  } catch (error) {
    const actual =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : '';
    assert.equal(actual, code);
    return;
  }
  assert.fail(`expected error with code ${code}`);
};

void test('video-frame-extract: 负时间点拒绝为 INVALID_TIME（不触碰项目与 ffmpeg）', async () => {
  const { executeVideoFrameExtract } = await import('../video-frame-extract.cts');
  await expectErrorCode(
    () => executeVideoFrameExtract('/nonexistent', { sourceUrl: '/files/a.mp4', timeSec: -1 }),
    'INVALID_TIME',
  );
  await expectErrorCode(
    () => executeVideoFrameExtract('/nonexistent', { sourceUrl: '/files/a.mp4', timeSec: 'abc' }),
    'INVALID_TIME',
  );
});

void test('video-frame-extract: 非法项目路径拒绝为 INVALID_PROJECT', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfe-invalid-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeVideoFrameExtract } = await import('../video-frame-extract.cts');
  await expectErrorCode(
    () => executeVideoFrameExtract(path.join(tempDir, 'missing.iartproj'), { sourceUrl: '/files/a.mp4', timeSec: 1 }),
    'INVALID_PROJECT',
  );
});

void test('video-frame-extract: 源文件不存在拒绝为 FILE_NOT_FOUND', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfe-missing-'));
  const project = createProjectFolder(tempDir, 'project-missing');
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeVideoFrameExtract } = await import('../video-frame-extract.cts');
  await expectErrorCode(
    () => executeVideoFrameExtract(project.projectPath, { sourceUrl: '/files/nope.mp4', timeSec: 1 }),
    'FILE_NOT_FOUND',
  );
});
