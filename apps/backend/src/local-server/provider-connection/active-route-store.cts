import * as fs from 'node:fs';
import {
  ActiveRouteMapSchema,
  type ActiveRouteMap,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { getDeployment } from './deployment-store.cts';
import { getCustomChatModelByRecordId } from './custom-chat-model-store.cts';
import { getCustomGenerationModelByRecordId } from './custom-generation-model-store.cts';
import { resolveClosedFamilyAdapter } from '../model-family-registry.cts';

/**
 * ActiveRouteMap 持久化（spec 03 §6.2；2026-09-25 起值语义为「active 接入记录 id」）。
 *
 * - 文件：config/active-routes.json
 * - 语义：Record<model_id, 接入记录id> 单值映射，切换只影响未派发任务，无 active 时阻断
 * - 解析目标**双查**（spec 03 §6.1：两类接入记录同用 `up_dep_` 前缀）：已装包模型指向其
 *   ModelDeployment（deployment-store），自建模型（对话/生成）指向其模型记录
 *   （custom-*-model-store 的 record_id）
 * - 校验：写入时确认目标存在且 model_id 一致；读取时目标缺失视为 stale 并清理
 */

const FILE_VERSION = 1;

interface ActiveRoutesFile {
  version: number;
  updatedAt: string;
  activeRoutes: ActiveRouteMap;
}

type ActiveRoutesPathMap = { activeRoutes: string | undefined };

const asPathMap = (value: unknown): ActiveRoutesPathMap | null =>
  isPlainObject(value) ? (value as ActiveRoutesPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.activeRoutes : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): ActiveRoutesFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  activeRoutes: {},
});

/** active 接入记录的归一形状：deployment 与自建模型记录共用同一投影。 */
export type ActiveRouteTarget = {
  /** 接入记录 id（deployment_id 或自建记录 record_id，同一 id 空间）。 */
  target_id: string;
  model_id: string;
  connection_id: string;
  remote_model_id: string;
  /** 来源类别（2026-09-26 起协议按模型解析的判别依据）。 */
  source: 'deployment' | 'custom_chat' | 'custom_generation';
  /**
   * 该模型的接口协议（2026-09-26 起协议归属模型级；2026-09-29 起连接不再承载接口类型预选）：
   * 自建记录取记录自带协议字段；已装包 deployment 按 model_id 封闭族正则表解析，未命中时为
   * undefined（消费端显式失败，不回落）。连接不再承载模型协议。
   */
  protocol_adapter_id?: string;
};

/**
 * 按接入记录 id 解析目标（双查）：deployment → 自建对话记录 → 自建生成记录。
 *
 * 返回 null 表示两类接入记录里都没有这个 id（stale 引用）。自建记录 store 首次触达会完成
 * v1→v2 迁移，因此先到的 active route 读取也会等迁移完成后再判定 stale。
 */
const resolveActiveRouteTargetById = (targetId: unknown): ActiveRouteTarget | null => {
  const id = typeof targetId === 'string' ? targetId.trim() : '';
  if (!id) return null;
  const deployment = getDeployment(id);
  if (deployment) {
    const deploymentProtocol = resolveClosedFamilyAdapter(deployment.model_id);
    return {
      target_id: deployment.deployment_id,
      model_id: deployment.model_id,
      connection_id: deployment.connection_id,
      remote_model_id: deployment.remote_model_id,
      source: 'deployment',
      // 已装包模型的协议按 model_id 封闭族正则表解析；未命中（异常数据）留空，消费端
      // （快照构建器 / 可执行目录）显式失败，不回落任何兜底值。
      ...(deploymentProtocol === null ? {} : { protocol_adapter_id: deploymentProtocol }),
    };
  }
  const chatRecord = getCustomChatModelByRecordId(id);
  if (chatRecord) {
    return {
      target_id: chatRecord.record_id,
      model_id: chatRecord.model_id,
      connection_id: chatRecord.connection_id,
      remote_model_id: chatRecord.remote_model_id,
      source: 'custom_chat',
      protocol_adapter_id: chatRecord.protocol_adapter_id,
    };
  }
  const generationRecord = getCustomGenerationModelByRecordId(id);
  if (generationRecord) {
    return {
      target_id: generationRecord.record_id,
      model_id: generationRecord.model_id,
      connection_id: generationRecord.connection_id,
      remote_model_id: generationRecord.remote_model_id,
      source: 'custom_generation',
      protocol_adapter_id: generationRecord.family_adapter_id,
    };
  }
  return null;
};

const normalizeFile = (raw: unknown): ActiveRoutesFile | null => {
  if (!isPlainObject(raw)) return null;
  const version = Number((raw as { version: unknown }).version);
  if (!Number.isFinite(version) || version !== FILE_VERSION) {
    loggingModule.logDebug('[active-route-store] normalizeFile: unsupported version', { version });
    return null;
  }
  const rawMap = (raw as { activeRoutes: unknown }).activeRoutes;
  if (rawMap === undefined || rawMap === null) {
    return { version: FILE_VERSION, updatedAt: typeof (raw as { updatedAt: unknown }).updatedAt === 'string' ? String((raw as { updatedAt: unknown }).updatedAt) : new Date(0).toISOString(), activeRoutes: {} };
  }
  const parsed = ActiveRouteMapSchema.safeParse(rawMap);
  if (!parsed.success) {
    loggingModule.logDebug('[active-route-store] invalid activeRoutes map, drop all', { error: parsed.error.message });
    return { version: FILE_VERSION, updatedAt: new Date(0).toISOString(), activeRoutes: {} };
  }
  // 过滤掉指向已不存在接入记录（deployment 与自建记录双查都不命中）的映射
  const filtered: ActiveRouteMap = {};
  Object.entries(parsed.data).forEach(([modelId, deploymentId]) => {
    const target = resolveActiveRouteTargetById(deploymentId);
    if (!target) {
      loggingModule.logDebug('[active-route-store] drop stale active route pointing to missing access record', { modelId, deploymentId });
      return;
    }
    filtered[modelId] = deploymentId;
  });
  return {
    version: FILE_VERSION,
    updatedAt: typeof (raw as { updatedAt: unknown }).updatedAt === 'string' ? String((raw as { updatedAt: unknown }).updatedAt) : new Date(0).toISOString(),
    activeRoutes: filtered,
  };
};

const readFromDisk = (paths: unknown): ActiveRoutesFile | null => {
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

const writeToDisk = (paths: unknown, file: ActiveRoutesFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: ActiveRoutesFile | null = null;

const getFile = (): ActiveRoutesFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

const commitFile = (next: ActiveRoutesFile): ActiveRoutesFile => {
  const updated: ActiveRoutesFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  cache = updated;
  writeToDisk(paths, updated);
  return updated;
};

const normalizeModelId = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const getActiveRoutes = (): ActiveRouteMap => {
  const file = getFile();
  return { ...file.activeRoutes };
};

/**
 * 模型的 active 接入记录 id；无 active 或目标已消失时返回 null。
 *
 * 返回值语义为「active 接入记录 id」：已装包模型为 deployment_id，自建模型为其记录的
 * record_id（两类 id 同用 `up_dep_` 前缀，跨边界 DTO 字段名维持 deployment_id）。
 */
const getActiveDeploymentId = (modelId: unknown): string | null => {
  const id = normalizeModelId(modelId);
  if (!id) {
    loggingModule.logDebug('[active-route-store] getActiveDeploymentId: empty modelId', { modelId: String(modelId) });
    return null;
  }
  const file = getFile();
  const deploymentId = file.activeRoutes[id];
  if (!deploymentId) return null;
  // 校验目标是否仍存在（deployment 与自建记录双查）
  const target = resolveActiveRouteTargetById(deploymentId);
  if (!target) {
    loggingModule.logDebug('[active-route-store] getActiveDeploymentId: stale mapping, access record missing', { modelId: id, deploymentId });
    return null;
  }
  return deploymentId;
};

/**
 * 解析模型当前的 active 接入记录（deployment 或自建模型记录的归一投影）。
 *
 * 执行快照与目录投影的统一入口：消费方不关心目标是 deployment 还是自建记录，只按本投影
 * 取 connection_id / remote_model_id。无 active 或目标已消失时返回 null。
 */
const resolveActiveTarget = (modelId: unknown): ActiveRouteTarget | null => {
  const deploymentId = getActiveDeploymentId(modelId);
  if (!deploymentId) return null;
  return resolveActiveRouteTargetById(deploymentId);
};

/** 按接入记录 id 解析目标（双查）；供 active route 写入路由做存在性校验。 */
const resolveActiveTargetRecord = (targetId: unknown): ActiveRouteTarget | null =>
  resolveActiveRouteTargetById(targetId);

const setActiveDeployment = (modelId: unknown, deploymentId: unknown): string | null => {
  const mid = normalizeModelId(modelId);
  if (!mid) {
    loggingModule.logDebug('[active-route-store] setActiveDeployment: empty modelId', { modelId: String(modelId) });
    return null;
  }
  const did = typeof deploymentId === 'string' ? deploymentId.trim() : '';
  if (!did) {
    loggingModule.logDebug('[active-route-store] setActiveDeployment: empty deploymentId', { deploymentId: String(deploymentId) });
    return null;
  }
  if (!/^up_dep_[a-z0-9][a-z0-9-_]*$/.test(did)) {
    loggingModule.logDebug('[active-route-store] setActiveDeployment: invalid deploymentId format', { deploymentId: did });
    return null;
  }
  const target = resolveActiveRouteTargetById(did);
  if (!target) {
    loggingModule.logDebug('[active-route-store] setActiveDeployment: access record not found', { deploymentId: did });
    throw new Error(`[active-route-store] access record not found: ${did}`);
  }
  if (target.model_id !== mid) {
    loggingModule.logDebug('[active-route-store] setActiveDeployment: access record model mismatch', { modelId: mid, recordModelId: target.model_id });
    throw new Error(`[active-route-store] access record model_id ${target.model_id} does not match active model_id ${mid}`);
  }
  const file = getFile();
  const nextRoutes: ActiveRouteMap = { ...file.activeRoutes, [mid]: did };
  commitFile({ ...file, activeRoutes: nextRoutes });
  return did;
};

const clearActiveDeployment = (modelId: unknown): boolean => {
  const mid = normalizeModelId(modelId);
  if (!mid) {
    loggingModule.logDebug('[active-route-store] clearActiveDeployment: empty modelId', { modelId: String(modelId) });
    return false;
  }
  const file = getFile();
  if (!(mid in file.activeRoutes)) {
    loggingModule.logDebug('[active-route-store] clearActiveDeployment: no mapping', { modelId: mid });
    return false;
  }
  const nextRoutes = { ...file.activeRoutes };
  delete nextRoutes[mid];
  commitFile({ ...file, activeRoutes: nextRoutes });
  return true;
};

const clearActiveRoutesForDeployment = (deploymentId: unknown): number => {
  const did = typeof deploymentId === 'string' ? deploymentId.trim() : '';
  if (!did) return 0;
  const file = getFile();
  const entries = Object.entries(file.activeRoutes).filter(([, v]) => v === did);
  if (entries.length === 0) return 0;
  const nextRoutes = { ...file.activeRoutes };
  for (const [modelId] of entries) delete nextRoutes[modelId];
  commitFile({ ...file, activeRoutes: nextRoutes });
  return entries.length;
};

/**
 * 清掉指向某条连接的全部 active 路由（deployment 与自建记录双查归属连接）。
 *
 * retired / 删除连接时解除未来 active（已冻结快照不受影响，spec 03 §5.3）。目标已消失的
 * stale 映射一并清理。
 */
const clearActiveRoutesForConnection = (connectionId: unknown): number => {
  const cid = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!cid) return 0;
  const file = getFile();
  let removed = 0;
  const nextRoutes = { ...file.activeRoutes };
  for (const [modelId, deploymentId] of Object.entries(file.activeRoutes)) {
    const target = resolveActiveRouteTargetById(deploymentId);
    if (!target) {
      delete nextRoutes[modelId];
      removed += 1;
      continue;
    }
    if (target.connection_id === cid) {
      delete nextRoutes[modelId];
      removed += 1;
    }
  }
  if (removed > 0) commitFile({ ...file, activeRoutes: nextRoutes });
  return removed;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  getActiveRoutes,
  getActiveDeploymentId,
  resolveActiveTarget,
  resolveActiveTargetRecord,
  setActiveDeployment,
  clearActiveDeployment,
  clearActiveRoutesForDeployment,
  clearActiveRoutesForConnection,
  clearCacheForTest,
  type ActiveRoutesFile,
};
