import * as fs from 'node:fs';
import {
  ActiveRouteMapSchema,
  type ActiveRouteMap,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { getCustomChatModelByRecordId } from './custom-chat-model-store.cts';
import { getCustomGenerationModelByRecordId } from './custom-generation-model-store.cts';

/**
 * ActiveRouteMap 持久化（spec 03 §6.2；2026-09-25 起值语义为「active 接入记录 id」）。
 *
 * - 文件：config/active-routes.json
 * - 语义：Record<model_id, 接入记录id> 单值映射，切换只影响未派发任务，无 active 时阻断
 * - 解析目标**只有模型记录一种载体**（spec 03 §6.1 单一载体 / §12 PC-14，2026-10-19）：
 *   对话记录与生成记录各在自家 store 里按 `record_id` 查（两族同用 `up_dep_` 前缀，
 *   因此两查都做）。部署载体退场后不存在第三查。
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

/** active 接入记录的归一形状（两族模型记录共用同一投影）。 */
export type ActiveRouteTarget = {
  /** 接入记录 id，即模型记录的 `record_id`（同一 id 空间）。 */
  target_id: string;
  model_id: string;
  connection_id: string;
  remote_model_id: string;
  /**
   * 记录所属族（spec 03 §8「来源判别只有模型记录一种」的**族**判别，不是载体判别）。
   * 2026-10-19 部署载体退场后不再有 `deployment` 取值。
   */
  source: 'custom_chat' | 'custom_generation';
  /**
   * 该模型的接口协议（2026-09-26 起协议归属模型级；2026-09-29 起连接不再承载接口类型预选）：
   * 对话记录取 `protocol_adapter_id`、生成记录取 `family_adapter_id`，恒有值——两族记录的
   * schema 都要求协议字段必填。连接不再承载模型协议，也不按 model_id 名称推断。
   */
  protocol_adapter_id: string;
};

/**
 * 按接入记录 id 解析目标（两查）：对话记录 → 生成记录。
 *
 * 返回 null 表示两族记录里都没有这个 id（stale 引用）。记录 store 首次触达会完成自身的存量
 * 迁移，因此先到的 active route 读取也会等迁移完成后再判定 stale。
 */
const resolveActiveRouteTargetById = (targetId: unknown): ActiveRouteTarget | null => {
  const id = typeof targetId === 'string' ? targetId.trim() : '';
  if (!id) return null;
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
  // 过滤掉指向已不存在接入记录（两族记录都查不到）的映射
  const filtered: ActiveRouteMap = {};
  Object.entries(parsed.data).forEach(([modelId, recordId]) => {
    const target = resolveActiveRouteTargetById(recordId);
    if (!target) {
      loggingModule.logDebug('[active-route-store] drop stale active route pointing to missing access record', { modelId, recordId });
      return;
    }
    filtered[modelId] = recordId;
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
 * 返回值语义为「active 接入记录 id」，即该模型记录的 `record_id`（跨边界 DTO 字段名沿用
 * `deployment_id`，见 contracts 的 ExecutionSnapshot 注释）。
 */
const getActiveDeploymentId = (modelId: unknown): string | null => {
  const id = normalizeModelId(modelId);
  if (!id) {
    loggingModule.logDebug('[active-route-store] getActiveDeploymentId: empty modelId', { modelId: String(modelId) });
    return null;
  }
  const file = getFile();
  const recordId = file.activeRoutes[id];
  if (!recordId) return null;
  // 校验目标是否仍存在（两族记录两查）
  const target = resolveActiveRouteTargetById(recordId);
  if (!target) {
    loggingModule.logDebug('[active-route-store] getActiveDeploymentId: stale mapping, access record missing', { modelId: id, recordId });
    return null;
  }
  return recordId;
};

/**
 * 解析模型当前的 active 接入记录（模型记录的归一投影）。
 *
 * 执行快照与目录投影的统一入口：消费方只按本投影取 connection_id / remote_model_id /
 * protocol_adapter_id，不关心它来自哪一族的记录。无 active 或目标已消失时返回 null。
 */
const resolveActiveTarget = (modelId: unknown): ActiveRouteTarget | null => {
  const recordId = getActiveDeploymentId(modelId);
  if (!recordId) return null;
  return resolveActiveRouteTargetById(recordId);
};

/** 按接入记录 id 解析目标（两查）；供 active route 写入路由做存在性校验。 */
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

/**
 * 清掉指向某条连接的全部 active 路由（按模型记录归属连接判定）。
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
  for (const [modelId, recordId] of Object.entries(file.activeRoutes)) {
    const target = resolveActiveRouteTargetById(recordId);
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
  clearActiveRoutesForConnection,
  clearCacheForTest,
  type ActiveRoutesFile,
};
