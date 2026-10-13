/**
 * Smoke Test: better-sqlite3 在 Electron main process 中的加载可行性
 *
 * 目的：验证决策书方案 B 的前置条件——main process 能否加载 better-sqlite3 Electron 二进制。
 *
 * 验证项：
 *   1. 能否找到预编译的 electron 运行时
 *   2. 能否 require() 加载 native module
 *   3. 能否创建内存数据库并执行 CRUD
 *   4. 能否在文件数据库上启用 WAL 模式 + 事务
 *   5. delta 写入性能基准
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import type { SqliteDatabaseCtor } from './storage/sqlite-loader.cjs';

type SmokeTestResult = {
  passed: boolean;
  steps: SmokeTestStep[];
  error: string | undefined;
};

type SmokeTestStep = {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
};

export async function runSqliteSmokeTest(): Promise<SmokeTestResult> {
  const steps: SmokeTestStep[] = [];
  const nodeRequire = createRequire(__filename);

  const step = async (name: string, fn: () => Promise<string> | string) => {
    const start = performance.now();
    try {
      const detail = await fn();
      steps.push({ name, passed: true, detail, durationMs: performance.now() - start });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        name,
        passed: false,
        detail: message,
        durationMs: performance.now() - start,
      });
      throw err;
    }
  };

  try {
    // --- Step 1: 定位预编译目录 ---
    let nativeModulesDir: string;

    await step('resolve-native-modules-dir', () => {
      // __dirname 在编译后为 apps/desktop-shell/dist/
      // 原生模块在 apps/backend/native-modules/better-sqlite3/
      const fromDist = path.resolve(__dirname, '..', '..', 'backend', 'native-modules', 'better-sqlite3');
      const fromSrc = path.resolve(__dirname, '..', '..', '..', 'backend', 'native-modules', 'better-sqlite3');

      const candidates = [fromDist, fromSrc];
      const found = candidates.find((dir) =>
        fs.existsSync(path.join(dir, 'electron', 'package.json')),
      );

      if (!found) {
        throw new Error(
          `Native modules dir not found. Checked:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
            'Run `pnpm abi:electron -- --verify` to prepare the runtime.',
        );
      }

      nativeModulesDir = found;
      return `Found at: ${found}`;
    });

    // --- Step 2: 确认 electron 运行时二进制存在 ---
    await step('verify-electron-binary-exists', () => {
      const electronDir = path.join(nativeModulesDir, 'electron');
      const binaryPath = path.join(electronDir, 'build', 'Release', 'better_sqlite3.node');
      const indexPath = path.join(electronDir, 'lib', 'index.js');

      if (!fs.existsSync(binaryPath)) {
        throw new Error(`Native binary not found: ${binaryPath}`);
      }
      if (!fs.existsSync(indexPath)) {
        throw new Error(`JS entry not found: ${indexPath}`);
      }

      const stat = fs.statSync(binaryPath);
      return `Binary: ${binaryPath} (${(stat.size / 1024).toFixed(0)} KB), Entry: ${indexPath}`;
    });

    // --- Step 3: require() 加载 native module ---
    let Database: SqliteDatabaseCtor;

    await step('require-native-module', () => {
      const electronDir = path.join(nativeModulesDir, 'electron');

      // ASAR 兼容处理（与 sqlite-native-loader 一致）
      let resolvedDir = electronDir;
      if (resolvedDir.includes('app.asar') && !resolvedDir.includes('app.asar.unpacked')) {
        resolvedDir = resolvedDir.replace('app.asar', 'app.asar.unpacked');
      }

      const loaded = nodeRequire(resolvedDir) as unknown;
      const loadedDefault =
        typeof loaded === 'object' && loaded !== null && 'default' in loaded
          ? (loaded as { default: unknown | undefined }).default
          : undefined;
      if (typeof loaded !== 'function' && typeof loadedDefault !== 'function') {
        throw new Error(`Module did not export a constructor. Got: ${typeof loaded}`);
      }

      Database =
        typeof loaded === 'function' ? (loaded as SqliteDatabaseCtor) : (loadedDefault as SqliteDatabaseCtor);
      return `Database constructor loaded: ${typeof Database}`;
    });

    // --- Step 4: 创建内存数据库并执行基本 CRUD ---
    await step('in-memory-crud', () => {
      const db = new Database(':memory:');

      db.exec('CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT)');
      const insert = db.prepare('INSERT INTO smoke_test (value) VALUES (?)');
      insert.run('hello');
      insert.run('world');

      const rows = db
        .prepare('SELECT * FROM smoke_test ORDER BY id')
        .all() as Array<{ id: number; value: string }>;
      db.close();

      if (rows.length !== 2) {
        throw new Error(`Expected 2 rows, got ${rows.length}`);
      }
      if ((rows[0] !== null && rows[0] !== undefined ? rows[0].value : undefined) !== 'hello' || (rows[1] !== null && rows[1] !== undefined ? rows[1].value : undefined) !== 'world') {
        throw new Error(`Data mismatch: ${JSON.stringify(rows)}`);
      }

      return 'Created table, inserted 2 rows, read back correctly';
    });

    // --- Step 5: 文件数据库 + WAL 模式 ---
    await step('file-database-wal-mode', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-smoke-sqlite-'));
      const dbPath = path.join(tmpDir, 'test.sqlite');

      try {
        const db = new Database(dbPath);

        db.pragma('journal_mode = WAL', undefined);
        const journalMode = db.pragma('journal_mode', { simple: true }) as string;
        if (journalMode !== 'wal') {
          throw new Error(`WAL mode not activated, got: ${journalMode}`);
        }

        db.pragma('synchronous = NORMAL', undefined);

        db.exec('CREATE TABLE test_nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
        const insert = db.prepare('INSERT INTO test_nodes (id, data) VALUES (?, ?)');
        insert.run('node-1', '{"type":"test"}');

        const updateMany = db.transaction((items: Array<{ id: string; data: string }>) => {
          for (const item of items) {
            db.prepare('UPDATE test_nodes SET data = ? WHERE id = ?').run(item.data, item.id);
          }
        });
        updateMany([{ id: 'node-1', data: '{"type":"updated"}' }]);

        const row = db.prepare('SELECT data FROM test_nodes WHERE id = ?').get('node-1') as
          | { data: string }
          | undefined;
        db.close();

        if (!row || row.data !== '{"type":"updated"}') {
          throw new Error(`Transaction result mismatch: ${JSON.stringify(row)}`);
        }

        const walExists = fs.existsSync(dbPath + '-wal');
        return `File DB at ${dbPath}, journal_mode=wal, transaction OK, WAL file exists: ${walExists}`;
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    // --- Step 6: 性能基准（delta 写入模拟）---
    await step('performance-benchmark', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-smoke-perf-'));
      const dbPath = path.join(tmpDir, 'perf.sqlite');

      try {
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL', undefined);
        db.pragma('synchronous = NORMAL', undefined);

        db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT, data TEXT)');
        db.exec(
          'CREATE TABLE pending_deltas (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, created_at INTEGER)',
        );

        const insertDelta = db.prepare(
          'INSERT INTO pending_deltas (data, created_at) VALUES (?, ?)',
        );
        const deltaData = JSON.stringify({
          nodes: { upsert: [{ id: 'n1', type: 'test' }] },
        });

        // 写入 100 次 delta
        const writeStart = performance.now();
        for (let i = 0; i < 100; i++) {
          insertDelta.run(deltaData, Date.now());
        }
        const writeDuration = performance.now() - writeStart;

        // 合并 + flush
        const deltas = db.prepare('SELECT data FROM pending_deltas').all() as Array<{
          data: string;
        }>;
        const mergeStart = performance.now();
        const upsertNode = db.prepare(
          'INSERT OR REPLACE INTO nodes (id, graph_id, data) VALUES (?, ?, ?)',
        );
        db.transaction(() => {
          for (const delta of deltas) {
            const parsed = JSON.parse(delta.data) as unknown;
            interface RawParsedDelta { nodes: { upsert: unknown[] | undefined } | undefined }
            const parsedRecord =
              typeof parsed === 'object' && parsed !== null ? (parsed as RawParsedDelta) : null;
            const upsertNodes = (() => {
              if (parsedRecord === null || parsedRecord === undefined) return [] as unknown[];
              if (parsedRecord.nodes === null || parsedRecord.nodes === undefined) return [] as unknown[];
              if (!Array.isArray(parsedRecord.nodes.upsert)) return [] as unknown[];
              return parsedRecord.nodes.upsert;
            })();
            for (const node of upsertNodes) {
              if (!node || typeof node !== 'object') continue;
              interface RawNodeEntry { id: unknown | undefined }
              const nodeRecord = node as RawNodeEntry;
              if (typeof nodeRecord.id !== 'string' || !nodeRecord.id) continue;
              upsertNode.run(nodeRecord.id, 'graph-1', JSON.stringify(node));
            }
          }
          db.prepare('DELETE FROM pending_deltas').run();
        })();
        const mergeDuration = performance.now() - mergeStart;

        db.close();

        return (
          `100 deltas: write ${(writeDuration / 100).toFixed(2)}ms/ea, ` +
          `merge+flush ${mergeDuration.toFixed(1)}ms, total ${(writeDuration + mergeDuration).toFixed(1)}ms`
        );
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    return { passed: true, steps, error: undefined };
  } catch (err: unknown) {
    return { passed: false, steps, error: err instanceof Error ? err.message : String(err) };
  }
}
