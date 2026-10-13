import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  ModelDeploymentSchema,
  type ModelDeployment,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { getConnection } from './connection-store.cts';
import { resolveClosedFamilyAdapter } from '../model-family-registry.cts';
import { getCustomChatModel } from './custom-chat-model-store.cts';
import { getCustomGenerationModel } from './custom-generation-model-store.cts';

/**
 * ModelDeployment 持久化（spec 03 §6.1；2026-09-25 收窄为「已装能力包模型的接入」）。
 *
 * - 文件：config/model-deployments.json
 * - 约束：model_id + connection_id + remote_model_id 组合唯一；connection 必须存在且 enabled\/有 credential 等
 * - 不存储 active 状态，active 由 active-route-store 单值 Map 承载
 * - **只服务已装能力包模型的接入**：自建模型（对话/生成）是服务商作用域单记录（能力属性与
 *   接入归属一体，见 custom-*-model-store），不再产生 Deployment——本 store 对自建 model_id
 *   显式拒绝，防止绕过单记录写入路径造出僵尸接入
 * - `enabled_thinking_tiers` / `default_thinking_tier` 已随自建声明层合并退役（spec 37 v4.0.0，
 *   档位只随自建对话模型记录走）；存量 v1 文件读取时剥键（sanitize），档位值经
 *   `listLegacyDeploymentThinkingTiers` 交给声明迁移并入记录，不让存量接入静默丢失
 */

const FILE_VERSION = 2;

/** v1 文件里带、v2 已退役的两个档位键（读取侧剥掉，不进 schema）。 */
const RETIRED_TIER_KEYS = ['enabled_thinking_tiers', 'default_thinking_tier'] as const;

interface ModelDeploymentsFile {
  version: number;
  updatedAt: string;
  deployments: ModelDeployment[];
}

type DeploymentsPathMap = { modelDeployments: string | undefined };

const asPathMap = (value: unknown): DeploymentsPathMap | null =>
  isPlainObject(value) ? (value as DeploymentsPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.modelDeployments : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): ModelDeploymentsFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  deployments: [],
});

/**
 * v1 存量接入的档位启用关系（deployment_id → 档位）。
 *
 * 只在读取 v1 文件时填充：声明迁移（custom-chat-model-store 的 v1→v2）按它把档位并入
 * 自建对话记录。map 的生命周期与 deployment store 的缓存一致——文件升级为 v2 后（档位已
 * 并入记录）重读得到空 map，迁移自然不会再拿到旧值。
 */
let legacyThinkingTiers: Map<string, { enabled_thinking_tiers: string[]; default_thinking_tier: string | null }> = new Map();

const asLegacyTiers = (value: unknown): { enabled_thinking_tiers: string[]; default_thinking_tier: string | null } => {
  const source = isPlainObject(value) ? value : {};
  const tiers = Array.isArray(source.enabled_thinking_tiers)
    ? source.enabled_thinking_tiers.filter((item): item is string => typeof item === 'string')
    : [];
  const fallback = typeof source.default_thinking_tier === 'string' ? source.default_thinking_tier : null;
  return { enabled_thinking_tiers: tiers, default_thinking_tier: fallback };
};

/**
 * v1 存量文件里一条 deployment 记录剥键前的原始形状（外部输入边界：字段未校验、逐键探测，
 * 剥键后仍要过 `ModelDeploymentSchema.safeParse` 才入库）。
 */
type LegacyDeploymentRaw = Record<string, unknown>;

const normalizeFile = (raw: unknown): ModelDeploymentsFile | null => {
  if (!isPlainObject(raw)) return null;
  const version = Number((raw as { version: unknown }).version);
  // v1 = 存量文件（带已退役档位键，读取侧剥键）；v2 = 当前形状。其余版本判废。
  if (!Number.isFinite(version) || (version !== 1 && version !== FILE_VERSION)) {
    loggingModule.logDebug('[deployment-store] normalizeFile: unsupported version', { version });
    return null;
  }
  legacyThinkingTiers = new Map();
  const deployments: ModelDeployment[] = [];
  const rawDeployments = (raw as { deployments: unknown }).deployments;
  if (Array.isArray(rawDeployments)) {
    rawDeployments.forEach((entry: unknown, index) => {
      const source: LegacyDeploymentRaw = isPlainObject(entry) ? entry : {};
      if (version === 1) {
        // 剥键（sanitize 式迁移）：档位键随声明层退役，留着会让 .strict() schema 整条 parse
        // 失败、存量接入静默丢失。原值先收进 legacy map 交给声明迁移。
        const legacy = asLegacyTiers(source);
        if (legacy.enabled_thinking_tiers.length > 0 || legacy.default_thinking_tier !== null) {
          const deploymentId = typeof source.deployment_id === 'string' ? source.deployment_id : `index-${index}`;
          legacyThinkingTiers.set(deploymentId, legacy);
        }
        for (const key of RETIRED_TIER_KEYS) delete source[key];
      }
      const parsed = ModelDeploymentSchema.safeParse(source);
      if (!parsed.success) {
        loggingModule.logDebug('[deployment-store] drop invalid deployment', { index, error: parsed.error.message });
        return;
      }
      deployments.push(parsed.data);
    });
  }
  return {
    version: FILE_VERSION,
    updatedAt: typeof (raw as { updatedAt: unknown }).updatedAt === 'string' ? String((raw as { updatedAt: unknown }).updatedAt) : new Date(0).toISOString(),
    deployments,
  };
};

const readFromDisk = (paths: unknown): ModelDeploymentsFile | null => {
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

const writeToDisk = (paths: unknown, file: ModelDeploymentsFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: ModelDeploymentsFile | null = null;

const getFile = (): ModelDeploymentsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

const commitFile = (next: ModelDeploymentsFile): ModelDeploymentsFile => {
  const updated: ModelDeploymentsFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  cache = updated;
  writeToDisk(paths, updated);
  return updated;
};

const normalizeDeploymentId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^up_dep_[a-z0-9][a-z0-9-_]*$/.test(trimmed) ? trimmed : '';
};

const generateDeploymentId = (): string => {
  const rand = crypto.randomBytes(4).toString('hex').toLowerCase();
  const ts = Date.now().toString(36).toLowerCase();
  return `up_dep_${ts}_${rand}`;
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const listDeployments = (): ModelDeployment[] => {
  const file = getFile();
  return [...file.deployments].sort((a, b) => a.created_at.localeCompare(b.created_at));
};

const getDeployment = (deploymentId: unknown): ModelDeployment | null => {
  const id = normalizeDeploymentId(deploymentId);
  if (!id) {
    loggingModule.logDebug('[deployment-store] getDeployment: invalid id', { deploymentId: String(deploymentId) });
    return null;
  }
  const file = getFile();
  const found = file.deployments.find((d) => d.deployment_id === id);
  if (!found) {
    loggingModule.logDebug('[deployment-store] getDeployment: not found', { deploymentId: id });
    return null;
  }
  return found;
};

/**
 * v1 存量接入的档位启用关系（deployment_id → {启用档位, 默认档位}）。
 *
 * 声明迁移专用：custom-chat-model-store 的 v1→v2 迁移先调 `listDeployments()` 确保
 * deployment store 就绪，再读本 map 把档位并入自建对话记录。非迁移方不得消费。
 */
const listLegacyDeploymentThinkingTiers = (): ReadonlyMap<string, { enabled_thinking_tiers: string[]; default_thinking_tier: string | null }> =>
  legacyThinkingTiers;

const validateDeployable = (modelId: string, connectionId: string, remoteModelId: string): string | null => {
  const trimmedRemote = remoteModelId.trim();
  if (!trimmedRemote) return 'remote_model_id is required';
  // 自建模型（对话/生成）是服务商作用域单记录，不产生 Deployment：接入归属在创建记录时
  // 一次写入完成。这里显式拒绝，防止绕过单记录路径造出指向同一 model_id 的僵尸接入。
  if (getCustomChatModel(modelId) !== null || getCustomGenerationModel(modelId) !== null) {
    return `model ${modelId} is a custom model record; its access is embedded in the record, not a ModelDeployment`;
  }
  // 已装包模型必须命中封闭族注册表——执行期按模型解析协议的正则表依据（2026-09-26 起
  // 协议归属模型级，连接不再约束模型族，任何已装包模型可挂任何连接）
  if (resolveClosedFamilyAdapter(modelId) === null) {
    return `model ${modelId} does not belong to any known installed model family`;
  }
  const connection = getConnection(connectionId);
  if (!connection) return `connection not found: ${connectionId}`;
  if (connection.lifecycle !== 'enabled') return `connection lifecycle is ${connection.lifecycle}, must be enabled`;
  if (!connection.has_credential || !connection.credential_ref) return 'connection credential missing';
  return null;
};

const createDeployment = (input: {
  model_id: string;
  connection_id: string;
  remote_model_id: string;
}): ModelDeployment => {
  const modelId = normalizeString(input.model_id);
  const connectionId = normalizeString(input.connection_id);
  const remoteModelId = normalizeString(input.remote_model_id);
  if (!modelId) throw new Error('[deployment-store] model_id is required');
  if (!connectionId) throw new Error('[deployment-store] connection_id is required');
  if (!remoteModelId) throw new Error('[deployment-store] remote_model_id is required');
  const file = getFile();
  const duplicate = file.deployments.some(
    (d) => d.model_id === modelId && d.connection_id === connectionId && d.remote_model_id === remoteModelId,
  );
  if (duplicate) throw new Error('[deployment-store] deployment already exists for model_id + connection_id + remote_model_id');
  const reason = validateDeployable(modelId, connectionId, remoteModelId);
  if (reason) throw new Error(`[deployment-store] not deployable: ${reason}`);
  const now = new Date().toISOString();
  const deployment: ModelDeployment = {
    deployment_id: generateDeploymentId(),
    model_id: modelId,
    connection_id: connectionId,
    remote_model_id: remoteModelId,
    created_at: now,
    updated_at: now,
  };
  const parsed = ModelDeploymentSchema.safeParse(deployment);
  if (!parsed.success) throw new Error(`[deployment-store] invalid deployment: ${parsed.error.message}`);
  commitFile({ ...file, deployments: [...file.deployments, parsed.data] });
  return parsed.data;
};

const updateDeployment = (
  deploymentId: unknown,
  patch: {
    connection_id?: string;
    remote_model_id?: string;
  },
): ModelDeployment | null => {
  const id = normalizeDeploymentId(deploymentId);
  if (!id) {
    loggingModule.logDebug('[deployment-store] updateDeployment: invalid id', { deploymentId: String(deploymentId) });
    return null;
  }
  const file = getFile();
  const index = file.deployments.findIndex((d) => d.deployment_id === id);
  if (index < 0) {
    loggingModule.logDebug('[deployment-store] updateDeployment: not found', { deploymentId: id });
    return null;
  }
  const existingCandidate = file.deployments[index];
  if (!existingCandidate) {
    loggingModule.logDebug('[deployment-store] updateDeployment: unexpectedly missing at index', { deploymentId: id, index });
    return null;
  }
  const existing = existingCandidate;
  let next: ModelDeployment = { ...existing };
  if (patch.connection_id !== undefined) {
    const trimmed = normalizeString(patch.connection_id);
    if (!trimmed) throw new Error('[deployment-store] connection_id must be non-empty');
    next.connection_id = trimmed;
  }
  if (patch.remote_model_id !== undefined) {
    const trimmed = normalizeString(patch.remote_model_id);
    if (!trimmed) throw new Error('[deployment-store] remote_model_id must be non-empty');
    next.remote_model_id = trimmed;
  }
  const reason = validateDeployable(next.model_id, next.connection_id, next.remote_model_id);
  if (reason) throw new Error(`[deployment-store] not deployable after update: ${reason}`);
  const dupe = file.deployments.some(
    (d, i) => i !== index && d.model_id === next.model_id && d.connection_id === next.connection_id && d.remote_model_id === next.remote_model_id,
  );
  if (dupe) throw new Error('[deployment-store] duplicate deployment after update');
  const now = new Date().toISOString();
  next = { ...next, updated_at: now };
  const parsed = ModelDeploymentSchema.safeParse(next);
  if (!parsed.success) throw new Error(`[deployment-store] merged deployment invalid: ${parsed.error.message}`);
  const nextDeployments = file.deployments.map((d, i) => (i === index ? parsed.data : d));
  commitFile({ ...file, deployments: nextDeployments });
  return parsed.data;
};

const removeDeployment = (deploymentId: unknown): boolean => {
  const id = normalizeDeploymentId(deploymentId);
  if (!id) {
    loggingModule.logDebug('[deployment-store] removeDeployment: invalid id', { deploymentId: String(deploymentId) });
    return false;
  }
  const file = getFile();
  const index = file.deployments.findIndex((d) => d.deployment_id === id);
  if (index < 0) {
    loggingModule.logDebug('[deployment-store] removeDeployment: not found', { deploymentId: id });
    return false;
  }
  const nextDeployments = file.deployments.filter((d) => d.deployment_id !== id);
  commitFile({ ...file, deployments: nextDeployments });
  return true;
};

const removeDeploymentsByConnection = (connectionId: unknown): number => {
  const id = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!id) return 0;
  const file = getFile();
  const toRemove = file.deployments.filter((d) => d.connection_id === id);
  if (toRemove.length === 0) return 0;
  const nextDeployments = file.deployments.filter((d) => d.connection_id !== id);
  commitFile({ ...file, deployments: nextDeployments });
  return toRemove.length;
};

const getDeploymentsByConnection = (connectionId: unknown): ModelDeployment[] => {
  const id = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!id) return [];
  return listDeployments().filter((d) => d.connection_id === id);
};

/**
 * 按 deployment_id 集合删除接入记录，返回删除条数。
 *
 * 用于自建声明 v1→v2 迁移的收尾：声明记录已把接入归属并入自身（record_id 继承
 * deployment_id），自建链的 deployment 记录随之移除；内置包 deployment 不受影响。
 */
const removeDeploymentsByIds = (ids: ReadonlyArray<string>): number => {
  const idSet = new Set(ids.map((id) => normalizeDeploymentId(id)).filter((id) => id !== ''));
  if (idSet.size === 0) return 0;
  const file = getFile();
  const remaining = file.deployments.filter((d) => !idSet.has(d.deployment_id));
  const removed = file.deployments.length - remaining.length;
  if (removed === 0) return 0;
  commitFile({ ...file, deployments: remaining });
  return removed;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  listDeployments,
  getDeployment,
  createDeployment,
  updateDeployment,
  removeDeployment,
  removeDeploymentsByConnection,
  getDeploymentsByConnection,
  removeDeploymentsByIds,
  listLegacyDeploymentThinkingTiers,
  clearCacheForTest,
  normalizeDeploymentId,
  generateDeploymentId,
  type ModelDeploymentsFile,
};
