import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';

/**
 * 退役载体 `ModelDeployment` 的**旧文件读取与退役处置**（迁移专用，2026-10-19）。
 *
 * 部署载体已随原子换轨整体退场（spec 03 §6.1 单一载体、§12 PC-14）。本模块是
 * `config/model-deployments.json` 在整仓**唯一的访问者**，且只在一次性历史搬运里被调用：
 * 1. `deployment-to-record-migration.cts`：装载时把可安全映射的条目换成用户模型记录；
 * 2. 两个 store 的 v1→v3 声明迁移：v1 声明要从旧接入里取回 `connection_id` / `remote_model_id`，
 *    搬完后把**自己并掉的那几条**从旧文件移除（其余条目留给第 1 步处理）；
 * 3. `retireLegacyDeploymentFile`：把搬不走的残留条目归档后丢弃该文件。
 *
 * 三条纪律（为什么这里没有 create / update）：
 * - **不提供逐条写入 API**：部署载体的写入路径已不存在（路由、Hub、执行链都不再产生接入）。
 *   留一个 `createDeployment` 就等于留了把第二类接入载体请回来的门。
 * - **旧文件形状只在这里解析**：`ModelDeploymentSchema` 已从 contracts 删除；旧文件形状
 *   （含 v1 退役档位键）冻结为本模块内部的读取边界类型，不再是跨边界契约。
 * - **保留的唯一写操作是「移除指定条目」**：v1 声明迁移把它并掉的接入从旧文件摘掉，避免同一
 *   条接入被第 1 步再换算一次。这不是「部署存储」，是「旧文件的一次性裁剪」。
 */

/** 旧文件版本：v1 带已退役的档位键，v2 是撤载体前的现役形状。其余版本判废。 */
const LEGACY_FILE_VERSION_V1 = 1;
const LEGACY_FILE_VERSION_V2 = 2;

/** v1 文件里带、v2 起已退役的两个档位键（读取时剥掉，不进内部形状）。 */
const RETIRED_TIER_KEYS = ['enabled_thinking_tiers', 'default_thinking_tier'] as const;

/**
 * 旧文件里的一条接入（读取边界形状：逐字段探测后仍要过 `parseLegacyDeployment` 才可用）。
 *
 * 字段集合是撤载体那一刻的现役形状：迁移真正消费 `deployment_id` / `model_id` /
 * `connection_id` / `remote_model_id` / `created_at` 五个值，`updated_at` 只为形状完整性保留。
 */
export type LegacyDeployment = {
  deployment_id: string;
  model_id: string;
  connection_id: string;
  remote_model_id: string;
  created_at: string;
  updated_at: string;
};

type LegacyDeploymentFile = {
  version: number;
  updatedAt: string;
  deployments: LegacyDeployment[];
  /**
   * v1 存量接入的档位启用关系（deployment_id → 档位）。
   *
   * v1 时代档位落在接入上（spec 37 v4.0.0 前）；声明层合并后档位随自建对话模型记录走。
   * 只有 v1 文件会填充本表，且只在 `custom-chat-model-store` 的 v1→v3 迁移里被读一次。
   * 文件升为 v2 后（档位已并入记录）重读得到空表，迁移因此自然不再拿到旧值。
   */
  legacyThinkingTiers: Map<string, LegacyThinkingTiers>;
};

/** v1 接入上的档位启用关系（剥离后的现役语义形状）。 */
type LegacyThinkingTiers = {
  enabled_thinking_tiers: string[];
  default_thinking_tier: string | null;
};

/**
 * 旧文件里一条 deployment 剥键前的原始形状（读取边界类型：每个字段都按 `unknown` 探测，
 * 不信任文件内容）。字段显式列出而不是用开放 Map，是为了让拼错的键在编译期暴露
 * （AGENTS.md「Store 数据路径安全」）。
 */
type LegacyDeploymentRaw = {
  deployment_id?: unknown;
  model_id?: unknown;
  connection_id?: unknown;
  remote_model_id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  enabled_thinking_tiers?: unknown;
  default_thinking_tier?: unknown;
};

/** 把一条未校验的条目收成可逐键探测的读取边界形状（非对象即空对象，后续判废）。 */
const asRawEntry = (entry: unknown): LegacyDeploymentRaw => (isPlainObject(entry) ? entry : {});

type StoragePathsLike = { modelDeployments: string | undefined };

const asPathMap = (value: unknown): StoragePathsLike | null =>
  isPlainObject(value) ? (value as StoragePathsLike) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.modelDeployments : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const resolveFilePath = (): string | null => getFilePath(ensureStorageDirs());

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 从一条 v1 原始条目里取出档位启用关系（缺字段即空档位 / 无默认，不补猜）。 */
const asLegacyThinkingTiers = (source: LegacyDeploymentRaw): LegacyThinkingTiers => {
  const rawEnabled = source.enabled_thinking_tiers;
  const enabled = Array.isArray(rawEnabled)
    ? rawEnabled.filter((item): item is string => typeof item === 'string')
    : [];
  const rawDefault = source.default_thinking_tier;
  return {
    enabled_thinking_tiers: enabled,
    default_thinking_tier: typeof rawDefault === 'string' ? rawDefault : null,
  };
};

const DEPLOYMENT_ID_PATTERN = /^up_dep_[a-z0-9][a-z0-9-_]*$/;

/**
 * 一条旧接入的形状校验（等价于已删除的 `ModelDeploymentSchema`，但不再走 Zod、也不进 contracts）。
 *
 * 判废而不是补默认值：旧文件是外部输入，缺 `model_id` 或 `remote_model_id` 的条目无法安全映射
 * 成记录（迁移按无能力跳过，退役归档时原样留在归档里），绝不能凭空补出值。
 */
const parseLegacyDeployment = (raw: unknown): LegacyDeployment | null => {
  if (!isPlainObject(raw)) return null;
  const source = asRawEntry(raw);
  const deploymentId = normalizeString(source.deployment_id);
  const modelId = normalizeString(source.model_id);
  const connectionId = normalizeString(source.connection_id);
  const remoteModelId = normalizeString(source.remote_model_id);
  const createdAt = normalizeString(source.created_at);
  const updatedAt = normalizeString(source.updated_at);
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return null;
  if (!modelId || !connectionId || !remoteModelId || !createdAt) return null;
  return {
    deployment_id: deploymentId,
    model_id: modelId,
    connection_id: connectionId,
    remote_model_id: remoteModelId,
    created_at: createdAt,
    updated_at: updatedAt || createdAt,
  };
};

/**
 * 读旧文件并归一成当前形状（**唯一读取点**，两次调用共用一个快照语义）。
 *
 * 返回 null = 文件不存在 / 不可解析 / 版本不认识。文件在但没有一条合法条目时返回空 deployments
 * （仍然算「文件存在」，退役时照样要归档掉它，否则残留文件会被下一版误读成事实源）。
 */
const readLegacyFile = (): { filePath: string; file: LegacyDeploymentFile } | null => {
  const filePath = resolveFilePath();
  if (!filePath || !fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error: unknown) {
    loggingModule.logDebug('[legacy-deployment-file] unparsable file, treated as absent', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const version = Number((parsed as { version: unknown }).version);
  // v1 = 存量文件（带已退役档位键，读取时剥键）；v2 = 撤载体前的现役形状。其余版本判废。
  if (!Number.isFinite(version) || (version !== LEGACY_FILE_VERSION_V1 && version !== LEGACY_FILE_VERSION_V2)) {
    loggingModule.logDebug('[legacy-deployment-file] unsupported version, treated as absent', { version });
    return null;
  }
  const rawUpdatedAt = (parsed as { updatedAt: unknown }).updatedAt;
  const updatedAt = typeof rawUpdatedAt === 'string' ? rawUpdatedAt : new Date(0).toISOString();
  const rawDeployments = (parsed as { deployments: unknown }).deployments;
  const deployments: LegacyDeployment[] = [];
  const legacyThinkingTiers = new Map<string, LegacyThinkingTiers>();
  if (Array.isArray(rawDeployments)) {
    rawDeployments.forEach((entry: unknown, index) => {
      const source: LegacyDeploymentRaw = { ...asRawEntry(entry) };
      if (version === LEGACY_FILE_VERSION_V1) {
        // 剥键前先把档位收进 legacy map（声明迁移据此把档位并入自建对话记录），再剥键——
        // 档位键随声明层退役（spec 37 v4.0.0），留着不影响形状校验，但会让「读到的就是现役
        // 形状」这一前提失真。
        const tiers = asLegacyThinkingTiers(source);
        if (tiers.enabled_thinking_tiers.length > 0 || tiers.default_thinking_tier !== null) {
          const deploymentId = normalizeString(source.deployment_id) || `index-${index}`;
          legacyThinkingTiers.set(deploymentId, tiers);
        }
        for (const key of RETIRED_TIER_KEYS) delete source[key];
      }
      const parsedDeployment = parseLegacyDeployment(source);
      if (parsedDeployment === null) {
        loggingModule.logDebug('[legacy-deployment-file] drop invalid deployment entry', { index });
        return;
      }
      deployments.push(parsedDeployment);
    });
  }
  return {
    filePath,
    file: {
      version: LEGACY_FILE_VERSION_V2,
      updatedAt,
      deployments: deployments.sort((a, b) => a.created_at.localeCompare(b.created_at)),
      legacyThinkingTiers,
    },
  };
};

/**
 * 迁移专用：读出旧文件里全部接入（按 `created_at` 升序，与撤载体前同序）。
 *
 * 只被迁移代码消费；其它运行时路径（目录投影、执行快照、active route）一律不读旧文件——
 * 它们只认用户模型记录（spec 03 §11：转换完成后旧载体不再被读取）。
 */
const listLegacyDeployments = (): LegacyDeployment[] => readLegacyFile()?.file.deployments ?? [];

/**
 * 迁移专用：v1 存量接入的档位启用关系（deployment_id → {启用档位, 默认档位}）。
 *
 * 唯一调用方是 `custom-chat-model-store` 的 v1→v3 声明迁移（档位随自建对话记录走，
 * spec 37 v4.0.0）。非迁移方不得消费；v2 文件读到的恒为空表。
 */
const listLegacyDeploymentThinkingTiers = (): ReadonlyMap<string, LegacyThinkingTiers> =>
  readLegacyFile()?.file.legacyThinkingTiers ?? new Map();

/**
 * 迁移专用：把指定 id 的接入从旧文件移除，返回实际移除条数。
 *
 * 唯一调用方是两个 store 的 v1→v3 声明迁移——它们把 v1 声明与其接入合成单记录后，必须把被并掉
 * 的那几条从旧文件摘掉，否则 `deployment-to-record-migration` 会把同一条接入再换算一次。
 * 文件不存在或无匹配时是零操作（不落盘空文件）。
 */
const removeLegacyDeploymentsByIds = (ids: readonly string[]): number => {
  const wanted = new Set(ids.map((id) => normalizeString(id)).filter((id) => id !== ''));
  if (wanted.size === 0) return 0;
  const snapshot = readLegacyFile();
  if (snapshot === null) return 0;
  const remaining = snapshot.file.deployments.filter((item) => !wanted.has(item.deployment_id));
  const removed = snapshot.file.deployments.length - remaining.length;
  if (removed === 0) return 0;
  const next: LegacyDeploymentFile = { ...snapshot.file, updatedAt: new Date().toISOString(), deployments: remaining };
  try {
    fs.writeFileSync(snapshot.filePath, JSON.stringify(next, null, 2), 'utf-8');
  } catch (error: unknown) {
    loggingModule.logWarn('[legacy-deployment-file] trim failed, file kept as-is', {
      filePath: snapshot.filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  return removed;
};

/**
 * 残留接管的处置：**归档后丢弃旧文件**（一次性、不可逆，2026-10-19 拍板）。
 *
 * 迁移只移除能逐值映射的条目（它们的 `model_id` / 所属服务商 / 远端模型名已原样进入用户记录，
 * 信息不丢）。搬不走的只有两类：
 * - **无族 model_id**（TTS / seedream / qwen / zimage 等）：升级前就没有可提交的协议族，
 *   从未进过可执行目录，也不构成产品模型（spec 03 §6.1「没有任何记录承载的 model_id 不构成
 *   产品模型」）。给它们编一个族等于凭空给用户添一个模型（§11 明确禁止）。
 * - **与用户已建记录同 `model_id` 的冲突条目**：换轨前用户自己建过同名模型，其信息（远端模型名、
 *   素材位、参数覆盖、record_id）已由用户记录承载，且「记录优先」是迁移的既定策略——
 *   用旧接入覆盖用户亲手填的记录才是真正的数据损失。
 *
 * 两类都不承载「只有旧文件里才有」的用户意图。但「可以丢」不等于「应当静默丢」：归档到
 * `config/archive/model-deployments.json`（带归档时间、原因与原条目）让被丢弃的内容事后可查、
 * 可人工抢救；随后把旧文件从 config 下移除——留一个永不读取的文件只会让后来者以为它还是
 * 事实源。
 *
 * 调用时机由调用方保证：**记录先落盘、再调本函数**。归档写失败时保留原文件（宁可留可读的
 * 残留，也不要在没有留存副本的情况下销毁数据），返回 0。幂等：文件不在即无操作。
 */
const retireLegacyDeploymentFile = (): number => {
  const snapshot = readLegacyFile();
  if (snapshot === null) return 0;
  const archivePath = path.join(path.dirname(snapshot.filePath), 'archive', 'model-deployments.json');
  try {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(
      archivePath,
      JSON.stringify(
        {
          archived_at: new Date().toISOString(),
          reason: 'model-deployment carrier retired (spec 03 §6.1 single carrier / PC-14)',
          source_file: path.basename(snapshot.filePath),
          version: snapshot.file.version,
          updatedAt: snapshot.file.updatedAt,
          deployments: snapshot.file.deployments,
        },
        null,
        2,
      ),
      'utf-8',
    );
    fs.rmSync(snapshot.filePath, { force: true });
  } catch (error: unknown) {
    loggingModule.logWarn('[legacy-deployment-file] retire failed, file kept as-is', {
      filePath: snapshot.filePath,
      archivePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  loggingModule.logInfo('[legacy-deployment-file] retired legacy deployment file', {
    archived: snapshot.file.deployments.length,
    archivePath,
    deploymentIds: snapshot.file.deployments.map((item) => item.deployment_id),
    modelIds: snapshot.file.deployments.map((item) => item.model_id),
  });
  return snapshot.file.deployments.length;
};

export {
  listLegacyDeployments,
  listLegacyDeploymentThinkingTiers,
  removeLegacyDeploymentsByIds,
  retireLegacyDeploymentFile,
};
