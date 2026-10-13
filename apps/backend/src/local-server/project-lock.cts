import * as fs from 'node:fs';

type LockAcquireOptions = {
  timeoutMs: number | undefined;
  pollIntervalMs: number | undefined;
  staleMs: number | undefined;
};

type LockAcquireResult =
  | {
      ok: true;
      release: () => void;
    }
  | {
      ok: false;
      error: string;
    };

const DEFAULT_LOCK_ACQUIRE_OPTIONS: LockAcquireOptions = {
  timeoutMs: undefined,
  pollIntervalMs: undefined,
  staleMs: undefined,
};

const getNodeErrorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

const normalizeOptionalDuration = (value: unknown, fallback: number, minValue: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minValue, Math.floor(value))
    : fallback;

const sleepSync = (ms: number) => {
  const duration = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (duration <= 0) return;

  // Block the current thread without burning CPU.
   
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
};

const isLockStale = (lockPath: string, staleMs: number) => {
  const ttl = Number.isFinite(staleMs) ? Math.max(0, Math.floor(staleMs)) : 0;
  if (!ttl) return false;

  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > ttl;
  } catch {
    return false;
  }
};

const acquireFileLock = (
  lockPath: string,
  options: LockAcquireOptions = DEFAULT_LOCK_ACQUIRE_OPTIONS,
): LockAcquireResult => {
  const timeoutMs = normalizeOptionalDuration(options.timeoutMs, 5000, 0);
  const pollIntervalMs = normalizeOptionalDuration(options.pollIntervalMs, 50, 1);
  const staleMs = normalizeOptionalDuration(options.staleMs, 30000, 0);

  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
          'utf-8',
        );
      } catch {
        // ignore
      }
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }

      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
          } catch {
            // ignore
          }
        },
      };
    } catch (error) {
      const code = getNodeErrorCode(error);
      if (code !== 'EEXIST') {
        return { ok: false, error: error instanceof Error ? error.message : String(error || 'lock_failed') };
      }

      if (isLockStale(lockPath, staleMs)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // ignore
        }
      }
      sleepSync(pollIntervalMs);
    }
  }

  return { ok: false, error: 'lock_timeout' };
};

const withFileLock = <T,>(
  lockPath: string,
  fn: () => T,
  options: LockAcquireOptions = DEFAULT_LOCK_ACQUIRE_OPTIONS,
) => {
  const acquired = acquireFileLock(lockPath, options);
  if (!acquired.ok) {
    return { ok: false, error: acquired.error };
  }
  try {
    const result = fn();
    return { ok: true, result };
  } finally {
    try {
      acquired.release();
    } catch {
      // ignore
    }
  }
};

export {
  acquireFileLock,
  withFileLock,
};
