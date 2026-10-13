// @vitest-environment node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, it } from 'vitest';

import Database from 'better-sqlite3';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const schemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;

type StorageSchemaModule = {
  CURRENT_SCHEMA_VERSION: number;
  initSchema: (db: unknown, options?: { projectPath?: string }) => void;
};

const loadSchemaModule = (): StorageSchemaModule =>
  requireDesktop(schemaEntry) as StorageSchemaModule;

/**
 * v5 时代的旧库（含旧格式 /project-media 媒体 URL）。
 * 一次性裁断后不再执行 v5/v6 媒体 URL 迁移，旧库必须被拒绝打开且数据保持原样。
 */
const V5_DDL = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE media_assets (
    assetId TEXT PRIMARY KEY,
    mediaType TEXT NOT NULL,
    payloadJson TEXT NOT NULL,
    createdAt INTEGER,
    updatedAt INTEGER
  );
`;

function createV5Database(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(V5_DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'storage_schema_version', '5',
  );
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'storage_schema_id', 'storage-schema-v5-local-media-url-migration',
  );
  return db;
}

describe('editor storage schema：v5/v6 时代旧库拒绝打开', () => {
  beforeAll(() => {
    if (!existsSync(schemaEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('v5 旧库打开时抛出 PROJECT_SQLITE_SCHEMA_MISMATCH，错误说明旧版本不再支持迁移', () => {
    const schema = loadSchemaModule();
    const db = createV5Database();
    try {
      assert.throws(
        () => schema.initSchema(db, { projectPath: '/tmp/test-project' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /PROJECT_SQLITE_SCHEMA_MISMATCH/);
          assert.match(error.message, /storage_schema_version=5/);
          assert.match(error.message, /不再支持迁移打开/);
          assert.match(error.message, /\/tmp\/test-project/, 'error should include project path');
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('v5 旧库被拒绝后数据保持原样：旧格式 URL 不被改写、版本号不被提升', () => {
    const schema = loadSchemaModule();
    const db = createV5Database();
    try {
      const oldUrl = '/project-media/prj_abc123/foo.png';
      db.prepare(
        'INSERT INTO media_assets (assetId, mediaType, payloadJson) VALUES (?, ?, ?)',
      ).run('asset-1', 'image', JSON.stringify({ original: { url: oldUrl } }));

      assert.throws(() => schema.initSchema(db));

      const row = db.prepare('SELECT payloadJson FROM media_assets WHERE assetId = ?').get('asset-1') as { payloadJson: string };
      const parsed = JSON.parse(row.payloadJson) as { original: { url: string } };
      assert.equal(parsed.original.url, oldUrl, 'legacy URL must not be rewritten');

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        'storage_schema_version',
      ) as { value: string } | undefined;
      assert.equal(Number(versionRow?.value), 5, 'version must not be bumped on rejection');
    } finally {
      db.close();
    }
  });
});
