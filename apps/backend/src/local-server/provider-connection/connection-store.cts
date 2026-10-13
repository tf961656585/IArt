import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  ProviderConnectionSchema,
  type ProviderConnection,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';

/**
 * ProviderConnection 持久化（spec 03 §4）。
 *
 * - spec 03 §4 ProviderConnection：全局本机、地址+凭证、Base URL 规范化、lifecycle、revision、credential_ref；
 *   连接级 `protocol_adapter_id`（默认接口类型预选）已退役（2026-09-29 起），接口类型只在
 *   「添加模型」时随模型记录配置；存量文件里的遗留键仅为对话模型 v1/v2→v3 迁移回填保留读取
 * - spec 03 §5 Credential 与租约：连接只存 credential_ref / version / has_credential
 * - 持久化文件：config/provider-connections.json（storage.cts getStoragePaths().providerConnections）
 * - Base URL 规范化：去 query/fragment、去尾斜杠、必须 https://（spec 4.2）
 */

const FILE_VERSION = 1;

interface ProviderConnectionsFile {
  version: number;
  updatedAt: string;
  connections: ProviderConnection[];
}

type ProviderConnectionsPathMap = { providerConnections: string | undefined };

const asPathMap = (value: unknown): ProviderConnectionsPathMap | null =>
  isPlainObject(value) ? (value as ProviderConnectionsPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.providerConnections : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): ProviderConnectionsFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  connections: [],
});

const normalizeBaseUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    let normalized = url.toString();
    if (normalized.endsWith('/') && !normalized.endsWith('://')) {
      normalized = normalized.replace(/\/+$/, '');
    }
    if (!normalized.startsWith('https://')) return null;
    return normalized;
  } catch {
    return null;
  }
};

const normalizeFile = (raw: unknown): ProviderConnectionsFile | null => {
  if (!isPlainObject(raw)) return null;
  const version = Number((raw as { version: unknown }).version);
  if (!Number.isFinite(version) || version !== FILE_VERSION) {
    loggingModule.logDebug('[connection-store] normalizeFile: unsupported version', { version });
    return null;
  }
  const connections: ProviderConnection[] = [];
  const rawConnections = (raw as { connections: unknown }).connections;
  if (Array.isArray(rawConnections)) {
    rawConnections.forEach((entry, index) => {
      const parsed = ProviderConnectionSchema.safeParse(entry);
      if (!parsed.success) {
        loggingModule.logDebug('[connection-store] drop invalid connection entry', {
          index,
          error: parsed.error.message,
        });
        return;
      }
      // 连接级 `protocol_adapter_id`（默认接口类型预选）已退役：新创建的连接不携带该字段，
      // 存量文件里的遗留键仅为对话模型 v1/v2→v3 迁移回填保留读取。读盘不再按该字段做任何
      // 判定——原「adapter 缺失即丢弃整条连接」的守卫会吞掉无字段连接，已删除。
      const normalized = normalizeBaseUrl(parsed.data.base_url);
      if (!normalized) {
        loggingModule.logDebug('[connection-store] drop connection with invalid base_url', {
          connectionId: parsed.data.connection_id,
          baseUrl: parsed.data.base_url,
        });
        return;
      }
      connections.push({ ...parsed.data, base_url: normalized });
    });
  } else {
    loggingModule.logDebug('[connection-store] connections field is not an array, treat as empty', {
      type: typeof rawConnections,
    });
  }
  return {
    version: FILE_VERSION,
    updatedAt: typeof (raw as { updatedAt: unknown }).updatedAt === 'string' ? String((raw as { updatedAt: unknown }).updatedAt) : new Date(0).toISOString(),
    connections,
  };
};

const readFromDisk = (paths: unknown): ProviderConnectionsFile | null => {
  const filePath = getFilePath(paths);
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

const writeToDisk = (paths: unknown, file: ProviderConnectionsFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: ProviderConnectionsFile | null = null;

const getFile = (): ProviderConnectionsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

const commitFile = (next: ProviderConnectionsFile): ProviderConnectionsFile => {
  const updated: ProviderConnectionsFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  cache = updated;
  writeToDisk(paths, updated);
  return updated;
};

const normalizeConnectionId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^up_conn_[a-z0-9][a-z0-9-_]*$/.test(trimmed) ? trimmed : '';
};

const generateConnectionId = (): string => {
  const rand = crypto.randomBytes(4).toString('hex').toLowerCase();
  const ts = Date.now().toString(36).toLowerCase();
  return `up_conn_${ts}_${rand}`;
};

const normalizeDisplayName = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const listConnections = (): ProviderConnection[] => {
  const file = getFile();
  return [...file.connections].sort((a, b) => a.created_at.localeCompare(b.created_at));
};

const getConnection = (connectionId: unknown): ProviderConnection | null => {
  const id = normalizeConnectionId(connectionId);
  if (!id) {
    loggingModule.logDebug('[connection-store] getConnection: empty or invalid id', { connectionId: String(connectionId) });
    return null;
  }
  const file = getFile();
  const found = file.connections.find((c) => c.connection_id === id);
  if (!found) {
    loggingModule.logDebug('[connection-store] getConnection: not found', { connectionId: id });
    return null;
  }
  return found;
};

const createConnection = (input: {
  display_name: string;
  base_url: string;
}): ProviderConnection => {
  const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : '';
  if (!displayName) throw new Error('[connection-store] display_name is required');
  const normalizedBaseUrl = normalizeBaseUrl(input.base_url);
  if (!normalizedBaseUrl) throw new Error('[connection-store] base_url must be a valid https:// URL without query/fragment');
  const now = new Date().toISOString();
  // 连接不再承载接口类型预选（2026-09-29 起）：新创建的连接不携带 protocol_adapter_id，
  // 接口类型只在「添加模型」时随模型记录配置。
  const connection: ProviderConnection = {
    connection_id: generateConnectionId(),
    display_name: displayName,
    base_url: normalizedBaseUrl,
    has_credential: false,
    lifecycle: 'enabled',
    revision: 0,
    created_at: now,
    updated_at: now,
  };
  const file = getFile();
  commitFile({ ...file, connections: [...file.connections, connection] });
  return connection;
};

const updateConnection = (
  connectionId: unknown,
  patch: { display_name?: string; base_url?: string },
): ProviderConnection | null => {
  const id = normalizeConnectionId(connectionId);
  if (!id) {
    loggingModule.logDebug('[connection-store] updateConnection: invalid id', { connectionId: String(connectionId) });
    return null;
  }
  const file = getFile();
  const index = file.connections.findIndex((c) => c.connection_id === id);
  if (index < 0) {
    loggingModule.logDebug('[connection-store] updateConnection: not found', { connectionId: id });
    return null;
  }
  const existing = file.connections[index];
  if (!existing) {
    loggingModule.logDebug('[connection-store] updateConnection: unexpectedly missing at index', { connectionId: id, index });
    return null;
  }
  if (existing.lifecycle === 'retired') {
    loggingModule.logDebug('[connection-store] updateConnection: retired connection cannot be updated', { connectionId: id });
    throw new Error('[connection-store] retired connection cannot be updated');
  }
  let next: ProviderConnection = { ...existing };
  if (patch.display_name !== undefined) {
    const trimmed = normalizeDisplayName(patch.display_name);
    if (!trimmed) throw new Error('[connection-store] display_name must be non-empty');
    next.display_name = trimmed;
  }
  if (patch.base_url !== undefined) {
    const normalized = normalizeBaseUrl(patch.base_url);
    if (!normalized) throw new Error('[connection-store] base_url must be a valid https:// URL');
    next.base_url = normalized;
  }
  const now = new Date().toISOString();
  next = { ...next, revision: existing.revision + 1, updated_at: now };
  const parsed = ProviderConnectionSchema.safeParse(next);
  if (!parsed.success) throw new Error(`[connection-store] merged connection invalid: ${parsed.error.message}`);
  const nextConnections = file.connections.map((c, i) => (i === index ? parsed.data : c));
  commitFile({ ...file, connections: nextConnections });
  return parsed.data;
};

const setConnectionLifecycle = (
  connectionId: unknown,
  lifecycle: unknown,
): ProviderConnection | null => {
  const id = normalizeConnectionId(connectionId);
  if (!id) {
    loggingModule.logDebug('[connection-store] setLifecycle: invalid id', { connectionId: String(connectionId) });
    return null;
  }
  if (lifecycle !== 'enabled' && lifecycle !== 'disabled' && lifecycle !== 'retired') {
    loggingModule.logDebug('[connection-store] setLifecycle: invalid lifecycle', { connectionId: id, lifecycle: String(lifecycle) });
    return null;
  }
  const file = getFile();
  const index = file.connections.findIndex((c) => c.connection_id === id);
  if (index < 0) {
    loggingModule.logDebug('[connection-store] setLifecycle: not found', { connectionId: id });
    return null;
  }
  const existingCandidate = file.connections[index];
  if (!existingCandidate) {
    loggingModule.logDebug('[connection-store] setLifecycle: unexpectedly missing at index', { connectionId: id, index });
    return null;
  }
  const existing = existingCandidate;
  if (existing.lifecycle === 'retired' && lifecycle !== 'retired') {
    loggingModule.logDebug('[connection-store] setLifecycle: retired is terminal, cannot revert', { connectionId: id });
    throw new Error('[connection-store] retired connection cannot be re-enabled');
  }
  if (existing.lifecycle === lifecycle) return existing;
  const now = new Date().toISOString();
  const next: ProviderConnection = { ...existing, lifecycle: lifecycle as ProviderConnection['lifecycle'], revision: existing.revision + 1, updated_at: now };
  const nextConnections = file.connections.map((c, i) => (i === index ? next : c));
  commitFile({ ...file, connections: nextConnections });
  return next;
};

const setConnectionCredential = (
  connectionId: unknown,
  credentialRef: string | null,
  credentialVersion: number | null,
  hasCredential: boolean,
): ProviderConnection | null => {
  const id = normalizeConnectionId(connectionId);
  if (!id) {
    loggingModule.logDebug('[connection-store] setConnectionCredential: invalid id', { connectionId: String(connectionId) });
    return null;
  }
  const file = getFile();
  const index = file.connections.findIndex((c) => c.connection_id === id);
  if (index < 0) {
    loggingModule.logDebug('[connection-store] setConnectionCredential: not found', { connectionId: id });
    return null;
  }
  const existingCandidate2 = file.connections[index];
  if (!existingCandidate2) {
    loggingModule.logDebug('[connection-store] setConnectionCredential: unexpectedly missing at index', { connectionId: id, index });
    return null;
  }
  const existing = existingCandidate2;
  if (existing.lifecycle === 'retired') {
    loggingModule.logDebug('[connection-store] setConnectionCredential: retired connection cannot bind credential', { connectionId: id });
    throw new Error('[connection-store] retired connection cannot bind credential');
  }
  const now = new Date().toISOString();
  let next: ProviderConnection;
  if (credentialRef === null || credentialVersion === null || !hasCredential) {
    const base: ProviderConnection = { ...existing, has_credential: false, revision: existing.revision + 1, updated_at: now };
    // 删除可选字段
    const withOptional = base as ProviderConnection & { credential_ref?: string; credential_version?: number };
    delete withOptional.credential_ref;
    delete withOptional.credential_version;
    next = base;
  } else {
    next = {
      ...existing,
      credential_ref: credentialRef,
      credential_version: credentialVersion,
      has_credential: true,
      revision: existing.revision + 1,
      updated_at: now,
    };
  }
  const parsed = ProviderConnectionSchema.safeParse(next);
  if (!parsed.success) throw new Error(`[connection-store] credential bind invalid: ${parsed.error.message}`);
  const nextConnections = file.connections.map((c, i) => (i === index ? parsed.data : c));
  commitFile({ ...file, connections: nextConnections });
  return parsed.data;
};

const removeConnection = (connectionId: unknown): boolean => {
  const id = normalizeConnectionId(connectionId);
  if (!id) {
    loggingModule.logDebug('[connection-store] removeConnection: invalid id', { connectionId: String(connectionId) });
    return false;
  }
  const file = getFile();
  const index = file.connections.findIndex((c) => c.connection_id === id);
  if (index < 0) {
    loggingModule.logDebug('[connection-store] removeConnection: not found', { connectionId: id });
    return false;
  }
  const nextConnections = file.connections.filter((c) => c.connection_id !== id);
  commitFile({ ...file, connections: nextConnections });
  return true;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  normalizeBaseUrl,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  setConnectionLifecycle,
  setConnectionCredential,
  removeConnection,
  clearCacheForTest,
  normalizeConnectionId,
  generateConnectionId,
  type ProviderConnectionsFile,
};
