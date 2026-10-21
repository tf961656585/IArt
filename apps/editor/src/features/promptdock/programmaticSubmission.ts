import type {
  CliError,
  CliGenerateAcceptance,
  CliGenerateArgEntry,
  CliGenerateParams,
  CliGenerateTaskIdentity,
  ExecutableCatalogParameterField,
  ProjectMediaAssets,
} from '@iart/contracts';
import type { TaskSubmitMediaInput } from '@iart/contracts/task-submit-media-input';
import type { MentionMapEntry } from '@iart/contracts/task-submit-request';
import type { DynamicPayload } from '@/client/api/clientTypes';
import { submitGenerationBatch } from '@/client/api/promptDockApi';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { PromptCollectionItem } from '@/features/canvas/types';
import { runPromptDockPreflight } from './promptDockPreflight';
import { resolvePromptDockSubmitPrompt } from './promptDockPrompt';
import { usePromptDockStore } from './promptDockStore';
import type { PromptDockDraft, PromptDockPreflightIssue, PromptDockReference } from './PromptDock.types';

/**
 * 程序化提交共享核心（spec docs/integrations/CLI与本地Agent集成.md §6.4 程序化提交、§5.4、
 * §10「提交传输层失败」、§13 禁止项；验收 CLI-008/CLI-007）。
 *
 * 职责裁定（消重复而非平行入口）：把 PromptDock handleSubmit 生成式分支的
 * 「前置校验 → 构造提交请求 → 提交受理 → 受理回执处理（任务节点创建与落位）」抽成本模块的
 * 共享核心 `runGenerationBatchSubmission`；handleSubmit 重构为「读草稿/表单 → 准备 intent →
 * 调共享核心 → UI 副作用」；CLI 纯入口 `submitGenerationBatchFromIntent` 是共享核心的 CLI
 * 形态包装（错误码映射 + 参数类型收敛）。不存在与界面提交平行的第二份提交编排
 * （spec §13「禁止把 CLI 生成提交实现为第二生成入口」）。
 *
 * 硬禁令（spec §6.4/§13）：本模块不读写创作面输入草稿（对 usePromptDockStore 只读 catalog、
 * 永不写入 draft/form/submitting/preflightIssues）、不切换创作面形态、不触发任何创作面 UI
 * 状态（setSubmitting/setPreflightIssues/toast/agent 副作用一律不碰）。任务节点创建与落位
 * 与界面提交完全同一函数（createTaskProjectionsForAcceptance）；CLI 路径经
 * `selectCreatedNodes: false` 不做选中反馈（用户可能正在选别的对象）——「与界面一致」指投影
 * 与落位语义，非 UI 反馈。
 *
 * 校验失败映射（CLI 侧，spec §6.4 定位到问题输入 / §9 错误码）：
 * - 引用资产不存在/不可用/与模型不兼容 → `invalid_reference`；
 * - 模型不在可执行目录或不可执行 → `model_not_available`；
 * - 必填参数缺失 / 参数取值不满足模型 schema / 提示词与引用俱缺 / 预设引用未知 →
 *   `command_rejected` 且 message 定位到具体参数名或素材标识。
 * 提交传输层失败原样上抛（不重试，spec §5.4），由调用方映射为错误响应。
 */

/** 程序化提交意图：程序化提交核心的入参（对齐 CLI 契约 generate 参数的 Editor 侧形态）。 */
export type ProgrammaticSubmitIntent = {
  /** 目标模型标识；null = 未指定（前置校验按「模型不可用」阻断） */
  modelId: string | null;
  /**
   * 提示词原文。UI 路径传草稿原文（可含 `[[pp:<id>]]` 预设 token，随 `promptPresetSnapshots`
   * 展开与失效阻断）；CLI 路径传 `--prompt` 原文（无预设快照概念，token 视为未知引用被阻断——
   * token 形态是 Editor 保留语法，不把字面量发给后端）。
   */
  prompt: string;
  /** 模型参数空间（UI 为类型化表单值；CLI 为 k=v 收敛后的参数记录） */
  args: DynamicPayload;
  /** 引用资产标识（顺序即引用顺序；重复标识按一个引用处理，与参考区去重同语义） */
  refAssetIds: readonly string[];
  /** 固定任务数（1..10，与提交契约一致） */
  count: number;
  /**
   * 提示词预设 token 快照（UI 草稿携带；CLI 恒为 undefined）。快照随 intent 传递是因为
   * 前置校验要按它阻断失效 token、提交前要按它展开正文——两者都属共享核心的「校验→构造」段。
   */
  promptPresetSnapshots: Record<string, PromptCollectionItem> | undefined;
  /**
   * 客户端受理幂等键（spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键）。
   * CLI 提交携带（CLI 客户端未传时自动生成 uuid）；界面提交恒为 undefined（不携带）。
   * 同一幂等键重复提交命中既有批次时后端幂等重放（响应 replayed: true），本模块跳过
   * 任务节点投影创建（投影的创建触发事实是「全新受理」的重放回执不成立，重复创建会在
   * 画布产生重复任务节点）。
   */
  clientRequestId: string | undefined;
  /**
   * 出生组组名（spec CLI-043，CLI `--group`）：提交前置校验阶段按名称解析目标节点组——
   * 唯一同名组入它、零个受理成功后自动建组、≥2 个同名以 group_name_ambiguous 拒绝
   * （不发起提交）。界面提交不携带（缺省 undefined）。
   */
  groupName?: string | undefined;
};

/** 共享核心的失败分类（UI 与 CLI 各自映射反馈形态；transport 失败原样抛出不在此收敛）。 */
export type GenerationSubmissionFailure =
  | {
      kind: 'preflight';
      /** 前置校验问题（定位到问题输入），与界面提交同一覆盖面 */
      issues: PromptDockPreflightIssue[];
      /** 校验时所用的目录条目（UI 按它解析参数界面标签）；null = 模型不在目录 */
      entry: PromptDockCatalogEntry | null;
    }
  | {
      kind: 'project-not-ready';
      /** 项目上下文缺失（运行域项目路径不可得）的用户视角说明 */
      message: string;
    }
  | {
      kind: 'projection-failed';
      /** 任务节点投影创建失败的用户视角原因（受理已成立，画布可见性未达成） */
      reason: string;
    }
  | {
      kind: 'group-name-ambiguous';
      /** 触发歧义的出生组组名 */
      groupName: string;
      /** 同名节点组的节点标识清单（≥2 项） */
      groupIds: string[];
    };

export type GenerationSubmissionOutcome =
  | {
      ok: true;
      /** 受理批次标识 */
      batchId: string;
      /** 受理的任务身份（task_id + task_index + 画布投影身份 node_id/group_id，CLI-046） */
      tasks: CliGenerateTaskIdentity[];
      /** 幂等重放标志（spec §5.4 受理幂等键）：true = 命中既有批次，未重新受理、未创建投影。 */
      replayed: boolean;
    }
  | { ok: false; failure: GenerationSubmissionFailure };

// ---------------------------------------------------------------------------
// 构造辅助（自 PromptDock.tsx 下沉：引用条目 → 提交媒体输入 / mention 映射，单一实现两路复用）
// ---------------------------------------------------------------------------

/**
 * 引用条目 → 提交媒体输入（attachment + asset_id 形态，后端物化层解析资产内容）。
 * 解析不到 URL 的引用跳过（与既有口径一致，媒体物化细节以 contracts TaskSubmitMediaInputSchema 为准）。
 */
const buildReferenceMediaInputs = (
  references: readonly PromptDockReference[],
  mediaAssets: ProjectMediaAssets,
  entry: PromptDockCatalogEntry | null = null,
): TaskSubmitMediaInput[] => {
  const mediaInputs: TaskSubmitMediaInput[] = [];
  for (const ref of references) {
    const asset = mediaAssets[ref.assetId] as
      | { original?: { url?: unknown; mimeType?: unknown } }
      | undefined;
    const url = typeof asset?.original?.url === 'string' ? asset.original.url : '';
    if (!url) continue;
    // 用途 → 该素材位的参数字段键，作为显式绑定随媒体条目下发（§5.2）。
    // 不带绑定时，多素材位模型在后端会被明确拒绝（不会静默塞错位）。
    const refSlotId = ref.slotId ?? null;
    const slot =
      refSlotId === null
        ? undefined
        : entry?.media_slots?.find((candidate) => candidate.slotId === refSlotId);
    mediaInputs.push({
      media_kind: ref.mediaType,
      source_kind: 'attachment',
      value: url,
      mime_type: typeof asset?.original?.mimeType === 'string' ? asset.original.mimeType : null,
      filename: null,
      ...(slot === undefined ? {} : { field_key: slot.fieldKey }),
    });
  }
  return mediaInputs;
};

/**
 * 引用条目 → prompt 内联 @ 引用的 mention 映射（MVP 按参考区顺序映射，index 0-based；
 * 完整 @ 锚点语义归 docs/editor/prompt内联交互.md，后续在此接入）。
 */
const buildMentionMap = (
  references: readonly PromptDockReference[],
): Record<string, MentionMapEntry> | undefined => {
  const byKind: Record<'image' | 'video' | 'audio', MentionMapEntry[]> = {
    image: [],
    video: [],
    audio: [],
  };
  for (const ref of references) {
    const bucket = byKind[ref.mediaType];
    bucket.push({ media_kind: ref.mediaType, index: bucket.length });
  }
  const entries: Record<string, MentionMapEntry> = {};
  for (const kind of ['image', 'video', 'audio'] as const) {
    if (byKind[kind].length > 0) {
      entries[kind] = byKind[kind][0] as MentionMapEntry;
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
};

/**
 * 引用资产 id → 参考条目。媒体类型从画布媒体资产注册表读取——界面引用 chip 的媒体类型与
 * 注册表同源（referenceOps 准入判定从同一注册表解析），程序化提交只有资产 id，统一从事实源
 * 投影。注册表查不到的引用保留条目（mediaType 兜底 image），由前置校验「引用资产不可用」
 * 阻断；兜底类型只影响同轮多问题的文案数量，不影响阻断本身。
 */
const resolveReferencesFromAssetIds = (
  refAssetIds: readonly string[],
  mediaAssets: ProjectMediaAssets,
): PromptDockReference[] => {
  const references: PromptDockReference[] = [];
  const seen = new Set<string>();
  for (const assetId of refAssetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    references.push({
      refId: assetId,
      assetId,
      mediaType: mediaAssets[assetId]?.mediaType ?? 'image',
      label: '',
    });
  }
  return references;
};

// ---------------------------------------------------------------------------
// 共享核心：校验 → 构造 → 提交 → 受理回执处理
// ---------------------------------------------------------------------------

/**
 * 执行一次程序化生成提交（界面提交与 CLI 提交的共同主链）。
 *
 * 内部链：前置校验（runPromptDockPreflight，输入由 intent + store 现值构造，不读创作面草稿）
 * → 构造提交请求（模型目录从 promptDockStore 读，模型版本取目录条目现值）→ submitGenerationBatch
 * → createTaskProjectionsForAcceptance（任务节点创建与落位与界面提交同一函数）。
 *
 * 失败语义：前置校验/项目上下文/投影创建失败以 discriminated outcome 返回；提交传输层失败
 * （含响应契约 parse 失败）原样抛出，由调用方按各自形态处置（界面固定出口文案 / CLI 映射
 * internal_error），不重试（spec §5.4）。
 *
 * @param options.selectCreatedNodes 受理后是否选中新任务节点（界面提交的第一时间用户反馈）；
 *   程序化提交传 false——不改画布选中态，用户可能正在选别的对象（spec §6.4 草稿与界面状态
 *   不触碰口径的画布侧延伸）。
 */
export const runGenerationBatchSubmission = async (
  intent: ProgrammaticSubmitIntent,
  options: { selectCreatedNodes?: boolean | undefined } = {},
): Promise<GenerationSubmissionOutcome> => {
  const mediaAssets = useCanvasStore.getState().mediaAssets;
  // 模型目录从 store 读（不经 UI props）：与界面同一数据源，模型版本取目录条目现值。
  const entry =
    intent.modelId === null
      ? null
      : (usePromptDockStore.getState().catalog.find((item) => item.model_id === intent.modelId) ??
        null);
  const references = resolveReferencesFromAssetIds(intent.refAssetIds, mediaAssets);

  // 前置校验与界面提交同一函数同一覆盖面（spec §6.4「同一的前置校验」）；
  // 校验输入是 intent 的投影（草稿形状），不读写创作面草稿本身。
  const preflightDraft: PromptDockDraft = {
    modelId: intent.modelId,
    modelVersion: entry?.model_version ?? null,
    prompt: intent.prompt,
    arguments: intent.args,
    references,
    promptPresetSnapshots: intent.promptPresetSnapshots,
    taskCount: intent.count,
  };
  const preflight = runPromptDockPreflight(preflightDraft, entry, mediaAssets, 'generate');
  if (!preflight.ok) {
    return { ok: false, failure: { kind: 'preflight', issues: preflight.issues, entry } };
  }
  // 前置校验通过蕴含模型在目录内（entry 非空是生成式校验通过的前提）；此分支是类型收窄
  // 兜底（校验实现被破坏时按同一 preflight 问题形状返回，不让 null 流入请求构造）。
  if (entry === null) {
    return {
      ok: false,
      failure: {
        kind: 'preflight',
        issues: [
          {
            code: 'deployment-not-executable',
            message: '请选择可用的模型后再提交。',
            field: null,
            exit: null,
          },
        ],
        entry,
      },
    };
  }

  const projectPath = getRuntimeProjectPath();
  if (projectPath === null) {
    return {
      ok: false,
      failure: { kind: 'project-not-ready', message: '这个项目还没有在画布中打开，请先在应用中打开项目后再试。' },
    };
  }

  // 出生组解析（spec CLI-043，前置校验阶段拦截）：唯一同名节点组入它、零个受理成功后自动建组、
  // ≥2 个同名以 group_name_ambiguous 拒绝——不提交注定失败的提交（画布零改动、不发起 backend
  // 提交）。组名匹配只作用于节点组（type=group），Agent 容器不参与。
  let birthGroupId: string | null = null;
  let autoCreateBirthGroup = false;
  if (intent.groupName !== undefined) {
    const { resolveBirthGroupIdByName } = await import('./projection/taskProjectionService');
    const resolution = resolveBirthGroupIdByName(intent.groupName);
    if (resolution.kind === 'ambiguous') {
      return {
        ok: false,
        failure: { kind: 'group-name-ambiguous', groupName: intent.groupName, groupIds: resolution.groupIds },
      };
    }
    if (resolution.kind === 'unique') {
      birthGroupId = resolution.groupId;
    } else {
      autoCreateBirthGroup = true;
    }
  }

  // 提交正文：预设 token 展开为正文（spec「提交契约边界」）；失效 token 已被前置校验阻断，
  // 此处展开不会走 missing:'throw' 兜底。
  const submitPrompt = resolvePromptDockSubmitPrompt(preflightDraft);
  const mediaInputs = buildReferenceMediaInputs(references, mediaAssets, entry);
  const mentionMap = buildMentionMap(references);
  const response = await submitGenerationBatch({
    model_id: entry.model_id,
    model_version: entry.model_version,
    prompt: submitPrompt,
    arguments: intent.args,
    media_inputs: mediaInputs.length > 0 ? mediaInputs : undefined,
    reference_asset_ids: references.map((reference) => reference.assetId),
    task_count: intent.count,
    project_path: projectPath,
    mention_map: mentionMap,
    ...(intent.clientRequestId !== undefined ? { client_request_id: intent.clientRequestId } : {}),
  });

  // 幂等重放（spec §5.4 受理幂等键）：命中既有批次时任务身份为既有受理结果——投影的创建
  // 触发事实是「全新受理」，重放回执不再触发投影创建（重复创建会在画布产生重复任务节点；
  // 既有投影由画布既有恢复/通知机制持有）。留 debug 痕说明跳过。
  // 画布投影身份（CLI-046）按 task_id 从画布现值关联既有投影（含 --group 重放：不重复建组，
  // group_id 取节点当前归属）；投影缺失输出 null，缺省不伪造。
  if (response.replayed === true) {
    console.debug('[programmaticSubmission] idempotent replay hit, skip task projection creation', {
      batchId: response.batch_id,
      clientRequestId: intent.clientRequestId,
    });
    const { resolveTaskCanvasIdentities } = await import('./projection/taskProjectionService');
    const identities = resolveTaskCanvasIdentities(response.tasks.map((task) => task.task_id));
    return {
      ok: true,
      batchId: response.batch_id,
      tasks: response.tasks.map((task) => ({
        ...task,
        node_id: identities.get(task.task_id)?.node_id ?? null,
        group_id: identities.get(task.task_id)?.group_id ?? null,
      })),
      replayed: true,
    };
  }

  // 出生组自动建组（CLI-043 零匹配分支）：受理成功后、投影创建前——提交传输层失败不留垃圾
  // 空组（此时才建组）；建组失败按 projection-failed 处置（受理已成立，画布可见性未达成）。
  if (autoCreateBirthGroup && intent.groupName !== undefined) {
    const { createBirthGroup } = await import('./projection/taskProjectionService');
    const created = createBirthGroup(intent.groupName);
    if (created === null) {
      return {
        ok: false,
        failure: {
          kind: 'projection-failed',
          reason: `生成已受理，但未能创建出生组「${intent.groupName}」，请重新打开项目查看任务。`,
        },
      };
    }
    birthGroupId = created;
  }

  // 受理回执是任务节点投影的唯一创建触发事实（spec 固定任务数批次提交与投影语义）；
  // 与界面提交同一函数，不另建补投影旁路。
  const { createTaskProjectionsForAcceptance, resolveTaskCanvasIdentities } = await import(
    './projection/taskProjectionService'
  );
  const createResult = createTaskProjectionsForAcceptance({
    nodeGraphId: useCanvasStore.getState().nodeGraph?.id,
    response,
    modelId: entry.model_id,
    referenceAssetIds: references.map((reference) => reference.assetId),
    selectCreatedNodes: options.selectCreatedNodes,
    ...(birthGroupId !== null ? { birthGroupId } : {}),
  });
  if (!createResult.ok) {
    return { ok: false, failure: { kind: 'projection-failed', reason: createResult.reason } };
  }
  // 画布投影身份回填（CLI-046）：投影创建后按 task_id 从画布现值解析 node_id/group_id，
  // 受理回执与终态输出同源（投影缺失输出 null，缺省不伪造）。
  const identities = resolveTaskCanvasIdentities(response.tasks.map((task) => task.task_id));
  return {
    ok: true,
    batchId: response.batch_id,
    tasks: response.tasks.map((task) => ({
      ...task,
      node_id: identities.get(task.task_id)?.node_id ?? null,
      group_id: identities.get(task.task_id)?.group_id ?? null,
    })),
    replayed: false,
  };
};

// ---------------------------------------------------------------------------
// CLI 纯入口：共享核心的 CLI 形态包装（错误码映射 + k=v 参数类型收敛）
// ---------------------------------------------------------------------------

/** CLI 程序化提交结果：受理结果与 B 命令面 generate 响应的受理部分同形状（CliGenerateAcceptance）。 */
export type CliProgrammaticSubmitOutcome =
  | { ok: true; acceptance: CliGenerateAcceptance }
  | { ok: false; error: CliError };

/**
 * CLI generate 命令参数 → 程序化提交意图（count 缺省 1；`wait` 的轮询归本地控制服务侧，
 * 不进画布窗口执行的意图；`group` 出生组组名透传，spec CLI-043）。
 */
export const buildProgrammaticIntentFromCliParams = (
  params: CliGenerateParams,
): ProgrammaticSubmitIntent => ({
  modelId: params.model,
  prompt: params.prompt,
  args: argsRecordFromCliEntries(params.arg ?? []),
  refAssetIds: params.ref ?? [],
  count: params.count ?? 1,
  promptPresetSnapshots: undefined,
  clientRequestId: params.client_request_id,
  groupName: params.group,
});

/** CLI `--arg k=v` 条目 → 参数记录：同名键后者覆盖（重复键留 debug 痕，条件跳过必须留痕）。 */
const argsRecordFromCliEntries = (entries: readonly CliGenerateArgEntry[]): DynamicPayload => {
  const args: DynamicPayload = {};
  for (const entry of entries) {
    if (entry.key in args) {
      console.debug('[programmaticSubmission] duplicate generate arg key; last value wins', {
        key: entry.key,
      });
    }
    args[entry.key] = entry.value;
  }
  return args;
};

/**
 * CLI k=v 字符串取值按模型参数 schema 收敛类型（spec §5.4「参数名与取值受该模型参数 schema
 * 约束，类型或必填缺失在前置校验中报定位错误」）。UI 表单产出的参数已是类型化值，不经此收敛。
 * 组件族判定与参数控件（PromptDockParamField）同源：switch/toggle → 布尔；number → 数值；
 * 带枚举选项的字段必须命中枚举值；其余（text、imagesize 等）按文本原样透传——imagesize 的
 * 档位值域由 componentProps 派生呈现承载，不在此复制值域事实，执行链仍有模型 schema 兜底。
 */
const coerceCliArgValue = (
  field: ExecutableCatalogParameterField,
  rawValue: string,
): { ok: true; value: unknown } | { ok: false; reason: string } => {
  const component = field.component.toLowerCase();
  if (component === 'switch' || component === 'toggle') {
    if (rawValue === 'true') return { ok: true, value: true };
    if (rawValue === 'false') return { ok: true, value: false };
    return { ok: false, reason: '取值需要是 true 或 false' };
  }
  if (component === 'number') {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0 || !Number.isFinite(Number(trimmed))) {
      return { ok: false, reason: '取值需要是数值' };
    }
    return { ok: true, value: Number(trimmed) };
  }
  const options = field.enumOptions ?? [];
  if (options.length > 0) {
    if (!options.some((option) => String(option.value) === rawValue)) {
      return {
        ok: false,
        reason: `取值需要是其中之一：${options.map((option) => String(option.value)).join('、')}`,
      };
    }
    return { ok: true, value: rawValue };
  }
  return { ok: true, value: rawValue };
};

/**
 * 前置校验问题 → CLI 错误（spec §9 错误码 + §6.4 定位到问题输入）。取第一条问题：
 * preflight 按校验项顺序产出，首条即最靠前的问题输入；message 使用用户视角业务语言，
 * 可点名 CLI 参数名 / 素材标识 / 模型标识（这些是 CLI 使用者的输入词汇，非内部实现术语）。
 */
const mapPreflightIssueToCliError = (
  issue: PromptDockPreflightIssue,
  entry: PromptDockCatalogEntry | null,
  modelId: string | null,
): CliError => {
  const field = issue.field ?? '未知';
  switch (issue.code) {
    case 'reference-unavailable':
      return {
        code: 'invalid_reference',
        message: `引用的素材 ${field} 不存在或已被删除；如需引用本地文件，需先在画布中导入它（CLI 不提供导入），再用 asset list 查询素材标识后重试。`,
      };
    case 'incompatible-reference':
      return {
        code: 'invalid_reference',
        message: `引用的素材 ${field} 与该模型不兼容，该模型不支持这类素材输入，请调整引用后重试。`,
      };
    case 'deployment-not-executable':
      if (entry === null) {
        return {
          code: 'model_not_available',
          message: `模型 ${modelId ?? field} 不在可用模型目录里，请先在应用中添加并启用该模型。`,
        };
      }
      return {
        code: 'model_not_available',
        message: `模型 ${modelId ?? field} 当前不可执行：${issue.message}`,
      };
    case 'required-param-missing':
      return {
        code: 'command_rejected',
        message: `缺少必填参数 ${field}，该模型要求提供后才能提交。`,
      };
    case 'required-input-missing':
      return {
        code: 'command_rejected',
        message: '提示词为空且没有引用素材，无法提交生成。请提供提示词或引用素材。',
      };
    case 'preset-token-invalid':
      return {
        code: 'command_rejected',
        message: `提示词包含未知的预设引用（${field}），请直接给出提示词正文。`,
      };
    case 'slot-required-empty':
      // CLI 没有用途语法（用途是素材属性，只能在画布侧表达），因此这里不复述可修复动作，
      // 只说明缺什么、并指向界面上能补的位置。
      return {
        code: 'command_rejected',
        message: `该模型要求「${field}」有一张图，但当前没有图被指定到这个位置。请在画布创作区为该图选择用途后重试。`,
      };
    case 'slot-unspecified':
      return {
        code: 'command_rejected',
        message: '有参考图还没有指定用途。请在画布创作区为每张图选择用途后重试。',
      };
  }
};

/**
 * CLI 程序化提交纯入口：给定生成意图，走与界面提交完全同一的共享核心
 * （前置校验 → 提交受理 → 受理回执创建任务节点并落位），并把失败收敛为 CLI 错误码。
 *
 * 与界面提交的差异只有两点（spec §6.4 允许且仅限于此）：
 * - 不做任务节点选中反馈（selectCreatedNodes: false）；
 * - 失败以 `{ code, message }` 错误返回（定位到问题输入），不触发任何创作面 UI 状态。
 *
 * 提交传输层失败原样映射为 internal_error（附诊断线索），不重试（spec §5.4/§10）。
 */
export const submitGenerationBatchFromIntent = async (
  intent: ProgrammaticSubmitIntent,
): Promise<CliProgrammaticSubmitOutcome> => {
  // 任务数与提交契约同界（1..10）：在这里定位拒绝，不让契约 parse 的 ZodError 冒充内部错误。
  if (!Number.isInteger(intent.count) || intent.count < 1 || intent.count > 10) {
    return {
      ok: false,
      error: {
        code: 'command_rejected',
        message: `生成任务数必须是 1 到 10 之间的整数，收到 ${intent.count}。`,
      },
    };
  }

  const entry =
    intent.modelId === null
      ? null
      : (usePromptDockStore.getState().catalog.find((item) => item.model_id === intent.modelId) ??
        null);
  // CLI k=v 取值类型收敛（schema 外参数不在 Editor 侧校验范围，交由执行链既有校验兜底）。
  let args: DynamicPayload = intent.args;
  if (entry !== null) {
    const typedArgs: DynamicPayload = { ...intent.args };
    let rejected: CliError | null = null;
    for (const [key, rawValue] of Object.entries(intent.args)) {
      if (typeof rawValue !== 'string') continue;
      const field = entry.parameter_schema.fields.find((candidate) => candidate.fieldKey === key);
      if (!field) continue;
      const coerced = coerceCliArgValue(field, rawValue);
      if (!coerced.ok) {
        rejected = {
          code: 'command_rejected',
          message: `参数 ${key} 的取值不合法：${coerced.reason}。`,
        };
        break;
      }
      typedArgs[key] = coerced.value;
    }
    if (rejected !== null) return { ok: false, error: rejected };
    args = typedArgs;
  }

  try {
    const outcome = await runGenerationBatchSubmission(
      { ...intent, args },
      { selectCreatedNodes: false },
    );
    if (outcome.ok) {
      return {
        ok: true,
        acceptance: {
          batch_id: outcome.batchId,
          tasks: outcome.tasks,
          ...(intent.clientRequestId !== undefined ? { client_request_id: intent.clientRequestId } : {}),
          ...(outcome.replayed ? { replayed: true } : { replayed: false }),
        },
      };
    }
    switch (outcome.failure.kind) {
      case 'preflight': {
        const firstIssue = outcome.failure.issues[0];
        if (!firstIssue) {
          // 防御分支：preflight 失败至少携带一条问题；空集说明校验实现被破坏，按内部错误处置。
          return {
            ok: false,
            error: { code: 'internal_error', message: '命令执行出现内部错误，请稍后重试。' },
          };
        }
        return {
          ok: false,
          error: mapPreflightIssueToCliError(firstIssue, outcome.failure.entry, intent.modelId),
        };
      }
      case 'project-not-ready':
        return { ok: false, error: { code: 'project_not_open', message: outcome.failure.message } };
      case 'group-name-ambiguous':
        return {
          ok: false,
          error: {
            code: 'group_name_ambiguous',
            message: `画布上有 ${outcome.failure.groupIds.length} 个同名节点组「${outcome.failure.groupName}」，无法确定生成任务要放进哪个组。请改用唯一的组名，或先用 canvas group list 核对现有组后再提交。`,
          },
        };
      case 'projection-failed':
        return { ok: false, error: { code: 'internal_error', message: outcome.failure.reason } };
    }
  } catch (error) {
    // 提交传输层失败原样映射为错误响应，不重试（spec §5.4）；诊断线索随 message 携带。
    const detail = error instanceof Error ? error.message : String(error);
    console.debug('[programmaticSubmission] generate submit transport failure', { detail });
    return {
      ok: false,
      error: { code: 'internal_error', message: `生成提交失败，应用侧出现意外错误。技术细节：${detail}` },
    };
  }
};
