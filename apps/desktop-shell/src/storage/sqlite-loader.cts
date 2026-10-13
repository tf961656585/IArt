/**
 * Editor Storage Service — better-sqlite3 加载器
 *
 * 简化自 apps/backend/src/local-server/sqlite-native-loader.cts。
 * desktop-shell 运行在 Electron main process，固定使用 electron 运行时。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const NATIVE_MODULES_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'backend',
  'native-modules',
  'better-sqlite3',
);

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  prepare: (sql: string) => SqliteStatement;
  pragma: (sql: string, options: { simple: boolean | undefined } | undefined) => unknown;
  /**
   * better-sqlite3 的事务包装：返回的函数把回调的返回值原样透出（同一事务内读写皆可），
   * 因此返回类型跟随回调返回类型，而不是固定 void。
   */
  transaction: <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ) => (...args: TArgs) => TResult;
  close: () => void;
  exec: (sql: string) => void;
};

type SqliteDatabaseCtor = new (filePath: string) => SqliteDatabase;

const nodeRequire = createRequire(__filename);
let cachedDatabase: SqliteDatabaseCtor | null = null;

const resolveAsarCompatiblePath = (rawPath: string): string => {
  if (!rawPath.includes('app.asar') || rawPath.includes('app.asar.unpacked')) {
    return rawPath;
  }
  return rawPath.replace('app.asar', 'app.asar.unpacked');
};

const resolveElectronRuntimeDir = (): string | null => {
  const runtimeDir = path.join(NATIVE_MODULES_ROOT, 'electron');
  const unpackedDir = resolveAsarCompatiblePath(runtimeDir);

  const candidates = [unpackedDir, runtimeDir];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json'))) || null;
};

const resolveDatabaseCtor = (loaded: unknown): SqliteDatabaseCtor => {
  if (typeof loaded === 'function') {
    return loaded as SqliteDatabaseCtor;
  }
  if (
    typeof loaded === 'object' &&
    loaded !== null &&
    'default' in loaded &&
    typeof (loaded as { default: unknown | undefined }).default === 'function'
  ) {
    return (loaded as { default: SqliteDatabaseCtor }).default;
  }
  throw new Error(`better-sqlite3 module does not export a constructor`);
};

const loadBetterSqlite3 = (): SqliteDatabaseCtor => {
  if (cachedDatabase) return cachedDatabase;

  const runtimeDir = resolveElectronRuntimeDir();
  if (!runtimeDir) {
    throw new Error(
      'Editor Storage: better-sqlite3 electron runtime not found.\n' +
        `Checked: ${path.join(NATIVE_MODULES_ROOT, 'electron')}\n` +
        'Run `pnpm abi:electron -- --verify` to prepare the runtime.',
    );
  }

  const loaded = nodeRequire(runtimeDir) as unknown;
  cachedDatabase = resolveDatabaseCtor(loaded);
  return cachedDatabase;
};

export { loadBetterSqlite3 };
export type { SqliteDatabase, SqliteDatabaseCtor, SqliteStatement };
