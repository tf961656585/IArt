// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { UNIFIED_GENERATION_STATUSES } from '@iart/contracts';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const contractsDistEntry = `${workspaceRoot}/packages/contracts/dist/index.js`;
const desktopStorageSchemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;
const desktopStorageReadModelEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-read-model.cjs`;

type StorageSchemaModule = {
  initSchema: (db: unknown) => void;
};

type StorageReadModelModule = {
  buildProjectRecord: (projectPath: string, db: unknown) => {
    mediaAssets?: Record<string, unknown>;
  } | null;
  readAllMediaAssets: (db: unknown) => unknown[];
  readMediaAssetById: (db: unknown, assetId: string) => unknown;
  readMediaAssetsByTaskId: (db: unknown, taskId: string) => unknown[];
  readMediaAssetsFromDb: (db: unknown) => Record<string, unknown>;
};

const loadStorageModules = () => ({
  schema: requireDesktop(desktopStorageSchemaEntry) as StorageSchemaModule,
  readModel: requireDesktop(desktopStorageReadModelEntry) as StorageReadModelModule,
});

describe('editor storage read model media assets', () => {
  beforeAll(() => {
    if (!existsSync(contractsDistEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/contracts', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
    if (!existsSync(desktopStorageSchemaEntry) || !existsSync(desktopStorageReadModelEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('hydrates MediaAsset from media_assets row fields and payloadJson on project recovery', () => {
    const { schema, readModel } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      db.prepare(
        `INSERT INTO project_manifest (
          id, version, name, nodeGraphId, createdAt, savedAt, source
        ) VALUES (1, 1, ?, ?, ?, ?, ?)`,
      ).run('media-recovery', 'graph-1', 1, 2, null);
      db.prepare(
        'INSERT INTO graph (id, payloadJson, updatedAt) VALUES (?, ?, ?)',
      ).run('graph-1', JSON.stringify({ id: 'graph-1', name: 'media-recovery' }), 2);
      db.prepare(
        `INSERT INTO tasks (
          taskId, status, projectPath, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run('task-1', 'succeeded', '/tmp/media-recovery.iartproj', 10, 20);
      db.prepare(
        `INSERT INTO media_assets (
          assetId, mediaType, payloadJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'asset-video-1',
        'video',
        JSON.stringify({
          original: {
            url: 'local-media://project-a/video.mp4',
            projectRef: 'project-a',
            fileKey: 'video.mp4',
            mimeType: 'video/mp4',
            sizeBytes: 4096,
            width: 1920,
            height: 1080,
            durationMs: 62000,
          },
          thumbnail: {
            url: 'local-media://project-a/video-thumb.jpg',
            mimeType: 'image/jpeg',
            width: 320,
            height: 180,
            status: 'ready',
            generatedAt: 30,
            error: null,
          },
        }),
        10,
        20,
      );
      db.prepare(
        `INSERT INTO task_outputs (
          outputId, taskId, assetId, mediaType, sortOrder
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run('output-1', 'task-1', 'asset-video-1', 'video', 0);

      const mediaAssets = readModel.readMediaAssetsFromDb(db);
      expect(mediaAssets['asset-video-1']).toMatchObject({
        id: 'asset-video-1',
        mediaType: 'video',
        original: {
          url: 'local-media://project-a/video.mp4',
          sizeBytes: 4096,
          width: 1920,
          height: 1080,
          durationMs: 62000,
        },
        thumbnail: {
          url: 'local-media://project-a/video-thumb.jpg',
          status: 'ready',
          width: 320,
          height: 180,
        },
        lifecycle: {
          createdAt: 10,
          updatedAt: 20,
        },
      });

      const projectRecord = readModel.buildProjectRecord('/tmp/media-recovery.iartproj', db);
      expect(projectRecord?.mediaAssets['asset-video-1']).toMatchObject({
        original: { sizeBytes: 4096, durationMs: 62000 },
        thumbnail: { url: 'local-media://project-a/video-thumb.jpg', status: 'ready' },
      });

      const taskMediaAsset = readModel.readMediaAssetsByTaskId(db, 'task-1')[0] as
        | Record<string, unknown>
        | undefined;
      expect(taskMediaAsset).toMatchObject({
        assetId: 'asset-video-1',
        mediaType: 'video',
        original: {
          url: 'local-media://project-a/video.mp4',
          fileKey: 'video.mp4',
        },
        lifecycle: {
          createdAt: 10,
          updatedAt: 20,
        },
      });
      expect(taskMediaAsset).not.toHaveProperty('payloadJson');
      expect(taskMediaAsset).not.toHaveProperty('createdAt');
      expect(taskMediaAsset).not.toHaveProperty('updatedAt');
      expect(readModel.readMediaAssetById(db, 'asset-video-1')).toMatchObject({
        assetId: 'asset-video-1',
        mediaType: 'video',
      });
      expect(readModel.readAllMediaAssets(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('enforces runtime task six-state CHECK at SQLite DDL level', () => {
    const { schema } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      const insertTask = db.prepare(
        `INSERT INTO tasks (
          taskId, status, projectPath, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?)`,
      );

      for (const taskStatus of UNIFIED_GENERATION_STATUSES) {
        insertTask.run(
          `task-${taskStatus}`,
          taskStatus,
          '/tmp/runtime-task-status-check.iartproj',
          1,
          2,
        );
      }

      for (const taskStatus of ['pending', 'canceled', 'cancelled']) {
        expect(() =>
          insertTask.run(
            `task-${taskStatus}`,
            taskStatus,
            '/tmp/runtime-task-status-check.iartproj',
            1,
            2,
          ),
        ).toThrow();
      }
    } finally {
      db.close();
    }
  });
});
