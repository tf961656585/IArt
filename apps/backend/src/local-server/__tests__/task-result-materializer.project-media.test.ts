import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const createProjectFolder = (rootDir: string) => {
  const projectPath = path.join(rootDir, 'materializer-project.iartproj');
  const mediaDir = path.join(projectPath, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: 'materializer-project' }, null, 2),
    'utf-8',
  );
  return { projectPath, mediaDir };
};

void test('task-result-materializer: media_assets payload 写入 projectRef + fileKey 并派生 project-media URL', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-result-materializer-project-media-'));
  const { projectPath, mediaDir } = createProjectFolder(tempDir);
  const fileKey = 'downloaded.mp4';
  fs.writeFileSync(path.join(mediaDir, fileKey), 'materialized-media');

  const scope = await import('../project-media-scope.cts');
  scope.clearRuntimeProjectScopesForTest();
  const { buildRuntimeMediaRows } = await import('../task-result-materializer.cts');

  t.after(() => {
    scope.clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const rows = await buildRuntimeMediaRows(
    { taskId: 'task_materializer_1', projectPath },
    [
      {
        url: `/files/${fileKey}`,
        fileKey,
        mediaType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: 18,
        sourceUrl: 'https://example.com/video.mp4',
        downloadedAt: new Date(0).toISOString(),
        textValue: null,
        width: undefined,
        height: undefined,
        durationMs: undefined,
        assetId: undefined,
        projectRef: undefined,
      },
    ],
  );

  assert.equal(rows.taskOutputs[0]?.assetId, rows.mediaAssets[0]?.assetId);
  const payload = JSON.parse(String(rows.mediaAssets[0]?.payloadJson)) as {
    original?: { url?: unknown; projectRef?: unknown; fileKey?: unknown };
  };
  assert.equal(payload.original?.fileKey, fileKey);
  assert.equal(typeof payload.original?.projectRef, 'string');
  assert.match(String(payload.original?.url), /^local-media:\/\/prj_[a-f0-9]{32}\/downloaded\.mp4$/);
});
