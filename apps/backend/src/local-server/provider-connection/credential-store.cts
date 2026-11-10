import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CredentialProtection, CredentialReadStatus } from '@iart/contracts';
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
 * 文件结构（fallback）：
 * { version: 1, updatedAt: ISO, entries: Record<credential_ref, {
 *     version: number, payload: string, scheme?: 'os_safe_storage'|'obfuscated',
 *     lastReadFailureAt: string|null, updatedAt: ISO }> }
 *
 * 加密方案自描述（2026-10-29 事故修复）：
 * - `scheme` 记录写入时**实际走通**的方案；读取只按 scheme 解释，不再靠「解密失败就回退
 *   base64」猜测——旧猜测逻辑在宿主安全存储解密失败时把**密文**当明文返回，制造出
 *   `Authorization: Bearer <乱码>` 的静默失败。
 * - 历史条目无 scheme：按 payload base64 解码后前 3 字节前缀一次性判定（`v10`/`v11` →
 *   `os_safe_storage`，否则 `obfuscated`），下次写入落成显式 scheme。
 * - `lastReadFailureAt`：最近一次读取失败时刻（ISO），一次成功读取或凭证重新保存即清除；
 *   后端路由层据此把连接的凭证状态投影为 `needs_reentry`。
 */

const CREDENTIALS_FILE_VERSION = 1;

/** 历史 safeStorage blob 的明文前缀（macOS Keychain 在密文头部写入版本标记）。 */
const SAFE_STORAGE_PAYLOAD_PREFIXES = ['v10', 'v11'] as const;

interface CredentialFileEntry {
  version: number;
  payload: string;
  /** 写入时实际走通的方案；历史条目缺失（读取时按 payload 前缀判定）。 */
  scheme?: CredentialProtection;
  /** 最近一次读取失败时刻（ISO）；null = 从未失败或最近一次成功已清除。 */
  lastReadFailureAt: string | null;
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

const readScheme = (value: unknown): CredentialProtection | undefined =>
  value === 'os_safe_storage' || value === 'obfuscated' ? value : undefined;

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
      const e = entry as { version: unknown; payload: unknown; scheme: unknown; lastReadFailureAt: unknown; updatedAt: unknown };
      if (!Number.isFinite(Number(e.version))) return;
      if (typeof e.payload !== 'string' || !e.payload.trim()) return;
      // 手写白名单：新增字段必须在这里登记，否则下次写入会被丢掉（scheme 属读取语义事实源）。
      const scheme = readScheme(e.scheme);
      entries[ref] = {
        version: Number(e.version),
        payload: e.payload.trim(),
        ...(scheme ? { scheme } : {}),
        lastReadFailureAt: typeof e.lastReadFailureAt === 'string' && e.lastReadFailureAt.trim()
          ? e.lastReadFailureAt.trim()
          : null,
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

/** 写入结果：payload 与**实际走通**的方案一起返回，供条目自描述落盘。 */
type EncryptedPayload = {
  payload: string;
  scheme: CredentialProtection;
};

const encryptPayload = async (value: string): Promise<EncryptedPayload> => {
  const ss = getCrypto();
  if (ss) {
    try {
      if (await ss.isEncryptionAvailable()) {
        const buf = await ss.encryptString(value);
        return { payload: buf.toString('base64'), scheme: 'os_safe_storage' };
      }
      // 宿主安全存储不可用：降级为 base64 弱保护，按实际 scheme 落盘并留痕
      //（AGENTS.md「条件跳过必须留痕」；降级允许，但必须可投影给用户）。
      // 降到 warn：这是保护等级的实际下降，排查「钥匙串授权失效」时它是第一现场证据。
      loggingModule.logWarn('[credential-store] encryptPayload: safeStorage unavailable, falling back to obfuscated', {});
    } catch (error) {
      // 注入实现异常（IPC 不可用等）：同样降级，并留痕。
      loggingModule.logWarn('[credential-store] encryptPayload: crypto provider failed, falling back to obfuscated', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    loggingModule.logDebug('[credential-store] encryptPayload: no crypto provider injected, using obfuscated', {});
  }
  // 降级路径：非敏感混淆（至少不以明文落文件直接可读，满足 has_credential 脱敏口径）
  return { payload: Buffer.from(value, 'utf8').toString('base64'), scheme: 'obfuscated' };
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const isBase64Payload = (value: string): boolean =>
  value.length % 4 === 0 && BASE64_PATTERN.test(value);

/**
 * `obfuscated` 方案解码：base64 → **fatal UTF-8**。
 * 非法 base64 或解码出非法 UTF-8 一律判定不可读，绝不产出可能被当作明文的字符串。
 */
const decodeObfuscatedPayload = (payload: string): string | null => {
  if (!isBase64Payload(payload)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64'));
  } catch {
    return null;
  }
};

/**
 * 历史条目（无 scheme）的一次性判定：payload base64 解码后前 3 字节为 `v10`/`v11` 视为
 * 宿主安全存储密文，否则视为 base64 弱保护。base64 本身不合法 → 不可读。
 *
 * 判定结果只用于本次读取；下次写入由 `encryptPayload` 落成显式 scheme。
 */
const detectLegacyScheme = (payload: string): CredentialProtection | null => {
  if (!isBase64Payload(payload)) return null;
  const prefix = Buffer.from(payload, 'base64').subarray(0, 3).toString('latin1');
  return SAFE_STORAGE_PAYLOAD_PREFIXES.some((marker) => prefix === marker)
    ? 'os_safe_storage'
    : 'obfuscated';
};

type EntryReadOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: 'unreadable' };

/**
 * 按条目 scheme 解释 payload。**只按声明解释，不做任何猜测回退**：
 * - `os_safe_storage`：必须经注入的 crypto provider 解密成功；provider 缺失、
 *   `isEncryptionAvailable` 为 false、解密抛错，一律不可读（含历史上的跨安装目录钥匙串授权失效）。
 * - `obfuscated`：base64 + fatal UTF-8 解码，失败即不可读。
 */
const readEntryValue = async (entry: CredentialFileEntry): Promise<EntryReadOutcome> => {
  const scheme = entry.scheme ?? detectLegacyScheme(entry.payload);
  if (scheme === null) return { ok: false, reason: 'unreadable' };
  if (scheme === 'os_safe_storage') {
    const ss = getCrypto();
    if (!ss) return { ok: false, reason: 'unreadable' };
    try {
      if (!(await ss.isEncryptionAvailable())) return { ok: false, reason: 'unreadable' };
      const plaintext = await ss.decryptString(Buffer.from(entry.payload, 'base64'));
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        return { ok: false, reason: 'unreadable' };
      }
      return { ok: true, value: plaintext };
    } catch {
      // 底层异常原文（ByteString / safeStorage 报错）不得外传：只按不可读处理。
      return { ok: false, reason: 'unreadable' };
    }
  }
  const decoded = decodeObfuscatedPayload(entry.payload);
  if (decoded === null || decoded.length === 0) return { ok: false, reason: 'unreadable' };
  return { ok: true, value: decoded };
};

// ---- public API ----

const normalizeRef = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildCredentialRef = (connectionId: string): string => `cred_${connectionId}`;

/**
 * 为指定连接写入凭证（覆盖即轮换，version 自增）。
 * 返回 { credentialRef, version } 供 ProviderConnection 持久化。
 * 加密可能跨 IPC 往返（safeStorage），故为 async。
 *
 * 重新保存（含轮换）同时清除该条目的读取失败留痕（用户已按提示重新填写）。
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
  const encrypted = await encryptPayload(value);
  const next: CredentialFile = {
    ...file,
    entries: {
      ...file.entries,
      [ref]: {
        version: nextVersion,
        payload: encrypted.payload,
        scheme: encrypted.scheme,
        lastReadFailureAt: null,
        updatedAt: new Date().toISOString(),
      },
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

/** `readCredentialValue` 的失败原因（`absent` 与「存在但读不出来」必须可区分）。 */
type CredentialReadFailureReason = 'absent' | 'unreadable';

type CredentialReadResult =
  | { ok: true; value: string }
  | { ok: false; reason: CredentialReadFailureReason };

/**
 * 读取失败留痕：只在状态真正变化时写盘（避免每次读取都落盘）。
 * `failed=true` 首次置位 ISO 时刻（连续失败保持首次时刻，不刷新），`failed=false` 清除。
 */
const commitReadFailureState = (ref: string, failed: boolean): void => {
  const file = getFile();
  const entry = file.entries[ref];
  if (!entry) return;
  if (failed) {
    if (entry.lastReadFailureAt !== null) return;
  } else if (entry.lastReadFailureAt === null) {
    return;
  }
  const nextFailureAt = failed ? new Date().toISOString() : null;
  commitFile({
    ...file,
    entries: {
      ...file.entries,
      [ref]: { ...entry, lastReadFailureAt: nextFailureAt },
    },
  });
};

/**
 * 内部明文读取（仅供 Runtime Backend 执行时 acquireLease 调用，不向 Hub/Editor 暴露）。
 * 解密可能跨 IPC 往返（safeStorage），故为 async。
 *
 * 返回判别式结果：`absent`（没有条目）与 `unreadable`（有条目但按 scheme 解不出来）
 * 由调用方分别转成用户可理解的失败，不再用同一个 `null` 混同。
 */
const readCredentialValue = async (credentialRef: unknown): Promise<CredentialReadResult> => {
  const ref = normalizeRef(credentialRef);
  if (!ref) {
    loggingModule.logDebug('[credential-store] readCredentialValue: empty ref', { ref: String(credentialRef) });
    return { ok: false, reason: 'absent' };
  }
  const file = getFile();
  const entry = file.entries[ref];
  if (!entry) {
    loggingModule.logDebug('[credential-store] readCredentialValue: ref not found', { ref });
    return { ok: false, reason: 'absent' };
  }
  const outcome = await readEntryValue(entry);
  if (!outcome.ok) {
    // 不可读必须留痕：只写引用与原因，禁止写入任何密文/明文片段。
    loggingModule.logWarn('[credential-store] credential unreadable', {
      credentialRef: ref,
      reason: 'unreadable',
    });
    commitReadFailureState(ref, true);
    return { ok: false, reason: 'unreadable' };
  }
  commitReadFailureState(ref, false);
  return { ok: true, value: outcome.value };
};

/**
 * 凭证投影（供后端路由层合成 ProviderConnection DTO，凭证存储是唯一 owner）。
 * 无条目时返回双 null；`needs_reentry` 依据最近一次读取失败留痕。
 */
type CredentialProjection = {
  credential_protection: CredentialProtection | null;
  credential_status: CredentialReadStatus | null;
};

const getCredentialProjection = (credentialRef: unknown): CredentialProjection => {
  const ref = normalizeRef(credentialRef);
  if (!ref) return { credential_protection: null, credential_status: null };
  const entry = getFile().entries[ref];
  if (!entry) return { credential_protection: null, credential_status: null };
  return {
    credential_protection: entry.scheme ?? detectLegacyScheme(entry.payload),
    credential_status: entry.lastReadFailureAt !== null ? 'needs_reentry' : 'ready',
  };
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

/** 租约获取失败原因：与任务失败 `details.reason` 值域一致。 */
type CredentialLeaseFailureReason = 'absent' | 'unreadable' | 'version_mismatch';

type AcquireLeaseResult =
  | { ok: true; lease: CredentialLease; value: string }
  | { ok: false; reason: CredentialLeaseFailureReason };

const acquireLease = async (params: {
  connectionId: string;
  credentialRef: string;
  credentialVersion: number;
  connectionRevision: number;
}): Promise<AcquireLeaseResult> => {
  const { connectionId, credentialRef, credentialVersion, connectionRevision } = params;
  const read = await readCredentialValue(credentialRef);
  if (!read.ok) {
    loggingModule.logWarn('[credential-store] acquireLease: credential unavailable', {
      credentialRef,
      connectionId,
      reason: read.reason,
    });
    return { ok: false, reason: read.reason };
  }
  const storedVersion = getCredentialVersion(credentialRef);
  // 版本漂移即「任务用过的密钥已被更换或删除」：快照冻结的是旧版本，继续用新密钥会让
  // 用户以为任务执行基于自己提交时的那把 Key，且无法解释远端鉴权失败。请求版本未知（0）时
  // 不判定漂移，保持历史行为。
  if (storedVersion !== null && credentialVersion > 0 && storedVersion !== credentialVersion) {
    loggingModule.logWarn('[credential-store] acquireLease: credential version mismatch', {
      credentialRef,
      connectionId,
      reason: 'version_mismatch',
    });
    return { ok: false, reason: 'version_mismatch' };
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
  return { ok: true, lease, value: read.value };
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

/** 测试专用：清空文件缓存与租约表（存储根切换后避免跨用例串数据）。 */
const clearCacheForTest = (): void => {
  fileCache = null;
  leaseById.clear();
  leasesByRef.clear();
};

export {
  type CredentialLease,
  type CredentialCrypto,
  type CredentialReadResult,
  type CredentialReadFailureReason,
  type CredentialLeaseFailureReason,
  type AcquireLeaseResult,
  type CredentialProjection,
  setCredentialForConnection,
  hasCredential,
  getCredentialVersion,
  readCredentialValue,
  getCredentialProjection,
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
  clearCacheForTest,
};
