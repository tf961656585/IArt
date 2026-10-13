import * as fs from 'node:fs';
import * as path from 'node:path';

type SqliteRuntime = 'node' | 'electron';

const PREPARED_RUNTIME_ROOT = path.resolve(__dirname, '..', '..', 'native-modules', 'better-sqlite3');

let cachedRuntime: SqliteRuntime | null = null;
let cachedDatabase: BetterSqlite3Constructor | null = null;
let cachedError: unknown = null;

type SqliteLoaderOptions = {
  runtime: unknown | undefined;
};

type BetterSqlite3Database = {
  close: () => void;
};

type BetterSqlite3Constructor = new (filename: string) => BetterSqlite3Database;

const normalizeRuntime = (value: unknown): SqliteRuntime | null => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'node' || raw === 'electron') return raw;
  return null;
};

const resolveSqliteRuntime = (options: SqliteLoaderOptions = { runtime: undefined } as SqliteLoaderOptions): SqliteRuntime => {
  const explicitRuntime = normalizeRuntime(options.runtime);
  if (explicitRuntime) return explicitRuntime;

  const envRuntime = normalizeRuntime(process.env['IART_SQLITE_RUNTIME']);
  if (envRuntime) return envRuntime;

  const electronVersion = 'electron' in process.versions ? process.versions['electron'] : undefined;
  return electronVersion ? 'electron' : 'node';
};

const resolveAsarCompatiblePath = (rawPath: string) => {
  if (!rawPath.includes('app.asar') || rawPath.includes('app.asar.unpacked')) {
    return rawPath;
  }
  return rawPath.replace('app.asar', 'app.asar.unpacked');
};

const listPreparedRuntimeCandidates = (runtime: SqliteRuntime) => {
  const runtimeDir = path.join(PREPARED_RUNTIME_ROOT, runtime);
  const unpackedRuntimeDir = resolveAsarCompatiblePath(runtimeDir);
  return Array.from(new Set([unpackedRuntimeDir, runtimeDir]));
};

const resolvePreparedRuntimeDir = (runtime: SqliteRuntime) => {
  const candidates = listPreparedRuntimeCandidates(runtime);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) || null;
};

const buildPrepareHint = (runtime: SqliteRuntime) =>
  runtime === 'electron' ? 'pnpm abi:electron -- --verify' : 'pnpm abi:node -- --verify';

const buildMissingRuntimeError = (runtime: SqliteRuntime) => {
  const checked = listPreparedRuntimeCandidates(runtime).map((candidate) => `- ${candidate}`).join('\n');
  return new Error(
    [
      `Prepared better-sqlite3 runtime "${runtime}" is missing.`,
      'Checked paths:',
      checked,
      `Run \`${buildPrepareHint(runtime)}\` to prepare the isolated native package first.`,
    ].join('\n')
  );
};

const isBetterSqlite3Constructor = (value: unknown): value is BetterSqlite3Constructor =>
  typeof value === 'function';

const loadBetterSqlite3 = (options: SqliteLoaderOptions = { runtime: undefined } as SqliteLoaderOptions): BetterSqlite3Constructor => {
  const runtime = resolveSqliteRuntime(options);
  if (cachedDatabase && cachedRuntime === runtime) {
    return cachedDatabase;
  }
  if (cachedError && cachedRuntime === runtime) {
    throw cachedError;
  }

  try {
    const runtimeDir = resolvePreparedRuntimeDir(runtime);
    if (!runtimeDir) {
      throw buildMissingRuntimeError(runtime);
    }
    const loaded: unknown = require(runtimeDir);
    if (!isBetterSqlite3Constructor(loaded)) {
      throw new Error(`Prepared better-sqlite3 runtime "${runtime}" did not export a database constructor.`);
    }
    cachedRuntime = runtime;
    cachedDatabase = loaded;
    cachedError = null;
    return loaded;
  } catch (error) {
    cachedRuntime = runtime;
    cachedDatabase = null;
    cachedError = error;
    throw error;
  }
};

const canLoadBetterSqlite3 = (options: SqliteLoaderOptions = { runtime: undefined } as SqliteLoaderOptions) => {
  try {
    const Database = loadBetterSqlite3(options);
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
};

export {
  loadBetterSqlite3,
  canLoadBetterSqlite3,
};
