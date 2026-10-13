import * as fs from 'node:fs';
import {
  CustomGenerationModelSchema,
  type CustomGenerationModel,
  type ParameterOverrides,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { findProjectionByModelIdOrAlias } from '../model-package-catalog.cts';
import { resolveClosedFamilyAdapter } from '../model-family-registry.cts';
import { getCustomChatModel } from './custom-chat-model-store.cts';
import {
  generateDeploymentId,
  listDeployments,
  removeDeploymentsByIds,
} from './deployment-store.cts';

/**
 * 自建生成模型记录（spec 03 §6.1「Deployment 与自建模型记录」；2026-09-25 单记录形态）。
 *
 * - 文件：config/custom-generation-models.json（version 2）
 * - 2026-09-25 起「声明 + ModelDeployment 接入」两层合并为**服务商作用域单记录**：一条记录
 *   同时承载能力属性（族归属、是否支持参考图、参数覆盖）与接入归属（connection_id +
 *   remote_model_id），用户一次写入完成添加；`record_id` 由 backend 生成（复用 deployment id
 *   生成逻辑，同一 id 空间），active route 与执行快照引用它
 * - 与族模板在 Runtime Backend 内合成为内存态虚拟能力包投影（generation-declaration-projection）
 * - `model_id` 全局唯一（C6）：写入侧与已装模型包（model_id/别名/变体名）、对话侧自建记录、
 *   本域已有记录三方互斥；命中**其他生成族**正则的写入被命名空间护栏拒绝（D2）
 * - v1 存量迁移：每条 v1 声明从 model-deployments 反查该 model_id 的 deployment 合成 v2 记录
 *   （record_id 继承 deployment_id，active-routes 零改动）；孤儿声明丢弃并留痕；迁移完成后
 *   自建链 deployment 记录移除
 * - 删除记录时的 active route 清理由调用方编排，本模块不感知路由
 */

const FILE_VERSION = 2;

type CustomGenerationModelsPathMap = { customGenerationModels: string | undefined };

interface CustomGenerationModelsFile {
  version: number;
  updatedAt: string;
  models: CustomGenerationModel[];
}

const asPathMap = (value: unknown): CustomGenerationModelsPathMap | null =>
  isPlainObject(value) ? (value as CustomGenerationModelsPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.customGenerationModels : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): CustomGenerationModelsFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  models: [],
});

const normalizeModelId = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** v1 声明形状（宽松读取：缺字段按当时的缺省语义补齐，不因形状差异丢数据）。 */
const parseLegacyDeclaration = (entry: unknown): {
  model_id: string;
  family_adapter_id: string;
  supports_reference_image: boolean;
  parameter_overrides: ParameterOverrides | undefined;
  created_at: string;
} | null => {
  if (!isPlainObject(entry)) return null;
  const modelId = normalizeModelId((entry as { model_id: unknown }).model_id);
  const familyAdapterId = (entry as { family_adapter_id: unknown }).family_adapter_id;
  if (!modelId || typeof familyAdapterId !== 'string') return null;
  const overrides = (entry as { parameter_overrides: unknown }).parameter_overrides;
  const parsedOverrides = overrides === undefined || overrides === null
    ? undefined
    : (CustomGenerationModelSchema.shape.parameter_overrides.safeParse(overrides).success
        ? overrides as ParameterOverrides
        : undefined);
  if (overrides !== undefined && overrides !== null && parsedOverrides === undefined) {
    loggingModule.logDebug('[custom-generation-model-store] migrate: drop unparsable v1 parameter overrides', {
      modelId,
    });
  }
  return {
    model_id: modelId,
    family_adapter_id: familyAdapterId,
    supports_reference_image: (entry as { supports_reference_image: unknown }).supports_reference_image === true,
    parameter_overrides: parsedOverrides,
    created_at: typeof (entry as { created_at: unknown }).created_at === 'string'
      ? String((entry as { created_at: unknown }).created_at)
      : new Date(0).toISOString(),
  };
};

/**
 * v1 → v2 迁移：把声明与它名下的 deployment 合成单记录。
 *
 * 调用前必须已触发 `listDeployments()`（deployment store 先于声明迁移就绪）。生成记录不承载
 * 档位（档位只随对话记录走），只并入接入归属。
 */
const migrateLegacyModels = (rawModels: unknown[]): { records: CustomGenerationModel[]; mergedDeploymentIds: string[] } => {
  const deployments = listDeployments();
  const records: CustomGenerationModel[] = [];
  const mergedDeploymentIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const legacy = parseLegacyDeclaration(entry);
    if (legacy === null) {
      loggingModule.logDebug('[custom-generation-model-store] migrate: drop unparsable v1 declaration', { entry: String(entry).slice(0, 200) });
      continue;
    }
    if (seen.has(legacy.model_id)) {
      loggingModule.logDebug('[custom-generation-model-store] migrate: drop duplicated v1 declaration', { modelId: legacy.model_id });
      continue;
    }
    seen.add(legacy.model_id);
    // 反查该 model_id 的接入：取最早一条（多接入属历史异常态，与对话侧同一裁定）。
    const deployment = deployments.find((item) => item.model_id === legacy.model_id);
    if (!deployment) {
      loggingModule.logDebug('[custom-generation-model-store] migrate: orphan declaration without deployment, dropped', {
        modelId: legacy.model_id,
      });
      continue;
    }
    const candidate = {
      model_id: legacy.model_id,
      record_id: deployment.deployment_id,
      connection_id: deployment.connection_id,
      remote_model_id: deployment.remote_model_id,
      family_adapter_id: legacy.family_adapter_id,
      supports_reference_image: legacy.supports_reference_image,
      ...(legacy.parameter_overrides === undefined ? {} : { parameter_overrides: legacy.parameter_overrides }),
      created_at: legacy.created_at,
    };
    const parsed = CustomGenerationModelSchema.safeParse(candidate);
    if (!parsed.success) {
      loggingModule.logDebug('[custom-generation-model-store] migrate: merged record failed schema, dropped', {
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

const readFromDisk = (paths: unknown): CustomGenerationModelsFile | null => {
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
      const models: CustomGenerationModel[] = [];
      const seen = new Set<string>();
      const rawModels = (parsed as { models: unknown }).models;
      if (Array.isArray(rawModels)) {
        rawModels.forEach((entry, index) => {
          const result = CustomGenerationModelSchema.safeParse(entry);
          if (!result.success) {
            loggingModule.logDebug('[custom-generation-model-store] drop invalid model record', {
              index,
              error: result.error.message,
            });
            return;
          }
          if (seen.has(result.data.model_id)) {
            loggingModule.logDebug('[custom-generation-model-store] drop duplicated model record', {
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
    if (version === 1) {
      // v1 存量文件：先确保 deployment store 就绪，再按 model_id 反查接入合成 v2 记录并落盘升级。
      listDeployments();
      const rawModels = (parsed as { models: unknown }).models;
      const { records, mergedDeploymentIds } = migrateLegacyModels(Array.isArray(rawModels) ? rawModels : []);
      const migrated: CustomGenerationModelsFile = { version: FILE_VERSION, updatedAt, models: records };
      writeToDisk(paths, migrated);
      if (mergedDeploymentIds.length > 0) {
        const removed = removeDeploymentsByIds(mergedDeploymentIds);
        loggingModule.logDebug('[custom-generation-model-store] migrate: custom-chain deployments removed', {
          removed,
          mergedDeploymentIds,
        });
      }
      loggingModule.logDebug('[custom-generation-model-store] migrate: declarations file upgraded to v2', {
        migrated: records.length,
        droppedOrphans: (Array.isArray(rawModels) ? rawModels.length : 0) - records.length,
      });
      return migrated;
    }
    loggingModule.logDebug('[custom-generation-model-store] normalizeFile: unsupported version', { version });
    return null;
  } catch {
    return null;
  }
};

const writeToDisk = (paths: unknown, file: CustomGenerationModelsFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: CustomGenerationModelsFile | null = null;

const getFile = (): CustomGenerationModelsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

type CustomGenerationModelsChangeListener = () => void;

const changeListeners = new Set<CustomGenerationModelsChangeListener>();

/**
 * 记录变更监听：任一写入落盘成功后触发。本 store 不感知消费方（无业务知识，不反向依赖
 * 路由/投影）：由装配方注册回调使自己的派生快照失效（如 node-projections 投影快照的
 * 单飞重建）。返回退订函数；监听器抛错只留痕，不阻断写入路径。
 */
const onCustomGenerationModelsChanged = (
  listener: CustomGenerationModelsChangeListener,
): (() => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

const notifyCustomGenerationModelsChanged = (): void => {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      loggingModule.logDebug('[custom-generation-model-store] change listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const commitFile = (next: CustomGenerationModelsFile): CustomGenerationModelsFile => {
  const updated: CustomGenerationModelsFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  // 先落盘后置缓存：缓存与磁盘一致，且变更通知只代表「落盘成功」。
  writeToDisk(paths, updated);
  cache = updated;
  notifyCustomGenerationModelsChanged();
  return updated;
};

/** 已添加的自建生成模型（按添加顺序）。 */
const listCustomGenerationModels = (): CustomGenerationModel[] => [...getFile().models];

const getCustomGenerationModel = (modelId: string): CustomGenerationModel | null => {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  return getFile().models.find((item) => item.model_id === id) ?? null;
};

/** 按接入记录 id（record_id，同 deployment id 空间）取记录；active route 解析用。 */
const getCustomGenerationModelByRecordId = (recordId: unknown): CustomGenerationModel | null => {
  const id = normalizeModelId(recordId);
  if (!id) return null;
  return getFile().models.find((item) => item.record_id === id) ?? null;
};

/**
 * 添加自建生成模型的结果。
 *
 * `conflicts_with_other_generation_family`：该标识命中**其他生成族**的封闭正则——它会被那条
 * 生成链路识别为别族模型，冒名会导致未来装包撞车，写入侧拒绝（试点设计 D2）；命中本族
 * 正则（`gpt-image-*`）允许。
 * `duplicate_chat_record`：该标识已被一个对话侧自建记录占用——两个域共用全局唯一的
 * `model_id`（C6）。
 * `duplicate_installed_model`：该标识已经是某个已装模型的 `model_id`、别名或变体名——直接
 * 接入即可，不需要自建（与对话侧同一份实现，不另写查重）。
 */
export type AddCustomGenerationModelResult =
  | { ok: true; model: CustomGenerationModel }
  | {
      ok: false;
      reason:
        | 'conflicts_with_other_generation_family'
        | 'duplicate_chat_record'
        | 'duplicate_installed_model'
        | 'already_exists';
    };

/**
 * 添加自建生成模型（能力属性 + 接入归属一次写入）。
 *
 * `record_id` 由本 store 生成（复用 deployment id 生成逻辑）；归属校验（连接存在、enabled、
 * 有凭证）与协议合法性校验（`family_adapter_id` 有已登记的族模板）由调用方（路由）在写入侧
 * 执行；连接不再约束协议族（2026-09-26 起协议归属模型级）。
 */
const addCustomGenerationModel = (input: {
  model_id: string;
  connection_id: string;
  /** 省略回落 model_id。 */
  remote_model_id?: string;
  family_adapter_id: CustomGenerationModel['family_adapter_id'];
  /** 省略即「仅文生图」（与契约 schema 缺省同口径）。 */
  supports_reference_image?: boolean;
  /** 省略即空覆盖（与契约 schema 缺省同口径）；携带时随记录整体落库。 */
  parameter_overrides?: ParameterOverrides;
}): AddCustomGenerationModelResult => {
  const modelId = normalizeModelId(input.model_id);
  if (!modelId) {
    loggingModule.logDebug('[custom-generation-model-store] add: empty model_id', {});
    return { ok: false, reason: 'already_exists' };
  }
  if (getCustomGenerationModel(modelId) !== null) {
    loggingModule.logDebug('[custom-generation-model-store] add: already exists', { modelId });
    return { ok: false, reason: 'already_exists' };
  }
  // 命名空间护栏（D2）：命中其他族正则拒绝，命中本族（gpt-image-*）放行
  const regexFamily = resolveClosedFamilyAdapter(modelId);
  if (regexFamily !== null && regexFamily !== input.family_adapter_id) {
    loggingModule.logDebug('[custom-generation-model-store] add: model_id in another generation family namespace', {
      modelId,
      declaredFamily: input.family_adapter_id,
      regexFamily,
    });
    return { ok: false, reason: 'conflicts_with_other_generation_family' };
  }
  // 与对话侧自建记录互斥（C6：model_id 全局唯一，两个域不能各占一份）
  if (getCustomChatModel(modelId) !== null) {
    loggingModule.logDebug('[custom-generation-model-store] add: collision with chat record', { modelId });
    return { ok: false, reason: 'duplicate_chat_record' };
  }
  // 与已装模型包（model_id / shell_model_id / 别名 / 变体名）全局互斥——复用对话侧同一份查重实现
  if (findProjectionByModelIdOrAlias(modelId) !== undefined) {
    loggingModule.logDebug('[custom-generation-model-store] add: collision with installed model', { modelId });
    return { ok: false, reason: 'duplicate_installed_model' };
  }
  const remoteModelId = normalizeModelId(input.remote_model_id) || modelId;
  const candidate = {
    model_id: modelId,
    record_id: generateDeploymentId(),
    connection_id: input.connection_id,
    remote_model_id: remoteModelId,
    family_adapter_id: input.family_adapter_id,
    supports_reference_image: input.supports_reference_image ?? false,
    ...(input.parameter_overrides === undefined
      ? {}
      : { parameter_overrides: input.parameter_overrides }),
    created_at: new Date().toISOString(),
  };
  const parsed = CustomGenerationModelSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[custom-generation-model-store] add: invalid record', {
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
 * 改自建生成模型记录的可改属性（是否支持参考图、参数覆盖）；返回 null 表示没有这个记录。
 *
 * 各字段整体替换（与 `CustomGenerationModelUpdateBodySchema` 同口径）：`parameter_overrides`
 * 缺省 = 保持现有覆盖不变；出现 = 整体替换现有覆盖（显式空覆盖即清空全部覆盖）。
 * 不给改 `model_id` 与接入归属（connection_id / remote_model_id / family_adapter_id）：
 * 改身份等于换一个模型，改族等于换一套协议语义，都应随删除重建完成。
 */
const updateCustomGenerationModel = (
  modelId: string,
  input: {
    supports_reference_image: boolean;
    /** 缺省 = 保持现有覆盖不变；出现 = 整体替换。 */
    parameter_overrides?: ParameterOverrides;
  },
): CustomGenerationModel | null => {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  const file = getFile();
  const index = file.models.findIndex((item) => item.model_id === id);
  if (index < 0) {
    loggingModule.logDebug('[custom-generation-model-store] update: not found', { modelId: id });
    return null;
  }
  const existing = file.models[index];
  if (!existing) return null;
  const candidate = {
    ...existing,
    supports_reference_image: input.supports_reference_image,
    ...(input.parameter_overrides === undefined
      ? {}
      : { parameter_overrides: input.parameter_overrides }),
  };
  const parsed = CustomGenerationModelSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[custom-generation-model-store] update: invalid record value', {
      modelId: id,
      error: parsed.error.message,
    });
    return null;
  }
  const next = file.models.map((item, i) => (i === index ? parsed.data : item));
  commitFile({ ...file, models: next });
  return parsed.data;
};

/** 删除自建生成模型记录；返回 false 表示没有这个记录。active route 清理由调用方编排。 */
const removeCustomGenerationModel = (modelId: string): boolean => {
  const id = normalizeModelId(modelId);
  if (!id) return false;
  const file = getFile();
  if (!file.models.some((item) => item.model_id === id)) {
    loggingModule.logDebug('[custom-generation-model-store] remove: not found', { modelId: id });
    return false;
  }
  commitFile({ ...file, models: file.models.filter((item) => item.model_id !== id) });
  return true;
};

/**
 * 删除某条连接下的全部自建生成记录，返回被删记录。
 *
 * 用于删除服务商连接的级联清理（spec 03 §6.1：不存在无归属的自建模型）。调用方需按返回的
 * model_id 逐个清 active route。
 */
const removeCustomGenerationModelsByConnection = (connectionId: unknown): CustomGenerationModel[] => {
  const id = typeof connectionId === 'string' ? connectionId.trim() : '';
  if (!id) return [];
  const file = getFile();
  const removed = file.models.filter((item) => item.connection_id === id);
  if (removed.length === 0) return [];
  commitFile({ ...file, models: file.models.filter((item) => item.connection_id !== id) });
  return removed;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  listCustomGenerationModels,
  getCustomGenerationModel,
  getCustomGenerationModelByRecordId,
  addCustomGenerationModel,
  updateCustomGenerationModel,
  removeCustomGenerationModel,
  removeCustomGenerationModelsByConnection,
  onCustomGenerationModelsChanged,
  clearCacheForTest,
  type CustomGenerationModelsFile,
};
