import * as fs from 'node:fs';
import {
  ChatProtocolAdapterIdSchema,
  CustomChatModelSchema,
  DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS,
  THINKING_TIER_OFF,
  ThinkingTierSchema,
  type CustomChatModel,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { getConnection } from './connection-store.cts';
import { getCustomGenerationModel } from './custom-generation-model-store.cts';
import { generateRecordId } from './record-id.cts';
import {
  listLegacyDeploymentThinkingTiers,
  listLegacyDeployments,
  removeLegacyDeploymentsByIds,
  type LegacyDeployment,
} from './legacy-deployment-file.cts';

/**
 * 自建对话模型记录（spec 03 §6.1「Deployment 与自建模型记录」、spec 37 v4.0.0）。
 *
 * - 文件：config/custom-chat-models.json（version 3）
 * - 2026-09-25 起「声明 + 接入」两层合并为**服务商作用域单记录**（接入载体已于 2026-10-19 退场）：一条记录
 *   同时承载能力属性（上下文窗口、最大输出 token、思考档位启用）与接入归属
 *   （connection_id + remote_model_id），用户一次写入完成添加；`record_id` 由 backend 生成
 *   （复用 deployment id 生成逻辑，同一 id 空间），active route 与执行快照引用它
 * - 2026-09-26 起协议归属模型级：记录自带 `protocol_adapter_id`（对话族），连接不再约束协议
 * - 思考档位随本记录走（旧接入载体上的档位字段已随声明层合并退役）
 * - v1 存量迁移：每条 v1 声明从旧接入文件反查该 model_id 的接入合成记录（record_id 继承旧接入
 *   id，active-routes 零改动）；无接入的孤儿声明丢弃并留痕；迁移完成后被并掉的旧接入从旧文件
 *   移除（信息已并入记录）
 * - v2 存量迁移：每条 v2 记录从其归属连接回填 `protocol_adapter_id`（协议事实源此前在连接
 *   上）；连接缺失或协议非对话族的记录按孤儿丢弃并留痕
 * - 删除记录时的 active route 清理由调用方编排，本模块不感知路由
 */

const FILE_VERSION = 3;

type CustomChatModelsPathMap = { customChatModels: string | undefined };

interface CustomChatModelsFile {
  version: number;
  updatedAt: string;
  models: CustomChatModel[];
}

const asPathMap = (value: unknown): CustomChatModelsPathMap | null =>
  isPlainObject(value) ? (value as CustomChatModelsPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.customChatModels : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): CustomChatModelsFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  models: [],
});

const normalizeModelId = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 逐个档位校验并剔除非法值：坏档位只摘自己，不连累整条记录被 schema 判废。 */
const sanitizeTierList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const parsed = ThinkingTierSchema.safeParse(typeof item === 'string' ? item.trim() : '');
    if (!parsed.success) {
      loggingModule.logDebug('[custom-chat-model-store] drop invalid thinking tier', { value: String(item) });
      continue;
    }
    if (parsed.data === THINKING_TIER_OFF) {
      loggingModule.logDebug('[custom-chat-model-store] drop implicit off tier', {});
      continue;
    }
    if (names.includes(parsed.data)) continue;
    names.push(parsed.data);
  }
  return names;
};

/** 默认档位必须是启用列表的成员，否则清空（跨字段不变量由写入侧收口，schema 不阻断整条）。 */
const sanitizeDefaultTier = (value: unknown, enabledTiers: string[]): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = ThinkingTierSchema.safeParse(typeof value === 'string' ? value.trim() : '');
  if (!parsed.success || parsed.data === THINKING_TIER_OFF) {
    loggingModule.logDebug('[custom-chat-model-store] drop invalid default thinking tier', { value: String(value) });
    return null;
  }
  if (!enabledTiers.includes(parsed.data)) {
    loggingModule.logDebug('[custom-chat-model-store] default thinking tier is not enabled, cleared', { defaultThinkingTier: parsed.data });
    return null;
  }
  return parsed.data;
};

// ---------------------------------------------------------------------------
// v1 存量迁移（先 deployment store 就绪，再按 model_id 反查合成 v2 记录）
// ---------------------------------------------------------------------------

/** v1 声明形状（宽松读取：缺字段按当时的缺省语义补齐，不因形状差异丢数据）。 */
const parseLegacyDeclaration = (entry: unknown): {
  model_id: string;
  context_window_tokens: number;
  max_output_tokens: number | null;
  created_at: string;
} | null => {
  if (!isPlainObject(entry)) return null;
  const modelId = normalizeModelId((entry as { model_id: unknown }).model_id);
  if (!modelId) return null;
  const window = Number((entry as { context_window_tokens: unknown }).context_window_tokens);
  const maxOutput = (entry as { max_output_tokens: unknown }).max_output_tokens;
  return {
    model_id: modelId,
    context_window_tokens: Number.isFinite(window) ? window : DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS,
    max_output_tokens: maxOutput === null || maxOutput === undefined ? null : Number(maxOutput),
    created_at: typeof (entry as { created_at: unknown }).created_at === 'string'
      ? String((entry as { created_at: unknown }).created_at)
      : new Date(0).toISOString(),
  };
};

/**
 * v1 → v2 迁移：把声明与它名下的旧接入合成单记录。
 *
 * 反查依赖旧接入数据，档位值来自旧文件读取时的 v1 剥键存档（`listLegacyDeploymentThinkingTiers`）。
 * 返回合成记录与被并入的接入 id。
 */
const migrateLegacyModels = (rawModels: unknown[]): { records: CustomChatModel[]; mergedDeploymentIds: string[] } => {
  const legacyTiers = listLegacyDeploymentThinkingTiers();
  const deployments = listLegacyDeployments();
  const records: CustomChatModel[] = [];
  const mergedDeploymentIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const legacy = parseLegacyDeclaration(entry);
    if (legacy === null) {
      loggingModule.logDebug('[custom-chat-model-store] migrate: drop unparsable v1 declaration', { entry: String(entry).slice(0, 200) });
      continue;
    }
    if (seen.has(legacy.model_id)) {
      loggingModule.logDebug('[custom-chat-model-store] migrate: drop duplicated v1 declaration', { modelId: legacy.model_id });
      continue;
    }
    seen.add(legacy.model_id);
    // 反查该 model_id 的接入：旧接入按 created_at 升序，取最早一条（多接入属历史异常态；
    // active 指向的那条与新记录 id 一致时零漂移，否则用户重新设一次 active 即可）。
    const deployment: LegacyDeployment | undefined = deployments.find((item) => item.model_id === legacy.model_id);
    if (!deployment) {
      loggingModule.logDebug('[custom-chat-model-store] migrate: orphan declaration without deployment, dropped', {
        modelId: legacy.model_id,
      });
      continue;
    }
    // 协议回填：v1 时代协议事实源在连接上（写入侧曾强制对话协议连接），从归属连接取
    const legacyConnection = getConnection(deployment.connection_id);
    const legacyProtocol = ChatProtocolAdapterIdSchema.safeParse(legacyConnection?.protocol_adapter_id);
    if (!legacyProtocol.success) {
      loggingModule.logDebug('[custom-chat-model-store] migrate: deployment connection missing or not chat protocol, dropped', {
        modelId: legacy.model_id,
        connectionId: deployment.connection_id,
      });
      continue;
    }
    const tiers = sanitizeTierList(legacyTiers.get(deployment.deployment_id)?.enabled_thinking_tiers ?? []);
    const candidate = {
      model_id: legacy.model_id,
      record_id: deployment.deployment_id,
      connection_id: deployment.connection_id,
      protocol_adapter_id: legacyProtocol.data,
      remote_model_id: deployment.remote_model_id,
      context_window_tokens: legacy.context_window_tokens,
      max_output_tokens: legacy.max_output_tokens,
      enabled_thinking_tiers: tiers,
      default_thinking_tier: sanitizeDefaultTier(legacyTiers.get(deployment.deployment_id)?.default_thinking_tier ?? null, tiers),
      created_at: legacy.created_at,
    };
    const parsed = CustomChatModelSchema.safeParse(candidate);
    if (!parsed.success) {
      loggingModule.logDebug('[custom-chat-model-store] migrate: merged record failed schema, dropped', {
        modelId: legacy.model_id,
        error: parsed.error.message,
      });
      continue;
    }
    records.push(parsed.data);
    mergedDeploymentIds.push(deployment.deployment_id);
  }
  return { records, mergedDeploymentIds };
};

// ---------------------------------------------------------------------------
// v2 存量迁移（协议回填：从归属连接把 protocol_adapter_id 复制到每条记录）
// ---------------------------------------------------------------------------

/**
 * v2 → v3 迁移：2026-09-26 起协议归属模型级，存量 v2 记录的协议事实源在连接上，逐条回填。
 *
 * 连接缺失或其协议不是对话族的记录按孤儿丢弃并留痕——正常数据不会出现这种形态（删连接
 * 级联删记录、写入侧曾强制对话协议连接），出现即说明文件被外部改坏。
 */
const migrateV2Models = (rawModels: unknown[]): CustomChatModel[] => {
  const records: CustomChatModel[] = [];
  const seen = new Set<string>();
  rawModels.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      loggingModule.logDebug('[custom-chat-model-store] migrate v2: drop unparsable record', { index });
      return;
    }
    const modelId = normalizeModelId((entry as { model_id: unknown }).model_id);
    if (!modelId) {
      loggingModule.logDebug('[custom-chat-model-store] migrate v2: drop record without model_id', { index });
      return;
    }
    if (seen.has(modelId)) {
      loggingModule.logDebug('[custom-chat-model-store] migrate v2: drop duplicated record', { modelId });
      return;
    }
    seen.add(modelId);
    const rawConnectionId = (entry as { connection_id: unknown }).connection_id;
    const connection = typeof rawConnectionId === 'string' ? getConnection(rawConnectionId) : null;
    const protocolParse = ChatProtocolAdapterIdSchema.safeParse(connection?.protocol_adapter_id);
    if (!protocolParse.success) {
      loggingModule.logDebug('[custom-chat-model-store] migrate v2: record connection missing or not chat protocol, dropped', {
        modelId,
        connectionId: typeof rawConnectionId === 'string' ? rawConnectionId : '',
      });
      return;
    }
    const result = CustomChatModelSchema.safeParse({ ...entry, protocol_adapter_id: protocolParse.data });
    if (!result.success) {
      loggingModule.logDebug('[custom-chat-model-store] migrate v2: record failed schema, dropped', {
        modelId,
        error: result.error.message,
      });
      return;
    }
    records.push(result.data);
  });
  return records;
};

const readFromDisk = (paths: unknown): CustomChatModelsFile | null => {
  const filePath = getFilePath(paths);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isPlainObject(parsed)) return null;
    const version = Number((parsed as { version: unknown }).version);
    const rawUpdatedAt = (parsed as { updatedAt: unknown }).updatedAt;
    const updatedAt = typeof rawUpdatedAt === 'string' ? rawUpdatedAt : new Date(0).toISOString();
    if (version === FILE_VERSION) {
      const models: CustomChatModel[] = [];
      const seen = new Set<string>();
      const rawModels = (parsed as { models: unknown }).models;
      if (Array.isArray(rawModels)) {
        rawModels.forEach((entry, index) => {
          const result = CustomChatModelSchema.safeParse(entry);
          if (!result.success) {
            loggingModule.logDebug('[custom-chat-model-store] drop invalid model record', {
              index,
              error: result.error.message,
            });
            return;
          }
          if (seen.has(result.data.model_id)) {
            loggingModule.logDebug('[custom-chat-model-store] drop duplicated model record', {
              modelId: result.data.model_id,
            });
            return;
          }
          seen.add(result.data.model_id);
          models.push(result.data);
        });
      }
      return { version: FILE_VERSION, updatedAt, models };
    }
    if (version === 2) {
      // v2 存量文件：协议归属模型级改造（2026-09-26）前的形状——逐条从归属连接回填协议后
      // 升 v3 落盘，之后每次读取都走 v3 正常路径。
      const rawModels = (parsed as { models: unknown }).models;
      const records = migrateV2Models(Array.isArray(rawModels) ? rawModels : []);
      const migrated: CustomChatModelsFile = { version: FILE_VERSION, updatedAt, models: records };
      writeToDisk(paths, migrated);
      loggingModule.logDebug('[custom-chat-model-store] migrate: chat models file upgraded to v3', {
        migrated: records.length,
        droppedOrphans: (Array.isArray(rawModels) ? rawModels.length : 0) - records.length,
      });
      return migrated;
    }
    if (version === 1) {
      // v1 存量文件：按 model_id 反查旧接入合成 v2/v3 记录，落盘升级——之后每次读取都走
      // 当前形状的正常路径。
      const rawModels = (parsed as { models: unknown }).models;
      const { records, mergedDeploymentIds } = migrateLegacyModels(Array.isArray(rawModels) ? rawModels : []);
      const migrated: CustomChatModelsFile = { version: FILE_VERSION, updatedAt, models: records };
      writeToDisk(paths, migrated);
      if (mergedDeploymentIds.length > 0) {
        const removed = removeLegacyDeploymentsByIds(mergedDeploymentIds);
        loggingModule.logDebug('[custom-chat-model-store] migrate: custom-chain deployments removed', {
          removed,
          mergedDeploymentIds,
        });
      }
      loggingModule.logDebug('[custom-chat-model-store] migrate: declarations file upgraded past v1', {
        migrated: records.length,
        droppedOrphans: (Array.isArray(rawModels) ? rawModels.length : 0) - records.length,
      });
      return migrated;
    }
    loggingModule.logDebug('[custom-chat-model-store] normalizeFile: unsupported version', { version });
    return null;
  } catch {
    return null;
  }
};

const writeToDisk = (paths: unknown, file: CustomChatModelsFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: CustomChatModelsFile | null = null;

const getFile = (): CustomChatModelsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

type CustomChatModelsChangeListener = () => void;

const changeListeners = new Set<CustomChatModelsChangeListener>();

/**
 * 记录变更监听：任一写入落盘成功后触发。本 store 不感知消费方：由装配方注册回调使自己
 * 的派生快照失效（与生成侧 onCustomGenerationModelsChanged 同一模式）。返回退订函数；
 * 监听器抛错只留痕，不阻断写入路径。
 */
const onCustomChatModelsChanged = (listener: CustomChatModelsChangeListener): (() => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

const notifyCustomChatModelsChanged = (): void => {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      loggingModule.logDebug('[custom-chat-model-store] change listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const commitFile = (next: CustomChatModelsFile): CustomChatModelsFile => {
  const updated: CustomChatModelsFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  // 先落盘后置缓存：缓存与磁盘一致，且变更通知只代表「落盘成功」。
  writeToDisk(paths, updated);
  cache = updated;
  notifyCustomChatModelsChanged();
  return updated;
};

/** 已添加的自建对话模型（按添加顺序）。 */
const listCustomChatModels = (): CustomChatModel[] => [...getFile().models];

const getCustomChatModel = (modelId: unknown): CustomChatModel | null => {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  return getFile().models.find((item) => item.model_id === id) ?? null;
};

/** 按接入记录 id（record_id，同 deployment id 空间）取记录；active route 解析用。 */
const getCustomChatModelByRecordId = (recordId: unknown): CustomChatModel | null => {
  const id = normalizeModelId(recordId);
  if (!id) return null;
  return getFile().models.find((item) => item.record_id === id) ?? null;
};

/**
 * 添加自建模型的结果。
 *
 * `duplicate_generation_record`：该标识已被一个生成侧记录占用——两个域共用全局唯一的
 * `model_id`（与生成侧对对话记录的查重互为镜像，见 custom-generation-model-store）。
 * `already_exists`：本域已有同 `model_id` 的记录。
 *
 * 2026-10-19 起不再有「与已装模型包重名」（`duplicate_installed_model`）与「落在生成族命名
 * 空间」（`conflicts_with_generation_family`）两种失败：软件不内置任何具体模型，模型来源只有
 * 用户记录，没有第二个来源可撞名（spec 03 §6.1 单一载体 / §12 PC-14、PC-15）。
 */
export type AddCustomChatModelResult =
  | { ok: true; model: CustomChatModel }
  | {
      ok: false;
      reason: 'duplicate_generation_record' | 'already_exists';
    };

/**
 * 添加自建对话模型（能力属性 + 接入归属 + 协议一次写入）。
 *
 * `record_id` 由本 store 生成（`up_dep_` 前缀，与生成侧同一 id 空间，见 record-id.cts）；归属校验（连接存在、enabled、有凭证）、协议合法性校验与档位协议可表达性校验由
 * 调用方（路由）在写入侧执行，本 store 只管查重、档位归一化与形状。
 *
 * 档位两字段随创建一次落库（spec 37「思考档位」）：省略 = 只有「不思考」可用；默认档位
 * 不落在启用列表内时按写入侧归一化清空（与 PUT 同规则），不拒绝整条。
 */
const addCustomChatModel = (input: {
  model_id: string;
  connection_id: string;
  /** 该模型的接口协议（对话族适配器 id，协议归属模型级）；由调用方校验后必传。 */
  protocol_adapter_id: string;
  /** 省略回落 model_id（对话表单不暴露该字段；直接调用方可显式指定）。 */
  remote_model_id?: string;
  context_window_tokens?: number;
  /** 省略或传 null 都表示不声明输出上限（执行链不发送该参数，由服务商决定）。 */
  max_output_tokens?: number | null;
  /** 省略 = 只有「不思考」可用（与契约缺省同口径）。 */
  enabled_thinking_tiers?: string[];
  /** 省略 = 无默认；不落在启用列表内时归一化清空。 */
  default_thinking_tier?: string | null;
}): AddCustomChatModelResult => {
  const modelId = normalizeModelId(input.model_id);
  if (!modelId) {
    loggingModule.logDebug('[custom-chat-model-store] add: empty model_id', {});
    return { ok: false, reason: 'already_exists' };
  }
  if (getCustomChatModel(modelId) !== null) {
    loggingModule.logDebug('[custom-chat-model-store] add: already exists', { modelId });
    return { ok: false, reason: 'already_exists' };
  }
  // 与生成侧记录互斥（model_id 全局唯一，两个域不能各占一份；镜像生成侧对对话记录的查重）
  if (getCustomGenerationModel(modelId) !== null) {
    loggingModule.logDebug('[custom-chat-model-store] add: collision with generation record', { modelId });
    return { ok: false, reason: 'duplicate_generation_record' };
  }
  const remoteModelId = normalizeModelId(input.remote_model_id) || modelId;
  const enabledTiers = sanitizeTierList(input.enabled_thinking_tiers ?? []);
  const candidate = {
    model_id: modelId,
    record_id: generateRecordId(),
    connection_id: input.connection_id,
    protocol_adapter_id: input.protocol_adapter_id,
    remote_model_id: remoteModelId,
    context_window_tokens: input.context_window_tokens ?? DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS,
    max_output_tokens: input.max_output_tokens ?? null,
    enabled_thinking_tiers: enabledTiers,
    default_thinking_tier: sanitizeDefaultTier(input.default_thinking_tier ?? null, enabledTiers),
    created_at: new Date().toISOString(),
  };
  const parsed = CustomChatModelSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[custom-chat-model-store] add: invalid record', {
      modelId,
      error: parsed.error.message,
    });
    return { ok: false, reason: 'already_exists' };
  }
  const file = getFile();
  commitFile({ ...file, models: [...file.models, parsed.data] });
  return { ok: true, model: parsed.data };
};

/**
 * 改自建对话模型记录的用户可改属性；返回 null 表示没有这个记录或值非法。
 *
 * 四字段整体替换（与 `CustomChatModelUpdateBodySchema` 同口径）：能力两字段必填
 * （`max_output_tokens` 传 null = 清空为不声明），档位两字段必填（空数组 = 只剩「不思考」、
 * `default_thinking_tier` 传 null = 无默认）。默认档位不落在启用列表内时按写入侧归一化
 * 清空，不拒绝整条。
 *
 * 不给改 model_id 与接入归属（connection_id / remote_model_id）：改名或换连接等于换一个
 * 模型，已建的会话与档位启用关系会指向一个不存在的对象，走删除后重建。
 */
const updateCustomChatModel = (
  modelId: unknown,
  input: {
    context_window_tokens: number;
    max_output_tokens: number | null;
    enabled_thinking_tiers: string[];
    default_thinking_tier: string | null;
  },
): CustomChatModel | null => {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  const file = getFile();
  const index = file.models.findIndex((item) => item.model_id === id);
  if (index < 0) {
    loggingModule.logDebug('[custom-chat-model-store] update: not found', { modelId: id });
    return null;
  }
  const existing = file.models[index];
  if (!existing) return null;
  const enabledTiers = sanitizeTierList(input.enabled_thinking_tiers);
  const candidate = {
    ...existing,
    context_window_tokens: input.context_window_tokens,
    max_output_tokens: input.max_output_tokens,
    enabled_thinking_tiers: enabledTiers,
    default_thinking_tier: sanitizeDefaultTier(input.default_thinking_tier, enabledTiers),
  };
  const parsed = CustomChatModelSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[custom-chat-model-store] update: invalid record value', {
      modelId: id,
      error: parsed.error.message,
    });
    return null;
  }
  const next = file.models.map((item, i) => (i === index ? parsed.data : item));
  commitFile({ ...file, models: next });
  return parsed.data;
};

/** 删除自建对话模型记录；返回 false 表示没有这个记录。active route 清理由调用方编排。 */
const removeCustomChatModel = (modelId: unknown): boolean => {
  const id = normalizeModelId(modelId);
  if (!id) return false;
  const file = getFile();
  if (!file.models.some((item) => item.model_id === id)) {
    loggingModule.logDebug('[custom-chat-model-store] remove: not found', { modelId: id });
    return false;
  }
  commitFile({ ...file, models: file.models.filter((item) => item.model_id !== id) });
  return true;
};

/**
 * 删除某条连接下的全部自建对话记录，返回被删记录。
 *
 * 用于删除服务商连接的级联清理（spec 03 §6.1：不存在无归属的自建模型）。调用方需按返回的
 * model_id 逐个清 active route。
 */
const removeCustomChatModelsByConnection = (connectionId: unknown): CustomChatModel[] => {
  const id = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!id) return [];
  const file = getFile();
  const removed = file.models.filter((item) => item.connection_id === id);
  if (removed.length === 0) return [];
  commitFile({ ...file, models: file.models.filter((item) => item.connection_id !== id) });
  return removed;
};

/**
 * 从全部对话记录的启用列表里摘掉某个档位，返回受影响的**模型**数。
 *
 * 用于删除自定义档位时的级联清理（spec 37）；默认档位指向被删档位时一并清空。
 * 档位启用关系随自建对话记录走（旧接入载体上的档位字段已退役）。
 */
const stripThinkingTierFromChatModels = (tier: unknown): number => {
  const parsed = ThinkingTierSchema.safeParse(typeof tier === 'string' ? tier.trim() : '');
  if (!parsed.success || parsed.data === THINKING_TIER_OFF) return 0;
  const name = parsed.data;
  const file = getFile();
  const affected = file.models.filter((item) => item.enabled_thinking_tiers.includes(name));
  if (affected.length === 0) return 0;
  const next = file.models.map((item) =>
    item.enabled_thinking_tiers.includes(name)
      ? {
          ...item,
          enabled_thinking_tiers: item.enabled_thinking_tiers.filter((entry) => entry !== name),
          default_thinking_tier: item.default_thinking_tier === name ? null : item.default_thinking_tier,
        }
      : item,
  );
  commitFile({ ...file, models: next });
  return affected.length;
};

/** 多少个自建对话模型启用了某个档位（档位池的 used_by_models 口径：按模型数，不按记录外维度）。 */
const countChatModelsUsingTier = (tier: unknown): number => {
  const parsed = ThinkingTierSchema.safeParse(typeof tier === 'string' ? tier.trim() : '');
  if (!parsed.success || parsed.data === THINKING_TIER_OFF) return 0;
  return getFile().models.filter((item) => item.enabled_thinking_tiers.includes(parsed.data)).length;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  listCustomChatModels,
  getCustomChatModel,
  getCustomChatModelByRecordId,
  addCustomChatModel,
  updateCustomChatModel,
  removeCustomChatModel,
  removeCustomChatModelsByConnection,
  stripThinkingTierFromChatModels,
  countChatModelsUsingTier,
  onCustomChatModelsChanged,
  clearCacheForTest,
  type CustomChatModelsFile,
};
