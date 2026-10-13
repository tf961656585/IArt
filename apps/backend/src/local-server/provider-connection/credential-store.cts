import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as loggingModule from '../logging.cts';
import { ensureStorageDirs } from '../storage.cts';
import { isPlainObject } from '../utils.cts';

/**
 * Credential 存储与租约（spec 03 §5）。
 *
 * 存储分层：
 * - 真实 Key 只进操作系统安全存储（Electron safeStorage，Q2-A）；Renderer/Hub/Editor 永远不读明文
 * - 本文件为 Runtime Backend 的凭证管理面：对外只存 credential_ref / has_credential / version，
 *   明文仅在任务执行前经 acquireLease 一次性取出，任务终态后 releaseLease
 * - Fallback：非 Electron 运行时（单测 / CI / dev 纯 Node）走本地加密文件
 *   `config/provider-credentials.json`（权限 0600 的 JSON，value 经 base64 混淆，非明文落日志）
 *
 * 文件结构（fallback）：{ version: 1, updatedAt: ISO, entries: Record<credential_ref, { version: number, payload: string }> }
 * - payload 为加密后 blob（Electron 时为 safeStorage.encryptString 后的 buffer base64，fallback 时为明文 base64）
 */

const CREDENTIALS_FILE_VERSION = 1;

interface CredentialFileEntry {
  version: number;
  payload: string;
  updatedAt: string;
}

interface CredentialFile {
  version: number;
  updatedAt: string;
  entries: Record<string, CredentialFileEntry>;
}

type CredentialPathMap = { providerCredentials: string | undefined };

const asCredentialPathMap = (value: unknown): CredentialPathMap | null =>
  isPlainObject(value) ? (value as CredentialPathMap) : null;

const getCredentialFilePath = (paths: unknown): string | null => {
  const record = asCredentialPathMap(paths);
  const filePath = record !== null && record !== undefined ? (record as { providerCredentials?: unknown }).providerCredentials : undefined;
  // storage.cts 新字段 providerCredentials 尚未在部分历史路径兼容时，回退到 config/provider-credentials.json
  if (typeof filePath === 'string' && filePath.trim()) return filePath.trim();
  // fallback: 尝试从 configRoot 推导
  const anyPaths = paths as { config?: string } | null;
  if (anyPaths && typeof anyPaths.config === 'string' && anyPaths.config.trim()) {
    return path.join(anyPaths.config.trim(), 'provider-credentials.json');
  }
  return null;
};

const buildEmptyFile = (): CredentialFile => ({
  version: CREDENTIALS_FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  entries: {},
});

const normalizeFile = (raw: unknown): CredentialFile | null => {
  if (!isPlainObject(raw)) return null;
  const version = Number((raw as { version: unknown }).version);
  if (!Number.isFinite(version) || version !== CREDENTIALS_FILE_VERSION) {
    loggingModule.logDebug('[credential-store] normalizeFile: unsupported version', { version });
    return null;
  }
  const entries: Record<string, CredentialFileEntry> = {};
  const rawEntries = (raw as { entries: unknown }).entries;
  if (isPlainObject(rawEntries)) {
    Object.entries(rawEntries).forEach(([ref, entry]) => {
      if (!isPlainObject(entry)) return;
      const e = entry as { version: unknown; payload: unknown; updatedAt: unknown };
      if (!Number.isFinite(Number(e.version))) return;
      if (typeof e.payload !== 'string' || !e.payload.trim()) return;
      entries[ref] = {
        version: Number(e.version),
        payload: e.payload.trim(),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
      };
    });
  }
  return {
    version: CREDENTIALS_FILE_VERSION,
    updatedAt: typeof (raw as { updatedAt: unknown }).updatedAt === 'string' ? String((raw as { updatedAt: unknown }).updatedAt) : new Date(0).toISOString(),
    entries,
  };
};

const readFileFromDisk = (paths: unknown): CredentialFile | null => {
  const filePath = getCredentialFilePath(paths);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeFile(parsed);
  } catch {
    return null;
  }
};

const writeFileToDisk = (paths: unknown, file: CredentialFile): void => {
  const filePath = getCredentialFilePath(paths);
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
  } catch (error) {
    loggingModule.logError('[credential-store] writeFileToDisk failed', { error: error instanceof Error ? error.message : String(error) });
  }
};

let fileCache: CredentialFile | null = null;

type StoragePathsShape = { providerCredentials?: string; config: string };

const toStoragePathsShape = (value: unknown): StoragePathsShape | null =>
  isPlainObject(value) ? (value as StoragePathsShape) : null;

const getFile = (): CredentialFile => {
  if (fileCache) return fileCache;
  const rawPaths: unknown = ensureStorageDirs();
  const shaped = toStoragePathsShape(rawPaths);
  const hasNewField = typeof shaped?.providerCredentials === 'string' && shaped.providerCredentials.trim().length > 0;
  const effectivePaths: unknown = hasNewField && shaped
    ? shaped
    : shaped && typeof shaped.config === 'string'
      ? { providerCredentials: path.join(shaped.config, 'provider-credentials.json') }
      : rawPaths;
  fileCache = readFileFromDisk(effectivePaths) ?? buildEmptyFile();
  return fileCache;
};

const commitFile = (next: CredentialFile): CredentialFile => {
  const updated: CredentialFile = { ...next, updatedAt: new Date().toISOString() };
  const rawPaths: unknown = ensureStorageDirs();
  const shaped = toStoragePathsShape(rawPaths);
  const hasNewField = typeof shaped?.providerCredentials === 'string' && shaped.providerCredentials.trim().length > 0;
  const effectivePaths: unknown = hasNewField && shaped
    ? shaped
    : shaped && typeof shaped.config === 'string'
      ? { providerCredentials: path.join(shaped.config, 'provider-credentials.json') }
      : rawPaths;
  fileCache = updated;
  writeFileToDisk(effectivePaths, updated);
  return updated;
};

// ---- 凭证加解密抽象（Backend 去 electron 化） ----
// Backend 打包运行时禁止直接 import/require('electron')（guard:desktop-runtime-deps）。
// 历史实现在此通过 require('electron').safeStorage 做操作系统级加解密，但这把
// Backend 与 Electron 宿主强耦合，违背“Backend 单进程纯 Node、Desktop Shell 持有
// Electron”分层。现改为可注入的加解密抽象：
// - 默认走本地 base64 混淆（文件权限 0600，非明文落盘，满足 has_credential 脱敏口径；
//   单测/CI/dev 纯 Node 与当前线上 fallback 一致）。
// - 如需操作系统安全存储（spec 03 §5 Q2-A），由 Desktop Shell 在宿主进程内使用
//   electron.safeStorage 实现，通过 IPC 请求-响应通道向 Backend 提供加解密能力
//   （runtime:credential-crypto-*，见 packages/contracts credential-crypto-ipc.ts）。
//   IPC 天然异步，故 CredentialCrypto 方法为 async；注入点由 Backend 启动处（main.cts）
//   经 setCredentialCryptoProvider 接线。Backend 自身始终不持有对 'electron' 的静态引用，
//   满足打包依赖闭包门禁。

type CredentialCrypto = {
  encryptString(value: string): Promise<Buffer>;
  decryptString(buffer: Buffer): Promise<string>;
  isEncryptionAvailable(): Promise<boolean>;
};

let injectedCrypto: CredentialCrypto | null = null;

/**
 * 注入由 Desktop Shell 提供的 OS 级加解密实现（例如基于 electron safeStorage）。
 * Backend 不直接 import('electron')，满足 guard:desktop-runtime-deps。
 * 传入 null 可重置为 fallback（用于测试或回退）。
 */
const setCredentialCryptoProvider = (provider: CredentialCrypto | null): void => {
  injectedCrypto = provider;
};

const getCrypto = (): CredentialCrypto | null => injectedCrypto;

const encryptPayload = async (value: string): Promise<string> => {
  const ss = getCrypto();
  if (ss) {
    try {
      if (await ss.isEncryptionAvailable()) {
        const buf = await ss.encryptString(value);
        return buf.toString('base64');
      }
      // safeStorage 不可用：回退本地 base64 混淆（AGENTS.md「条件跳过必须留痕」）。
      loggingModule.logDebug('[credential-store] encryptPayload: safeStorage unavailable, falling back to base64', {});
    } catch (error) {
      // 注入实现异常（IPC 不可用等）：回退 base64，并留痕。
      loggingModule.logDebug('[credential-store] encryptPayload: crypto provider failed, falling back to base64', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    loggingModule.logDebug('[credential-store] encryptPayload: no crypto provider injected, using base64', {});
  }
  // fallback：非敏感混淆（至少不以明文落文件直接可读，满足 has_credential 脱敏口径）
  return Buffer.from(value, 'utf8').toString('base64');
};

const decryptPayload = async (payload: string): Promise<string | null> => {
  const ss = getCrypto();
  if (ss) {
    try {
      if (await ss.isEncryptionAvailable()) {
        const buf = Buffer.from(payload, 'base64');
        return await ss.decryptString(buf);
      }
      loggingModule.logDebug('[credential-store] decryptPayload: safeStorage unavailable, falling back to base64', {});
    } catch {
      // 可能是 fallback 写入的明文 base64，继续尝试
    }
  }
  try {
    return Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return null;
  }
};

// ---- public API ----

const normalizeRef = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildCredentialRef = (connectionId: string): string => `cred_${connectionId}`;

/**
 * 为指定连接写入凭证（覆盖即轮换，version 自增）。
 * 返回 { credentialRef, version } 供 ProviderConnection 持久化。
 * 加密可能跨 IPC 往返（safeStorage），故为 async。
 */
const setCredentialForConnection = async (
  connectionId: unknown,
  rawValue: unknown,
): Promise<{ credentialRef: string; version: number } | null> => {
  const id = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!id) {
    loggingModule.logDebug('[credential-store] setCredential: empty connectionId', { connectionId: String(connectionId) });
    return null;
  }
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    loggingModule.logDebug('[credential-store] setCredential: empty value, early return', { connectionId: id });
    return null;
  }
  const ref = buildCredentialRef(id);
  const file = getFile();
  const existing = file.entries[ref];
  const nextVersion = existing ? existing.version + 1 : 1;
  const payload = await encryptPayload(value);
  const next: CredentialFile = {
    ...file,
    entries: {
      ...file.entries,
      [ref]: { version: nextVersion, payload, updatedAt: new Date().toISOString() },
    },
  };
  commitFile(next);
  return { credentialRef: ref, version: nextVersion };
};

const hasCredential = (credentialRef: unknown): boolean => {
  const ref = normalizeRef(credentialRef);
  if (!ref) return false;
  const file = getFile();
  return Boolean(file.entries[ref]?.payload);
};

const getCredentialVersion = (credentialRef: unknown): number | null => {
  const ref = normalizeRef(credentialRef);
  if (!ref) return null;
  const file = getFile();
  const entry = file.entries[ref];
  return entry ? entry.version : null;
};

/**
 * 内部明文读取（仅供 Runtime Backend 执行时 acquireLease 调用，不向 Hub/Editor 暴露）。
 * 解密可能跨 IPC 往返（safeStorage），故为 async。
 */
const readCredentialValue = async (credentialRef: unknown): Promise<string | null> => {
  const ref = normalizeRef(credentialRef);
  if (!ref) {
    loggingModule.logDebug('[credential-store] readCredentialValue: empty ref', { ref: String(credentialRef) });
    return null;
  }
  const file = getFile();
  const entry = file.entries[ref];
  if (!entry) {
    loggingModule.logDebug('[credential-store] readCredentialValue: ref not found', { ref });
    return null;
  }
  const decrypted = await decryptPayload(entry.payload);
  if (decrypted === null) {
    loggingModule.logDebug('[credential-store] readCredentialValue: decrypt failed', { ref });
    return null;
  }
  return decrypted;
};

const clearCredentialForConnection = (connectionId: unknown): boolean => {
  const id = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!id) {
    loggingModule.logDebug('[credential-store] clearCredential: empty connectionId', { connectionId: String(connectionId) });
    return false;
  }
  const ref = buildCredentialRef(id);
  const file = getFile();
  if (!file.entries[ref]) {
    loggingModule.logDebug('[credential-store] clearCredential: already empty', { ref });
    return false;
  }
  const nextEntries = { ...file.entries };
  delete nextEntries[ref];
  commitFile({ ...file, entries: nextEntries });
  return true;
};

const clearCredentialByRef = (credentialRef: unknown): boolean => {
  const ref = normalizeRef(credentialRef);
  if (!ref) {
    loggingModule.logDebug('[credential-store] clearByRef: empty ref', { ref: String(credentialRef) });
    return false;
  }
  const file = getFile();
  if (!file.entries[ref]) {
    loggingModule.logDebug('[credential-store] clearByRef: already empty', { ref });
    return false;
  }
  const nextEntries = { ...file.entries };
  delete nextEntries[ref];
  commitFile({ ...file, entries: nextEntries });
  return true;
};

// ---- Lease 管理（内存，任务终态释放）----

interface CredentialLease {
  leaseId: string;
  connectionId: string;
  credentialRef: string;
  credentialVersion: number;
  connectionRevision: number;
  createdAt: string;
}

const leaseById = new Map<string, CredentialLease>();
const leasesByRef = new Map<string, Set<string>>();

const acquireLease = async (params: {
  connectionId: string;
  credentialRef: string;
  credentialVersion: number;
  connectionRevision: number;
}): Promise<{ lease: CredentialLease; value: string } | null> => {
  const { connectionId, credentialRef, credentialVersion, connectionRevision } = params;
  const value = await readCredentialValue(credentialRef);
  if (value === null) {
    loggingModule.logDebug('[credential-store] acquireLease: credential missing or unreadable', { credentialRef, connectionId });
    return null;
  }
  const storedVersion = getCredentialVersion(credentialRef);
  if (storedVersion !== null && storedVersion !== credentialVersion) {
    loggingModule.logDebug('[credential-store] acquireLease: version drift, using requested version', {
      credentialRef,
      requested: credentialVersion,
      stored: storedVersion,
    });
  }
  const leaseId = `lease_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const lease: CredentialLease = {
    leaseId,
    connectionId,
    credentialRef,
    credentialVersion,
    connectionRevision,
    createdAt: new Date().toISOString(),
  };
  leaseById.set(leaseId, lease);
  const set = leasesByRef.get(credentialRef) ?? new Set<string>();
  set.add(leaseId);
  leasesByRef.set(credentialRef, set);
  return { lease, value };
};

const releaseLease = (leaseId: string): boolean => {
  const lease = leaseById.get(leaseId);
  if (!lease) {
    loggingModule.logDebug('[credential-store] releaseLease: lease not found', { leaseId });
    return false;
  }
  leaseById.delete(leaseId);
  const set = leasesByRef.get(lease.credentialRef);
  if (set) {
    set.delete(leaseId);
    if (set.size === 0) leasesByRef.delete(lease.credentialRef);
  }
  return true;
};

const releaseLeasesForConnection = (connectionId: string): number => {
  let removed = 0;
  for (const [leaseId, lease] of leaseById.entries()) {
    if (lease.connectionId === connectionId) {
      releaseLease(leaseId);
      removed += 1;
    }
  }
  return removed;
};

const hasActiveLeases = (credentialRef: string): boolean => {
  const set = leasesByRef.get(credentialRef);
  return Boolean(set && set.size > 0);
};

const hasActiveLeasesForConnection = (connectionId: string): boolean => {
  if (!connectionId || typeof connectionId !== 'string' || !connectionId.trim()) return false;
  const cid = connectionId.trim();
  for (const lease of leaseById.values()) {
    if (lease.connectionId === cid) return true;
  }
  return false;
};

const getLease = (leaseId: string): CredentialLease | null => {
  if (!leaseId || typeof leaseId !== 'string') return null;
  return leaseById.get(leaseId) ?? null;
};

export {
  type CredentialLease,
  type CredentialCrypto,
  setCredentialForConnection,
  hasCredential,
  getCredentialVersion,
  readCredentialValue,
  clearCredentialForConnection,
  clearCredentialByRef,
  buildCredentialRef,
  acquireLease,
  releaseLease,
  releaseLeasesForConnection,
  hasActiveLeases,
  hasActiveLeasesForConnection,
  getLease,
  setCredentialCryptoProvider,
};
