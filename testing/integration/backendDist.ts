import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const requireBackendDist = createRequire(import.meta.url);

export const resolveBackendLocalServerDistPath = (...segments: string[]) =>
  path.resolve(process.cwd(), 'apps', 'backend', 'dist', 'local-server', ...segments);

export const requireBackendLocalServerDistModule = <T>(...segments: string[]) =>
  requireBackendDist(resolveBackendLocalServerDistPath(...segments)) as T;

let backendDistEnsured = false;

const backendDistBuildStateDir = path.join(
  os.tmpdir(),
  'iartstudio-testing-backend-dist',
  crypto.createHash('sha1').update(process.cwd()).digest('hex'),
);
const backendDistBuildLockDir = path.join(backendDistBuildStateDir, 'lock');
const backendDistBuildMarkerFile = path.join(backendDistBuildStateDir, 'ready.json');

const backendDistRequiredFiles = [
  path.resolve(process.cwd(), 'apps', 'backend', 'dist', 'local-server', 'sqlite-native-loader.cjs'),
  path.resolve(process.cwd(), 'apps', 'backend', 'dist', 'local-server', 'router.cjs'),
  path.resolve(
    process.cwd(),
    'apps',
    'backend',
    'node_modules',
    '@iart',
    'contracts',
    'dist',
    'editor-backend-contract.js',
  ),
  path.resolve(
    process.cwd(),
    'apps',
    'backend',
    'node_modules',
    '@iart',
    'contracts',
    'dist',
    'model-asset-contract.js',
  ),
];

const BUILD_WAIT_STEP_MS = 200;
const BUILD_LOCK_STALE_MS = 3 * 60 * 1000;
const BUILD_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const isBackendDistBuilt = () => backendDistRequiredFiles.every((file) => fs.existsSync(file));

const ensureBackendDistBuildStateDir = () => {
  fs.mkdirSync(backendDistBuildStateDir, { recursive: true });
};

const touchBackendDistBuildMarker = () => {
  ensureBackendDistBuildStateDir();
  fs.writeFileSync(
    backendDistBuildMarkerFile,
    JSON.stringify({
      builtAt: new Date().toISOString(),
      pid: process.pid,
    }),
  );
};

const tryAcquireBackendDistBuildLock = () => {
  ensureBackendDistBuildStateDir();
  try {
    fs.mkdirSync(backendDistBuildLockDir);
    fs.writeFileSync(
      path.join(backendDistBuildLockDir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
    );
    return true;
  } catch (error) {
    const lockError = error as NodeJS.ErrnoException;
    if (lockError.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
};

const refreshBackendDistBuildLock = () => {
  const now = new Date();
  fs.utimesSync(backendDistBuildLockDir, now, now);
};

const releaseBackendDistBuildLock = () => {
  fs.rmSync(backendDistBuildLockDir, { recursive: true, force: true });
};

const isBackendDistBuildLockStale = () => {
  try {
    const lockStat = fs.statSync(backendDistBuildLockDir);
    return Date.now() - lockStat.mtimeMs > BUILD_LOCK_STALE_MS;
  } catch (error) {
    const statError = error as NodeJS.ErrnoException;
    if (statError.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

export const ensureBackendDistBuilt = () => {
  if (backendDistEnsured && isBackendDistBuilt()) return;
  if (isBackendDistBuilt()) {
    touchBackendDistBuildMarker();
    backendDistEnsured = true;
    return;
  }

  const waitDeadline = Date.now() + BUILD_WAIT_TIMEOUT_MS;

  while (Date.now() < waitDeadline) {
    if (isBackendDistBuilt()) {
      touchBackendDistBuildMarker();
      backendDistEnsured = true;
      return;
    }

    if (tryAcquireBackendDistBuildLock()) {
      try {
        if (!isBackendDistBuilt()) {
          execFileSync('pnpm', ['--filter', '@iart/contracts', 'build'], {
            cwd: process.cwd(),
            stdio: 'pipe',
          });
          refreshBackendDistBuildLock();
          execFileSync('pnpm', ['--filter', '@iart/backend', 'build'], {
            cwd: process.cwd(),
            stdio: 'pipe',
          });
        }

        if (!isBackendDistBuilt()) {
          throw new Error('backend dist build completed without restoring required artifacts');
        }

        touchBackendDistBuildMarker();
        backendDistEnsured = true;
        return;
      } finally {
        releaseBackendDistBuildLock();
      }
    }

    if (isBackendDistBuildLockStale()) {
      releaseBackendDistBuildLock();
      continue;
    }

    sleepSync(BUILD_WAIT_STEP_MS);
  }

  throw new Error(
    `Timed out waiting for backend dist build lock after ${BUILD_WAIT_TIMEOUT_MS}ms (${backendDistBuildMarkerFile})`,
  );
};

type SqliteNativeLoaderModule = {
  canLoadBetterSqlite3: (options?: { runtime?: 'node' | 'electron' }) => boolean;
  loadBetterSqlite3: (options?: { runtime?: 'node' | 'electron' }) => unknown;
};

const getSqliteNativeLoader = () =>
  requireBackendLocalServerDistModule<SqliteNativeLoaderModule>('sqlite-native-loader.cjs');

export const loadBetterSqlite3 = (): unknown => getSqliteNativeLoader().loadBetterSqlite3({ runtime: 'node' });

export const canUseSqliteNative = (() => {
  try {
    return getSqliteNativeLoader().canLoadBetterSqlite3({ runtime: 'node' });
  } catch {
    return false;
  }
})();
