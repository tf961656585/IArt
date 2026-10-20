import {
  CustomGenerationModelSchema,
  type CustomGenerationModel,
} from '@iart/contracts';
import * as loggingModule from '../logging.cts';
import {
  listLegacyDeployments,
  removeLegacyDeploymentsByIds,
  retireLegacyDeploymentFile,
  type LegacyDeployment,
} from './legacy-deployment-file.cts';
import { resolveLegacyDeploymentModelCapability } from './deployment-to-generation-model-migration.cts';

/**
 * 存量接入载体（`ModelDeployment`，已退场）→ 用户生成模型记录 的一次性迁移
 * （spec 03 §11「升级约束：一次性换轨」，验收 PC-15）。
 *
 * **为什么单独一个文件**：`custom-generation-model-store.cts` 已经承载两段历史迁移（v1→v3 声明
 * 合并、v2→v3 素材位换算）与写入/查询/删除的全部职责，再塞第三段会把它推过行数上限，也会让
 * 「日常写入路径」与「一次性历史搬运」混在同一屏。本模块只有迁移一件事，且只在 store 首次装载
 * 时被调用一次。
 *
 * **旧接入文件由谁读**：`legacy-deployment-file.cts`（旧文件形状在整仓的唯一解析点）。本模块
 * 不再依赖任何「部署存储」——那个 store 已随载体退场整体删除，不再有写入入口。
 *
 * **为什么这段迁移不在 `FILE_VERSION` 里**：版本号描述的是 `custom-generation-models.json`
 * 自身的形状。本次迁移**不改变记录的形状**（记录的字段集合与语义都没动），改的是「数据从哪个
 * 文件搬过来」，所以记录文件版本保持 3；迁移的完成标志是**deployment store 里那条记录不在了**
 * （本迁移的原子单位），而不是文件版本号。
 *
 * **搬家顺序（与既有 v1→v3 声明合并同款）**：
 * 1. deployment store 先就绪（触发它从磁盘读取并完成自身的剥键式迁移）；
 * 2. 逐条 deployment 换算成记录候选，过 `CustomGenerationModelSchema.parse`；
 * 3. 记录落盘（由调用方 commit，一次写入）；
 * 4. 从旧接入文件移除**本批转换成功**的条目，返回被移除的 id 集合。
 *
 * 顺序不可颠倒：先移除接入再落盘，中途崩溃会让该模型既没有 deployment 也没有记录（用户模型
 * 凭空消失）；先落盘再移除，中途崩溃只会留下「记录已存在、接入还在」，重跑时按 `record_id`
 * 判定已迁移、只补做移除（幂等分支）。
 *
 * **只移除自己转换成功的条目**：跳过项（无族、表内无能力、与用户记录冲突、形状非法）的接入
 * 原样留在 deployment store，交给「撤载体」批次统一处理。本批不删除它们有两个理由——一是
 * 「尽力而为的清理」不该顺手销毁无法安全映射的数据（那是不可逆动作），二是留着它们才让每一项
 * 跳过都能在排查时对上号（日志指认 + 数据仍在，而不是只剩一行日志）。
 */

/** 迁移结果统计（调用方据此留痕；不承载业务语义，只描述这一次搬运发生了什么）。 */
export type DeploymentToRecordMigrationResult = {
  /** 本次新写入的记录（已过 schema）。 */
  migrated: CustomGenerationModel[];
  /** 本批应从 deployment store 移除的接入 id（含上次中断残留的补移除项）。 */
  removedDeploymentIds: string[];
  /** 因无族 / 表内无能力而跳过的接入数。 */
  skippedNoCapability: number;
  /** 因与既有记录冲突而跳过的接入数。 */
  skippedConflict: number;
  /** 因候选记录形状非法而跳过的接入数。 */
  skippedInvalid: number;
};

const emptyResult = (): DeploymentToRecordMigrationResult => ({
  migrated: [],
  removedDeploymentIds: [],
  skippedNoCapability: 0,
  skippedConflict: 0,
  skippedInvalid: 0,
});

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 把一条 deployment 换算成记录候选；无法换算时返回跳过原因（调用方留痕并计数）。
 *
 * 换算只补两件 deployment 当初没回答的事（族、素材位，见换算表），其余四个标识
 * （`model_id` / `connection_id` / `remote_model_id` / 时间）**逐值照搬**——升级不得改变用户可见的
 * 模型清单、所属服务商与远端模型名（PC-15）。
 */
const buildRecordCandidate = (
  deployment: LegacyDeployment,
): { ok: true; candidate: unknown } | { ok: false; reason: 'no_capability' } => {
  const modelId = normalizeString(deployment.model_id);
  const capability = resolveLegacyDeploymentModelCapability(modelId);
  if (capability === null) {
    // 无族（TTS / seedream / qwen / zimage 等从未进过可提交目录的包）或不属于升级前任何已分发型号：
    // 不给它编一个族，也不猜素材位——升级不改变协议语义，凭空补族等于给用户换了个模型。
    return { ok: false, reason: 'no_capability' };
  }
  return {
    ok: true,
    candidate: {
      model_id: modelId,
      // record_id 继承 deployment_id（与 deployment 同一 id 空间）：既有 active-routes.json 因此
      // 零改动仍指向正确的接入，用户不需要重新选择「当前使用」。
      record_id: deployment.deployment_id,
      connection_id: deployment.connection_id,
      remote_model_id: deployment.remote_model_id,
      family_adapter_id: capability.familyAdapterId,
      accepted_media_slots: [...capability.acceptedMediaSlots],
      // 参数覆盖是记录时代才有的数据，deployment 时代不存在：缺省物化为空覆盖（与新增记录同口径）。
      parameter_overrides: { official: [], custom: [] },
      created_at: deployment.created_at,
    },
  };
};

/**
 * 执行迁移（纯函数式编排：本函数**不写盘**，只回答「应该落哪些记录、移除哪些接入」）。
 *
 * 由 `custom-generation-model-store` 在自己的装载路径里调用并负责落盘与变更通知，因此迁移不需要
 * 反向依赖 store 的写入口（那会造成循环依赖：store 迁移 → store 写入 → 又触发装载）。
 *
 * `existingRecords` 是从磁盘读到的既有记录（当前形状，已过 schema）。函数不修改它。
 */
const planDeploymentToRecordMigration = (
  existingRecords: readonly CustomGenerationModel[],
): DeploymentToRecordMigrationResult => {
  const result = emptyResult();
  // 旧接入文件的读取由 legacy 模块统一承担（含 v1 退役档位键的剥离），迁移读到的必须是现役形状。
  const deployments = listLegacyDeployments();
  if (deployments.length === 0) return result;

  const byModelId = new Map<string, CustomGenerationModel>();
  const byRecordId = new Map<string, CustomGenerationModel>();
  for (const record of existingRecords) {
    byModelId.set(record.model_id, record);
    byRecordId.set(record.record_id, record);
  }

  for (const deployment of deployments) {
    const built = buildRecordCandidate(deployment);
    if (!built.ok) {
      result.skippedNoCapability += 1;
      loggingModule.logDebug(
        '[deployment→record migration] skip: model_id has no closed family at switch time, deployment kept',
        {
          deploymentId: deployment.deployment_id,
          modelId: deployment.model_id,
          reason: 'no_capability',
        },
      );
      continue;
    }

    // 幂等分支 1：record_id 已经在记录文件里（上次运行落盘成功但移除接入前中断，或这次载入前
    // 记录已被别处写就）。不重复写记录，只把这条接入补移除——否则它会永远卡在 deployment store 里
    // 成为一个「迁不动的僵尸接入」，而且每次装载都会重新尝试一遍。
    //
    // 仅当记录与被移除接入指向**同一个 model_id** 时才补移除：id 空间虽唯一，但记录若是别处写坏
    // 的（同 record_id、不同 model_id），按 id 移除接入就等于用一条错记录顶掉一个真实模型——
    // 这种情况按冲突保留接入并留痕，让人能看见。
    const alreadyByRecordId = byRecordId.get(deployment.deployment_id);
    if (alreadyByRecordId !== undefined) {
      if (alreadyByRecordId.model_id !== normalizeString(deployment.model_id)) {
        result.skippedConflict += 1;
        loggingModule.logDebug(
          '[deployment→record migration] skip: record_id already taken by a different model, deployment kept',
          {
            deploymentId: deployment.deployment_id,
            modelId: deployment.model_id,
            existingModelId: alreadyByRecordId.model_id,
            reason: 'record_id_model_mismatch',
          },
        );
        continue;
      }
      result.removedDeploymentIds.push(deployment.deployment_id);
      loggingModule.logDebug(
        '[deployment→record migration] already recorded under this record_id, only removing the deployment',
        {
          deploymentId: deployment.deployment_id,
          modelId: deployment.model_id,
          recordModelId: alreadyByRecordId.model_id,
          reason: 'already_recorded',
        },
      );
      continue;
    }

    // 冲突：同一个 model_id 已有一条记录，但 record_id 不同——即用户在换轨前自己建过同名模型。
    // 策略 = 记录优先（user record wins）：用户的记录是他亲手填的（远端模型名、素材位、参数覆盖
    // 都可能是他按自己的中转服务调过的），deployment 是旧软件代他建的。用后者覆盖前者会改写用户
    // 已生效的配置，并让 active route 指向一个用户从没见过的 record_id。
    // 因此：保留用户记录、不改写它；这条 deployment 编号不迁移、也不在本批删除（留给撤载体口径
    // 统一处理），并留痕指认冲突两侧，便于排查。
    const existingByModelId = byModelId.get(normalizeString(deployment.model_id));
    if (existingByModelId !== undefined) {
      result.skippedConflict += 1;
      loggingModule.logDebug(
        '[deployment→record migration] skip: conflict with an existing record for the same model_id, record kept as-is',
        {
          deploymentId: deployment.deployment_id,
          modelId: deployment.model_id,
          existingRecordId: existingByModelId.record_id,
          existingRemoteModelId: existingByModelId.remote_model_id,
          reason: 'conflict',
        },
      );
      continue;
    }

    const parsed = CustomGenerationModelSchema.safeParse(built.candidate);
    if (!parsed.success) {
      // 理论不可达（四个标识都来自已过 schema 的 deployment，族与素材位来自本仓常量），但外部输入
      // 边界上仍按「形状非法即跳过并留痕」处理，不静默丢弃。
      result.skippedInvalid += 1;
      loggingModule.logDebug('[deployment→record migration] skip: candidate record failed schema, deployment kept', {
        deploymentId: deployment.deployment_id,
        modelId: deployment.model_id,
        error: parsed.error.message,
      });
      continue;
    }

    result.migrated.push(parsed.data);
    result.removedDeploymentIds.push(deployment.deployment_id);
    // 同一次运行内同 model_id 只迁一条：deployment 的唯一性约束是「model_id + connection_id +
    // remote_model_id」，理论上一个 model_id 可以有多条接入（历史异常态）。记录是「一个 model_id
    // 一条」，首条（listDeployments 按 created_at 升序）胜出，其余按冲突跳过并留痕。
    byModelId.set(parsed.data.model_id, parsed.data);
    byRecordId.set(parsed.data.record_id, parsed.data);
  }

  return result;
};

/**
 * 从旧接入文件移除本次迁移过的接入，返回实际移除条数。
 *
 * 单独一步而不是混在 plan 里：plan 是纯读取（可重复调用、无副作用），移除是唯一的写副作用。
 * 调用方必须先落盘记录再调用本函数。
 */
const removeMigratedDeployments = (deploymentIds: readonly string[]): number => {
  if (deploymentIds.length === 0) return 0;
  const removed = removeLegacyDeploymentsByIds(deploymentIds);
  loggingModule.logDebug('[deployment→record migration] migrated deployments removed', {
    removed,
    requested: deploymentIds.length,
  });
  return removed;
};

/**
 * 收尾：把搬不走的残留条目归档后丢弃旧接入文件（spec 03 §11 一次性换轨的最后一步）。
 *
 * 调用方必须先完成「记录落盘 + 可迁移条目移除」，再调本函数。处置理由（为什么可以丢、
 * 为什么仍要归档）见 `legacy-deployment-file.cts` 的 `retireLegacyDeploymentFile`。
 *
 * 剩余条目数为 0 时同样是合法收尾（旧文件只剩被移除的条目或已不存在），函数内部幂等。
 */
const retireResidualDeployments = (): number => retireLegacyDeploymentFile();

export { planDeploymentToRecordMigration, removeMigratedDeployments, retireResidualDeployments };
