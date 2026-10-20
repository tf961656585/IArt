import * as fs from 'node:fs';
import {
  CustomGenerationModelSchema,
  type CustomGenerationModel,
  type GenerationMediaSlotId,
  type ParameterOverrides,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';
import { checkFamilyMediaSlotSupport } from '../generation-family-templates.registry.cts';
import { getCustomChatModel } from './custom-chat-model-store.cts';
import { generateRecordId } from './record-id.cts';
import {
  listLegacyDeployments,
  removeLegacyDeploymentsByIds,
  type LegacyDeployment,
} from './legacy-deployment-file.cts';
import {
  planDeploymentToRecordMigration,
  removeMigratedDeployments,
  type DeploymentToRecordMigrationResult,
} from './deployment-to-record-migration.cts';

/**
 * 自建生成模型记录（spec 03 §6.1「Deployment 与自建模型记录」；2026-09-25 单记录形态）。
 *
 * - 文件：config/custom-generation-models.json（version 3）
 * - 2026-09-25 起「声明 + 接入」两层合并为**服务商作用域单记录**（接入载体已于 2026-10-19 退场）：一条记录
 *   同时承载能力属性（族归属、接受的素材位、参数覆盖）与接入归属（connection_id +
 *   remote_model_id），用户一次写入完成添加；`record_id` 由 backend 生成（复用 deployment id
 *   生成逻辑，同一 id 空间），active route 与执行快照引用它
 * - 2026-10-19 起能力字段由单个 `supports_reference_image` 布尔放宽为受控素材位清单
 *   `accepted_media_slots`（词表在 contracts 的 `GENERATION_MEDIA_SLOT_IDS`）；文件版本
 *   随之升 3，v1/v2 存量文件在读取时一次性升级
 * - 与族模板在 Runtime Backend 内合成为内存态虚拟能力包投影（generation-declaration-projection）
 * - `model_id` 全局唯一：写入侧与本域已有记录、对话侧记录互斥（2026-10-19 起软件不内置任何
 *   具体模型，因此不再有「与已装模型包重名」这一种冲突，也不再需要按族命名空间做护栏）
 * - v1 存量迁移：每条 v1 声明从旧接入文件反查该 model_id 的接入合成记录（record_id 继承旧接入
 *   id，active-routes 零改动）；孤儿声明丢弃并留痕；迁移完成后被并掉的旧接入从旧文件移除
 * - v2 存量迁移：旧记录带已退役的 `supports_reference_image` 键，先剥键再按新字段语义换算
 *   （true → ['reference_image']，false → []），再走 schema parse
 * - 删除记录时的 active route 清理由调用方编排，本模块不感知路由
 */

const FILE_VERSION = 3;

/*
 * 已退役的能力键：v1/v2 文件里残留的 `supports_reference_image`。`.strict()` schema 见到它会
 * 整条 parse 失败、把存量记录静默丢掉，因此读取存量文件时必须先剥键再 parse
 * （AGENTS.md「持久化 JSON 的 schema 演进」①b）。剥键实现见下方 `toV2MigrationCandidate`。
 */

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

/**
 * 旧版「是否支持参考图」布尔 → 受控素材位清单（2026-10-19 字段放宽的唯一换算实现）。
 *
 * v1/v2 存量记录只有一个布尔，它当时表达的就是「能不能传参考图」。true 换算成
 * `['reference_image']`，false 换算成空清单；两种取值都按新语义表达同一件事，不新增
 * 中间态。换算只在读取存量文件时使用，写入路径直接落素材位清单。
 */
const legacyReferenceImageToMediaSlots = (supportsReferenceImage: boolean): GenerationMediaSlotId[] =>
  supportsReferenceImage ? ['reference_image'] : [];

/**
 * v2 存量记录的原始形状（外部输入边界：字段未校验、逐键探测）。
 *
 * 全部字段 optional + unknown：这是**读取边界**的类型，不是业务模型；剥键与换算后仍要过
 * `CustomGenerationModelSchema.safeParse` 才入库。旧键 `supports_reference_image` 在这里
 * 显式列出，是因为「读到它并换算掉」正是本迁移的职责——不等于承认它仍是契约字段。
 */
type LegacyGenerationModelV2Raw = {
  model_id?: unknown;
  record_id?: unknown;
  connection_id?: unknown;
  remote_model_id?: unknown;
  family_adapter_id?: unknown;
  supports_reference_image?: unknown;
  accepted_media_slots?: unknown;
  parameter_overrides?: unknown;
  created_at?: unknown;
};

/**
 * 把一条 v2 存量记录翻译成当前 schema 的候选对象（**剥键式迁移**）。
 *
 * 输出对象里不含已退役的 `supports_reference_image` 键：`.strict()` schema 见到残留键会
 * 整条拒收（存量记录静默丢失），所以不能「parse 前原地删键」，而要在构造候选对象时就不带它。
 * 素材位清单的取值优先级：写侧已按新字段落库的清单 > 旧布尔换算 > 空清单。
 */
const toV2MigrationCandidate = (raw: LegacyGenerationModelV2Raw): {
  model_id: unknown;
  record_id: unknown;
  connection_id: unknown;
  remote_model_id: unknown;
  family_adapter_id: unknown;
  accepted_media_slots: unknown;
  parameter_overrides: unknown;
  created_at: unknown;
} => ({
  model_id: raw.model_id,
  record_id: raw.record_id,
  connection_id: raw.connection_id,
  remote_model_id: raw.remote_model_id,
  family_adapter_id: raw.family_adapter_id,
  accepted_media_slots: raw.accepted_media_slots ?? legacyReferenceImageToMediaSlots(raw.supports_reference_image === true),
  parameter_overrides: raw.parameter_overrides,
  created_at: raw.created_at,
});

/** v1 声明形状（宽松读取：缺字段按当时的缺省语义补齐，不因形状差异丢数据）。 */
const parseLegacyDeclaration = (entry: unknown): {
  model_id: string;
  family_adapter_id: string;
  accepted_media_slots: GenerationMediaSlotId[];
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
    accepted_media_slots: legacyReferenceImageToMediaSlots(
      (entry as { supports_reference_image: unknown }).supports_reference_image === true,
    ),
    parameter_overrides: parsedOverrides,
    created_at: typeof (entry as { created_at: unknown }).created_at === 'string'
      ? String((entry as { created_at: unknown }).created_at)
      : new Date(0).toISOString(),
  };
};

/**
 * v1 → v3 迁移：把声明与它名下的旧接入合成单记录，并把旧的参考图布尔换算成素材位。
 *
 * 生成记录不承载档位（档位只随对话记录走），只并入接入归属。
 */
const migrateLegacyModels = (rawModels: unknown[]): { records: CustomGenerationModel[]; mergedDeploymentIds: string[] } => {
  const deployments = listLegacyDeployments();
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
    const deployment: LegacyDeployment | undefined = deployments.find((item) => item.model_id === legacy.model_id);
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
      accepted_media_slots: legacy.accepted_media_slots,
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

/**
 * v2 → v3 迁移：逐条剥掉已退役的 `supports_reference_image` 键，换算成 `accepted_media_slots`，
 * 再走当前 schema parse。
 *
 * **必须先剥键再 parse**：schema 是 `.strict()`，旧文件里的残留键会让整条 parse 失败、
 * 存量记录被静默丢弃（数据丢失而不是报错）。换算与剥键都是逐条独立完成的，一条坏记录
 * 不影响同文件其余记录。
 */
const migrateV2Models = (rawModels: unknown[]): { records: CustomGenerationModel[]; migrated: number; dropped: number } => {
  const records: CustomGenerationModel[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of rawModels) {
    if (!isPlainObject(entry)) {
      loggingModule.logDebug('[custom-generation-model-store] migrate v2: drop non-object record', { entry: String(entry).slice(0, 200) });
      dropped += 1;
      continue;
    }
    const candidate = toV2MigrationCandidate(entry);
    const parsed = CustomGenerationModelSchema.safeParse(candidate);
    if (!parsed.success) {
      loggingModule.logDebug('[custom-generation-model-store] migrate v2: record failed schema, dropped', {
        modelId: typeof candidate.model_id === 'string' ? candidate.model_id : '',
        error: parsed.error.message,
      });
      dropped += 1;
      continue;
    }
    if (seen.has(parsed.data.model_id)) {
      loggingModule.logDebug('[custom-generation-model-store] migrate v2: drop duplicated record', {
        modelId: parsed.data.model_id,
      });
      dropped += 1;
      continue;
    }
    seen.add(parsed.data.model_id);
    records.push(parsed.data);
  }
  return { records, migrated: records.length, dropped };
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
    if (version === 2) {
      // v2 存量文件：记录带已退役的 `supports_reference_image` 键（.strict() schema 会整条
      // 拒收），逐条剥键 + 换算成素材位清单后升级落盘。
      const rawModels = (parsed as { models: unknown }).models;
      const { records, migrated, dropped } = migrateV2Models(Array.isArray(rawModels) ? rawModels : []);
      const upgraded: CustomGenerationModelsFile = { version: FILE_VERSION, updatedAt, models: records };
      writeToDisk(paths, upgraded);
      loggingModule.logDebug('[custom-generation-model-store] migrate: models file upgraded to v3', {
        migrated,
        dropped,
      });
      return upgraded;
    }
    if (version === 1) {
      // v1 存量文件：按 model_id 反查旧接入合成单记录并落盘升级。
      const rawModels = (parsed as { models: unknown }).models;
      const { records, mergedDeploymentIds } = migrateLegacyModels(Array.isArray(rawModels) ? rawModels : []);
      const migrated: CustomGenerationModelsFile = { version: FILE_VERSION, updatedAt, models: records };
      writeToDisk(paths, migrated);
      if (mergedDeploymentIds.length > 0) {
        const removed = removeLegacyDeploymentsByIds(mergedDeploymentIds);
        loggingModule.logDebug('[custom-generation-model-store] migrate: custom-chain deployments removed', {
          removed,
          mergedDeploymentIds,
        });
      }
      loggingModule.logDebug('[custom-generation-model-store] migrate: declarations file upgraded past v1', {
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

/**
 * 装载时执行存量「deployment → 记录」迁移（spec 03 §11 一次性换轨，验收 PC-15）。
 *
 * 顺序与既有 v1/v2→v3 迁移同款：先把当前形状的记录读出来（含 v1/v2 的文件形状升级），再就
 * deployment 侧做换算。要点：
 * - **只在装载路径上做一次**：记录 store 的每条读写都经过 `getFile()`，把迁移放在这里意味着
 *   「任何模型被执行、被投影或被视为可提交之前」，迁移一定已经完成（§11 硬约束）。
 * - **无 deployment 时是零操作**：不写盘、不发变更通知（新装用户与二次启动都不会被碰）。
 * - **先落盘记录、再移除接入**：中断只会留下「记录已存在、接入还在」的可重跑中间态（下一次
 *   装载按 record_id 判定已迁移并补做移除），不会出现「两头都没有」。
 */
const runDeploymentToRecordMigration = (
  paths: unknown,
  file: CustomGenerationModelsFile,
): CustomGenerationModelsFile => {
  let plan: DeploymentToRecordMigrationResult;
  try {
    plan = planDeploymentToRecordMigration(file.models);
  } catch (error) {
    // 迁移不得让整个记录 store 读不出来：抛错即保留已读出的记录、跳过本次搬运（下次装载重试）。
    loggingModule.logDebug('[custom-generation-model-store] deployment→record migration failed, records kept as-is', {
      error: error instanceof Error ? error.message : String(error),
    });
    return file;
  }
  const hasWork = plan.migrated.length > 0 || plan.removedDeploymentIds.length > 0;
  if (!hasWork) {
    // 没有可迁移项也可能有跳过项（无族 / 冲突），跳过已由 plan 逐条留痕；这里不再重复刷日志。
    return file;
  }
  const next: CustomGenerationModelsFile = plan.migrated.length === 0
    ? file
    : { ...file, updatedAt: new Date().toISOString(), models: [...file.models, ...plan.migrated] };
  if (plan.migrated.length > 0) {
    writeToDisk(paths, next);
    loggingModule.logDebug('[custom-generation-model-store] deployment→record migration wrote records', {
      migrated: plan.migrated.length,
      modelIds: plan.migrated.map((item) => item.model_id),
    });
  }
  // 记录先落盘，再移除接入（顺序不可颠倒，见 runDeploymentToRecordMigration 的 doc）。
  const removed = removeMigratedDeployments(plan.removedDeploymentIds);
  loggingModule.logDebug('[custom-generation-model-store] deployment→record migration finished', {
    migrated: plan.migrated.length,
    deploymentsRemoved: removed,
    skippedNoCapability: plan.skippedNoCapability,
    skippedConflict: plan.skippedConflict,
    skippedInvalid: plan.skippedInvalid,
  });
  return next;
};

const getFile = (): CustomGenerationModelsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  const loaded = readFromDisk(paths) ?? buildEmptyFile();
  cache = runDeploymentToRecordMigration(paths, loaded);
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
 * `duplicate_chat_record`：该标识已被一个对话侧记录占用——两个域共用全局唯一的 `model_id`。
 * `already_exists`：本域已有同 `model_id` 的记录。
 *
 * 2026-10-19 起不再有「与已装模型包重名」（`duplicate_installed_model`）与「命中其他生成族命名
 * 空间」（`conflicts_with_other_generation_family`）两种失败：软件不内置任何具体模型，模型来源
 * 只有用户记录，因此没有第二个来源可以撞名，也不存在「按族正则抢注模型」的对象
 * （spec 03 §6.1 单一载体 / §12 PC-14、PC-15）。
 */
export type AddCustomGenerationModelResult =
  | { ok: true; model: CustomGenerationModel }
  | {
      ok: false;
      reason: 'duplicate_chat_record' | 'already_exists';
    }
  /** 素材位超出该族模板能表达的范围（`message` 是可读原因，调用方原样透给用户）。 */
  | { ok: false; reason: 'media_slot_not_supported_by_family'; message: string };

/**
 * 素材位 × 族能力守卫（写入侧唯一实现，2026-10-19 批次 1 收口批次 2 遗留风险）。
 *
 * 判断依据是族模板注册表条目的 `supportsMediaSlots`：契约只保证素材位在受控词表内，不保证
 * 「这个族的模板能表达这个素材位」。放在 store 而不只在路由，是因为 store 也是写入入口
 * （级联迁移以外的所有记录都经 add/update 落盘），只在路由挡会留下绕过路径。
 *
 * 返回 null = 通过；否则返回可读原因（逐位指认越界的素材位，不笼统说「参数无效」）。
 */
const describeMediaSlotMismatch = (
  familyAdapterId: CustomGenerationModel['family_adapter_id'],
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
): string | null => {
  if (acceptedMediaSlots.length === 0) return null;
  const support = checkFamilyMediaSlotSupport(familyAdapterId, acceptedMediaSlots);
  if (support.kind === 'ok') return null;
  if (support.kind === 'unknown_family') {
    loggingModule.logDebug('[custom-generation-model-store] media slots: unknown family adapter id', {
      familyAdapterId,
    });
    return '这个接口类型不能用于生成模型';
  }
  if (support.supportsMediaSlots.length === 0) {
    // 模板未就绪的族：见 add 的 doc comment「pending 族的写入口径」。
    loggingModule.logDebug('[custom-generation-model-store] media slots: family template pending', {
      familyAdapterId,
      acceptedMediaSlots,
    });
    return '这个接口类型还在支持中，暂时不能设置素材输入';
  }
  loggingModule.logDebug('[custom-generation-model-store] media slots: unsupported media slots for family', {
    familyAdapterId,
    acceptedMediaSlots,
    supportsMediaSlots: support.supportsMediaSlots,
  });
  return `这个接口类型不接受「${support.unsupportedMediaSlots.join('、')}」这类素材`;
};

/**
 * 添加自建生成模型（能力属性 + 接入归属一次写入）。
 *
 * `record_id` 由本 store 生成（`up_dep_` 前缀，见 record-id.cts）；归属校验（连接存在、enabled、
 * 有凭证）与协议合法性校验（`family_adapter_id` 有已登记的族模板）由调用方（路由）在写入侧
 * 执行；连接不再约束协议族（2026-09-26 起协议归属模型级）。
 */
const addCustomGenerationModel = (input: {
  model_id: string;
  connection_id: string;
  /** 省略回落 model_id。 */
  remote_model_id?: string;
  family_adapter_id: CustomGenerationModel['family_adapter_id'];
  /** 省略即「不接受任何素材」（与契约 schema 缺省同口径）。 */
  accepted_media_slots?: GenerationMediaSlotId[];
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
  // 与对话侧记录互斥（model_id 全局唯一，两个域不能各占一份）
  if (getCustomChatModel(modelId) !== null) {
    loggingModule.logDebug('[custom-generation-model-store] add: collision with chat record', { modelId });
    return { ok: false, reason: 'duplicate_chat_record' };
  }
  // 素材位必须是该族模板能表达的范围（批次 2 遗留风险：契约不拦族能力，写入侧必须拦）
  const mediaSlotMismatch = describeMediaSlotMismatch(input.family_adapter_id, input.accepted_media_slots ?? []);
  if (mediaSlotMismatch !== null) {
    return { ok: false, reason: 'media_slot_not_supported_by_family', message: mediaSlotMismatch };
  }
  const remoteModelId = normalizeModelId(input.remote_model_id) || modelId;
  const candidate = {
    model_id: modelId,
    record_id: generateRecordId(),
    connection_id: input.connection_id,
    remote_model_id: remoteModelId,
    family_adapter_id: input.family_adapter_id,
    accepted_media_slots: input.accepted_media_slots ?? [],
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
 * 改自建生成模型记录的可改属性（接受的素材位、参数覆盖）。
 *
 * 各字段整体替换（与 `CustomGenerationModelUpdateBodySchema` 同口径）：`accepted_media_slots`
 * 整体替换（显式空数组即「不接受任何素材」）；`parameter_overrides` 缺省 = 保持现有覆盖
 * 不变；出现 = 整体替换现有覆盖（显式空覆盖即清空全部覆盖）。
 * 不给改 `model_id` 与接入归属（connection_id / remote_model_id / family_adapter_id）：
 * 改身份等于换一个模型，改族等于换一套协议语义，都应随删除重建完成。
 *
 * 结果用判别联合而不是 `记录 | null`：「没有这个记录」与「素材位越界」是两种必须分开呈现的
 * 失败（前者 404、后者 400 + 可读原因），合成一个 null 会让调用方把后者报成「模型不存在」。
 */
export type UpdateCustomGenerationModelResult =
  | { ok: true; model: CustomGenerationModel }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'media_slot_not_supported_by_family'; message: string }
  /** 记录形状在整体替换后不合法（理论不可达：族与归属都不变，只换素材位与覆盖）。 */
  | { ok: false; reason: 'invalid_record' };

const updateCustomGenerationModel = (
  modelId: string,
  input: {
    accepted_media_slots: GenerationMediaSlotId[];
    /** 缺省 = 保持现有覆盖不变；出现 = 整体替换。 */
    parameter_overrides?: ParameterOverrides;
  },
): UpdateCustomGenerationModelResult => {
  const id = normalizeModelId(modelId);
  if (!id) return { ok: false, reason: 'not_found' };
  const file = getFile();
  const index = file.models.findIndex((item) => item.model_id === id);
  if (index < 0) {
    loggingModule.logDebug('[custom-generation-model-store] update: not found', { modelId: id });
    return { ok: false, reason: 'not_found' };
  }
  const existing = file.models[index];
  if (!existing) return { ok: false, reason: 'not_found' };
  // 素材位必须是该族模板能表达的范围（族归属不可变，用记录自带的族判断）
  const mediaSlotMismatch = describeMediaSlotMismatch(existing.family_adapter_id, input.accepted_media_slots);
  if (mediaSlotMismatch !== null) {
    return { ok: false, reason: 'media_slot_not_supported_by_family', message: mediaSlotMismatch };
  }
  const candidate = {
    ...existing,
    accepted_media_slots: input.accepted_media_slots,
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
    return { ok: false, reason: 'invalid_record' };
  }
  const next = file.models.map((item, i) => (i === index ? parsed.data : item));
  commitFile({ ...file, models: next });
  return { ok: true, model: parsed.data };
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
