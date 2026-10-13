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
  STORAGE_SCHEMA_VERSION_KEY: string;
  initSchema: (db: unknown) => void;
};

const loadSchemaModule = (): StorageSchemaModule =>
  requireDesktop(schemaEntry) as StorageSchemaModule;

/**
 * v7 时代的旧库（tasks 仍含 requestBodyJson 大体积列）。
 * 一次性裁断后不再执行 v8 删除列迁移与迁移后 VACUUM 维护，旧库必须被拒绝打开。
 */
const V7_DDL = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE tasks (
    taskId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    projectPath TEXT NOT NULL,
    requestJson TEXT,
    requestBodyJson TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  );
`;

function createVersionedDatabase(version: number): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(V7_DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'storage_schema_version', String(version),
  );
  return db;
}

describe('editor storage schema：v7/v8 时代及更高版本库拒绝打开', () => {
  beforeAll(() => {
    if (!existsSync(schemaEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('v7 旧库打开时明确报错拒绝，不执行删除列迁移', () => {
    const schema = loadSchemaModule();
    const db = createVersionedDatabase(7);
    try {
      db.prepare(
        'INSERT INTO tasks (taskId, status, projectPath, requestBodyJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('task-1', 'succeeded', '/tmp/p', 'X'.repeat(1024), Date.now(), Date.now());

      assert.throws(
        () => schema.initSchema(db),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /PROJECT_SQLITE_SCHEMA_MISMATCH/);
          assert.match(error.message, /storage_schema_version=7/);
          assert.match(error.message, /不再支持迁移打开/);
          return true;
        },
      );

      // 不迁移：requestBodyJson 列与数据原样保留。
      const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
        .map((col) => col.name);
      assert.ok(taskCols.includes('requestBodyJson'), 'requestBodyJson column must remain untouched');
      const row = db.prepare('SELECT requestBodyJson FROM tasks WHERE taskId = ?').get('task-1') as { requestBodyJson: string };
      assert.equal(row.requestBodyJson.length, 1024, 'legacy data must be preserved');

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(Number(versionRow?.value), 7, 'version must not be bumped on rejection');
    } finally {
      db.close();
    }
  });

  it('版本号高于当前版本的库同样拒绝打开（防御性兜底）', () => {
    const schema = loadSchemaModule();
    const db = createVersionedDatabase(schema.CURRENT_SCHEMA_VERSION + 1);
    try {
      assert.throws(
        () => schema.initSchema(db),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /PROJECT_SQLITE_SCHEMA_MISMATCH/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it('当前版本库正常打开：结构校验通过、无迁移后维护标记残留', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      // 再次打开走版本校验路径（非空库、版本一致），应正常通过。
      schema.initSchema(db);

      const pending = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        'storage_post_vacuum_pending',
      ) as { value: string } | undefined;
      assert.equal(pending, undefined, 'no post-vacuum pending marker should exist');
    } finally {
      db.close();
    }
  });
});
