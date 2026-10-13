import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOG_LEVEL_ORDER } from './constants.cts';
import { getEffectiveLogLevel } from './config-store.cts';
import { ensureStorageDirs } from './storage.cts';

type LogLevel = keyof typeof LOG_LEVEL_ORDER;

interface StoragePathsWithLogs {
  logs: string;
}

interface LogTail {
  path: string;
  sizeBytes: number;
  updatedAt: string | null;
  lines: string[];
  error: string | undefined;
}

const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVEL_ORDER, value);

const getLogFilePath = (paths: StoragePathsWithLogs) => path.join(paths.logs, 'backend.log');

const rotateLogFile = (filePath: string, maxSizeBytes = 5 * 1024 * 1024, maxFiles = 3) => {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (!stat || stat.size <= maxSizeBytes) return;
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${filePath}.${i}`;
      const dest = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // ignore rotation failures
  }
};

const shouldLog = (level: unknown) => {
  const current = getEffectiveLogLevel();
  const currentLevel = isLogLevel(current) ? LOG_LEVEL_ORDER[current] : LOG_LEVEL_ORDER.info;
  const targetLevel = isLogLevel(level) ? LOG_LEVEL_ORDER[level] : LOG_LEVEL_ORDER.info;
  return targetLevel >= currentLevel;
};

const formatBeijingTimestamp = (): string => {
  const now = new Date();
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(now.getTime() + beijingOffset);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${beijingTime.getUTCFullYear()}-${pad(beijingTime.getUTCMonth() + 1)}-${pad(beijingTime.getUTCDate())} ${pad(beijingTime.getUTCHours())}:${pad(beijingTime.getUTCMinutes())}:${pad(beijingTime.getUTCSeconds())}.${ms}`;
};

const writeLogLine = (level: LogLevel, message: unknown, meta: unknown | undefined) => {
  if (!shouldLog(level)) return;
  const paths = ensureStorageDirs();
  const filePath = getLogFilePath(paths);
  rotateLogFile(filePath);
  const timestamp = formatBeijingTimestamp();
  const metaText = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${timestamp}] [${level}] ${message}${metaText}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch {
    // ignore
  }
};

const logDebug = (message: unknown, meta: unknown | undefined) => writeLogLine('debug', message, meta);
const logInfo = (message: unknown, meta: unknown | undefined) => writeLogLine('info', message, meta);
const logWarn = (message: unknown, meta: unknown | undefined) => writeLogLine('warn', message, meta);
const logError = (message: unknown, meta: unknown | undefined) => writeLogLine('error', message, meta);

const readLogTail = (filePath: string, maxLines = 200): LogTail => {
  try {
    if (!fs.existsSync(filePath)) {
      return { path: filePath, sizeBytes: 0, updatedAt: null, lines: [], error: undefined };
    }
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxLines);
    return {
      path: filePath,
      sizeBytes: stat.size ?? 0,
      updatedAt: stat.mtime ? stat.mtime.toISOString() : null,
      lines: tail,
      error: undefined,
    };
  } catch (error) {
    return {
      path: filePath,
      sizeBytes: 0,
      updatedAt: null,
      lines: [],
      error: String(error),
    };
  }
};

export {
  getLogFilePath,
  rotateLogFile,
  shouldLog,
  writeLogLine,
  logDebug,
  logInfo,
  logWarn,
  logError,
  readLogTail,
};
