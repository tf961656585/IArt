import { create } from 'zustand';

import type { PromptDockCatalogEntry, PromptDockChatCatalogEntry } from '@/client/api/promptDockApi';
import type {
  PromptDockAgentBinding,
  PromptDockAgentEntrySnapshot,
  PromptDockAgentSelection,
  PromptDockDraft,
  PromptDockForm,
} from './PromptDock.types';
import { EMPTY_PROMPT_DOCK_AGENT_SELECTION, PROMPT_DOCK_THINKING_OFF } from './PromptDock.types';

/**
 * PromptDock 创作面 Editor-local store（Todo 6）。
 *
 * 只承载未提交草稿与可执行目录投影缓存；运行域任务/资产投影归 canvasStore（任务/资产节点）。
 * 提交受理后的草稿语义按形态拆分（spec PromptDock生成主链.md PD-AC-012/013）：
 * 生成式受理后原样保留，store 不提供生成式提交后的清空/重置路径；
 * agent 形态按对话语义「受理成功即消费」，唯一清空入口是 clearConsumedAgentDraft。
 * 每次提交的快照冻结发生在运行域 batch 侧，与草稿编辑生命周期无关。
 */

export const EMPTY_PROMPT_DOCK_DRAFT: PromptDockDraft = {
  modelId: null,
  modelVersion: null,
  prompt: '',
  arguments: {},
  references: [],
  promptPresetSnapshots: undefined,
  taskCount: 1,
};

/** 默认预选模型（spec PromptDock生成主链.md PD-AC-010；原型 promptdock-core.js 同口径）。 */
export const PROMPT_DOCK_DEFAULT_MODEL_ID = 'gpt-image-2';

/**
 * 生成式草稿的默认预选（PD-AC-010 + 本机配置的生成默认模型），按优先级取第一个可用者：
 * 配置的默认模型 → 内置首选 gpt-image-2 → 目录首个模型。
 *
 * `defaultModelId` 是本机配置里的偏好（主窗口「服务商」区域设置），不做存在性校验：
 * 它不在可执行目录里（被移除、或接入不可用）时按「没设默认」处理，继续走内置首选——
 * 目录是「现在能用什么」的事实源，配置只是偏好，缺一个不该阻断创作面。
 * 仅是初始值，不构成自动补选/fallback——所选模型不可执行时仍按阻断规则处理。
 * 返回 null 表示目录为空（无任何可预选模型）。
 */
export const resolveDefaultDraft = (
  catalog: PromptDockCatalogEntry[],
  defaultModelId: string | null,
): Pick<PromptDockDraft, 'modelId' | 'modelVersion' | 'arguments'> | null => {
  const configured = defaultModelId === null
    ? null
    : catalog.find((candidate) => candidate.model_id === defaultModelId) ?? null;
  // 目录为空（还没装载）时留痕无意义：此刻「不在目录里」是必然，不代表配置有问题。
  if (defaultModelId !== null && configured === null && catalog.length > 0) {
    console.debug('[promptDock] 生成默认模型不在可执行目录里，按没设默认处理', { defaultModelId });
  }
  const entry =
    configured ??
    catalog.find((candidate) => candidate.model_id === PROMPT_DOCK_DEFAULT_MODEL_ID) ??
    catalog[0] ??
    null;
  if (!entry) return null;
  return {
    modelId: entry.model_id,
    modelVersion: entry.model_version,
    arguments:
      entry.parameter_schema.default_values &&
      Object.keys(entry.parameter_schema.default_values).length > 0
        ? { ...entry.parameter_schema.default_values }
        : {},
  };
};

type PromptDockState = {
  /**
   * 当前创作形态（spec docs/agent/06「形态切换入口」）。默认生成式；
   * 形态只经创作条上的常驻切换器改变，切换保留未提交草稿。
   */
  form: PromptDockForm;
  draft: PromptDockDraft;
  catalog: PromptDockCatalogEntry[];
  catalogLoaded: boolean;
  /**
   * 生成形态的默认模型（本机配置 `generationDefaultModelId`，主窗口「服务商」区域设置）。
   * 草稿还没被用户显式选过模型时用它预选；null = 没设默认，回落到内置首选。
   */
  generationDefaultModelId: string | null;
  /**
   * 用户是否在当前生成式草稿里**显式选过**模型。
   *
   * 生成侧与 agent 侧的守卫不能同构：agent 侧「没设默认就不预选」，所以 `modelId !== null`
   * 足以表示「用户选过」；生成侧未设默认时也要回落内置首选（PD-AC-010），
   * 自动预选本身就会把 `draft.modelId` 填成非空——拿它当守卫会把「目录先到、配置后到」时
   * 的配置默认静默吞掉（预选值看起来像用户的选择）。所以单独记一个标记：
   * 只有显式路径（模型下拉、复用/重试回填）置真，自动预选永不置真、也永不覆盖它。
   */
  generationModelChosen: boolean;
  /**
   * agent 形态的形态配置（spec 06「两种形态」）：模型 / 思考 / 审批。
   * 与生成式 draft 分开存放，两个形态各记各的选择。
   */
  agentSelection: PromptDockAgentSelection;
  /** 对话模型目录（含每个模型可选思考档位与默认档位）；agent 形态服务行的候选来源 */
  chatCatalog: PromptDockChatCatalogEntry[];
  chatCatalogLoaded: boolean;
  /**
   * Agent 形态的默认模型（本机配置 `agentDefaultModelId`，主窗口设置）。
   * 创作面进入 agent 形态且还没选过模型时用它预选；null = 没设默认。
   */
  agentDefaultModelId: string | null;
  /**
   * 用户在当前表单里**显式改过**思考档位。
   *
   * 它只影响换模型时要不要套用新模型的默认档位：改过就尊重用户的选择，没改过就套用默认。
   * 没有这个标记时，`off`（表单初值）与「用户明确选了不思考」无法区分，
   * 于是只有两种坏结果——默认档位永远不生效，或用户明确选的不思考被换模型时顶掉。
   */
  agentThinkingTierChosen: boolean;
  /**
   * 当前绑定的 Agent 会话（spec 02「使用 agent」）。绑定后提交追加到该会话，
   * 输入面显示会话摘要 +「新会话」；形态切到生成式不解除绑定（spec 06）。
   * null = 未绑定，下一次提交创建新 Agent 节点。
   */
  agentBinding: PromptDockAgentBinding | null;
  /**
   * 待还原的进入前状态（spec 06「选中驱动的进入—还原—粘滞」）。
   * null = 没有待还原状态：要么没经选中驱动进入，要么已粘滞/被显式动作清除。
   */
  agentEntrySnapshot: PromptDockAgentEntrySnapshot | null;
  /**
   * 进入会话后的聚焦请求令牌（每次真正进入自增）。
   *
   * 计数而非布尔：连续进入同一会话也要再聚焦一次；输入面订阅它，
   * 等表面 DOM 重建落定（宏任务）后把焦点交给消息输入框。
   */
  agentEntryFocusToken: number;
  submitting: boolean;
  /**
   * 每条阻断反馈带 `exit`：'hub-providers' = 修复入口在主窗口的「设置 → 服务商与模型」，
   * 界面据此渲染跨窗口跳转动作；null = 修复在 Editor 现场完成，不渲染跳转动作
   * （docs/hub/首次指引-design.md §4.4）。
   */
  preflightIssues: { code: string; message: string; exit: 'hub-providers' | null }[] | null;

  /**
   * 生成式草稿补丁。补丁里带 `modelId`（模型下拉换模型）即视为「用户显式选过模型」，
   * 置真 `generationModelChosen`，此后默认预选不得覆盖（见该字段注释）。
   */
  setDraft: (patch: Partial<PromptDockDraft>) => void;
  /**
   * agent 形态「受理成功即消费」（spec PromptDock生成主链.md PD-AC-013）：
   * 清空 prompt、参考引用与提示词预设快照，输入面回到下一条消息的空态；
   * 模型/参数/任务数等配置不属于「这段消息」，不在消费范围内。
   * 清空只挂 agent 提交受理成功这一个时机：受理失败或提交被阻断时不得调用本动作
   * （草稿与参考逐项保留），也禁止前置到提交点击。
   */
  clearConsumedAgentDraft: () => void;
  /**
   * 切换创作形态（spec 06「形态切换入口」）：只改形态并清掉上一形态的阻断反馈，
   * 草稿（prompt / 参考 / 模型选择）与会话绑定原样保留，不静默丢弃用户输入。
   * 常驻切换控件是显式动作，清掉待还原快照（spec 06「显式动作清快照」）。
   */
  setForm: (form: PromptDockForm) => void;
  /**
   * 复用资产生成来源回填草稿：model_id/prompt/参数/参考/任务数（不回填连接/凭证/部署/快照）。
   * 显式动作：回填的是该资产当时的模型身份（可能为空），此后默认预选不得再替用户换模型。
   */
  replaceDraft: (draft: PromptDockDraft) => void;
  /** 写入可执行目录并尝试默认预选（用户未显式选过模型时才写；见 resolveDefaultDraft） */
  setCatalog: (catalog: PromptDockCatalogEntry[]) => void;
  setCatalogLoaded: (loaded: boolean) => void;
  /**
   * 写入生成形态的默认模型（配置读到时调用；目录未到时也能先记下，两边各试一次初始化）。
   * null = 取消默认，回落内置首选。
   */
  setGenerationDefaultModelId: (modelId: string | null) => void;
  /**
   * agent 形态的形态配置补丁（模型 / 思考 / 审批）。
   * 换模型时思考档位不跟随：由调用方按新模型的可选档位决定是否回落（见 setAgentSelection 注释）。
   */
  setAgentSelection: (patch: Partial<PromptDockAgentSelection>) => void;
  /** 用户显式选定思考档位（与批量补丁分开：只有这条会标记「用户改过」，见 agentThinkingTierChosen） */
  setAgentThinkingTier: (thinkingTier: string) => void;
  /**
   * 选择 agent 形态的模型。换模型时的思考档位：
   * 没改过思考 → 用新模型的默认档位；改过且该档位对新模型可用 → 保留用户的选择；
   * 改过但不可用 → 用新模型的默认档位，没有默认才回落到「不思考」——不替用户挑一个他没表达过的档位。
   */
  selectAgentModel: (modelId: string) => void;
  setChatCatalog: (catalog: PromptDockChatCatalogEntry[]) => void;
  setChatCatalogLoaded: (loaded: boolean) => void;
  /** 写入 Agent 默认模型（配置读到时调用；目录未到时也能先记下，两边各试一次初始化） */
  setAgentDefaultModelId: (modelId: string | null) => void;
  /** 绑定 Agent 会话（只绑会话，不改形态；形态切换由 enterAgentFormForNode 负责） */
  bindAgentSession: (binding: PromptDockAgentBinding) => void;
  /** 解绑（「新会话」）：不改形态、不清草稿；此后提交创建新的 Agent 节点 */
  unbindAgentSession: () => void;
  /**
   * 清掉待还原快照（显式形态/绑定变更时调用：切换控件、「新会话」、节点删除）。
   * 进入动作自身的写入由 `enterAgentFormForSelection` / `enterAgentFormForNode` 负责。
   */
  clearAgentEntrySnapshot: () => void;
  /**
   * 恢复进入前的形态与绑定（spec 06「还原」）：无快照时返回 false（调用方按「无待还原」处置）。
   * 只动形态与绑定，草稿与参考原样保留。
   */
  restoreAgentEntrySnapshot: (reason: string) => boolean;
  /**
   * 该会话成为「当前会话」（粘滞，spec 06）：清除待还原快照，此后选择变化不再还原。
   * 唯一调用时机是消息**被受理**——受理失败/被阻断时不调用，否则误粘滞会让用户回不去。
   */
  markAgentSessionCurrent: (agentSessionId: string) => void;
  /** 删除节点带走的待还原快照清理（被删节点就是快照的进入目标时清掉） */
  clearAgentEntrySnapshotForNodes: (nodeIds: readonly string[]) => void;
  setSubmitting: (submitting: boolean) => void;
  setPreflightIssues: (issues: { code: string; message: string; exit: 'hub-providers' | null }[] | null) => void;
};


/**
 * 换模型后该用哪个思考档位（spec 37「思考档位」）。
 *
 * - 用户没改过思考档位 → 用新模型的默认档位（主窗口在接入上声明的那个）；
 * - 改过且该档位对新模型可用 → 保留（含用户明确选的「不思考」）；
 * - 改过但不可用 → 用新模型的默认档位；没有默认才回落「不思考」。
 */
function resolveAgentTierOnModelChange(
  state: Pick<PromptDockState, 'chatCatalog' | 'agentSelection' | 'agentThinkingTierChosen'>,
  modelId: string,
): { thinkingTier: string; thinkingTierChosen: boolean } {
  const entry = state.chatCatalog.find((item) => item.model_id === modelId) ?? null;
  const fallback = entry?.default_thinking_tier ?? PROMPT_DOCK_THINKING_OFF;
  const current = state.agentSelection.thinkingTier;
  const usable = current === PROMPT_DOCK_THINKING_OFF || (entry?.thinking_tiers.includes(current) ?? false);
  if (state.agentThinkingTierChosen && usable) {
    return { thinkingTier: current, thinkingTierChosen: true };
  }
  // 没改过、或改过的档位对新模型不可用：按新模型的默认档位初始化，并回到「用户未表态」——
  // 这个值是替用户挑的（默认档位或「不思考」），不该在下次换模型时被当成他的选择保留下来。
  return { thinkingTier: fallback, thinkingTierChosen: false };
}

/**
 * 目录与默认模型到齐后预选默认模型（spec docs/agent/06「agent 形态的输入面」）。
 *
 * 顺序无关：目录与配置是两条独立请求，谁后到谁负责再试一次，所以这里读的都是当时的完整状态。
 * 已经选过模型则不动（用户的选择优先）；配置里的模型不在目录里（被移除、或接入不可用）时
 * 不预选也不报错——目录是「现在能用什么」的事实源，配置只是偏好，缺一个不该阻断创作面。
 */
function applyAgentDefault(
  state: PromptDockState,
  catalog: PromptDockChatCatalogEntry[],
  defaultModelId: string | null,
): Partial<PromptDockState> {
  if (state.agentSelection.modelId !== null) return {};
  if (defaultModelId === null) return {};
  const entry = catalog.find((item) => item.model_id === defaultModelId) ?? null;
  if (entry === null) {
    console.debug('[promptDock] Agent 默认模型不在对话模型目录里，本次不预选', { defaultModelId });
    return {};
  }
  return {
    agentSelection: {
      ...state.agentSelection,
      modelId: entry.model_id,
      thinkingTier: entry.default_thinking_tier ?? PROMPT_DOCK_THINKING_OFF,
    },
  };
}

/**
 * 生成式草稿的默认预选（PD-AC-010 + 本机配置的生成默认模型）。
 *
 * 与 `applyAgentDefault` 同构的只有「顺序无关」：目录与配置是两条独立请求，
 * 谁后到谁负责再试一次，所以这里读的都是当时的完整状态。
 * 守卫不同构——agent 侧没设默认就不预选，生成侧未设置要回落内置首选，
 * 于是自动预选会把 `draft.modelId` 填成非空；拿 `draft.modelId !== null` 当「用户选过」，
 * 会让「目录先到、配置后到」时配置被静默吞掉。所以只看 `generationModelChosen`。
 */
function applyGenerationDefault(
  state: PromptDockState,
  catalog: PromptDockCatalogEntry[],
  defaultModelId: string | null,
): Partial<PromptDockState> {
  if (state.generationModelChosen) return {};
  const defaults = resolveDefaultDraft(catalog, defaultModelId);
  if (defaults === null) return {};
  // 已经预选着同一个模型：不动。参数可能已被用户改过（改参数不换模型，不置显式选择标记），
  // 重写一遍会把他的参数编辑抹回默认值——只有真的换模型才重置模型专属参数。
  if (state.draft.modelId === defaults.modelId) return {};
  return { draft: { ...state.draft, ...defaults } };
}

export const usePromptDockStore = create<PromptDockState>()((set) => ({
  form: 'generate',
  draft: { ...EMPTY_PROMPT_DOCK_DRAFT, references: [] },
  catalog: [],
  catalogLoaded: false,
  generationDefaultModelId: null,
  generationModelChosen: false,
  agentSelection: { ...EMPTY_PROMPT_DOCK_AGENT_SELECTION },
  chatCatalog: [],
  chatCatalogLoaded: false,
  agentDefaultModelId: null,
  agentThinkingTierChosen: false,
  agentBinding: null,
  agentEntrySnapshot: null,
  agentEntryFocusToken: 0,
  submitting: false,
  preflightIssues: null,

  setDraft: (patch) =>
    set((state) => ({
      draft: { ...state.draft, ...patch },
      // 补丁带 modelId = 用户显式换过模型（下拉是唯一入口）；自动预选走 applyGenerationDefault，不经这里。
      generationModelChosen: patch.modelId !== undefined ? true : state.generationModelChosen,
    })),
  clearConsumedAgentDraft: () =>
    set((state) => ({
      draft: {
        ...state.draft,
        prompt: '',
        references: [],
        promptPresetSnapshots: undefined,
      },
    })),
  // 常驻切换控件是显式动作：清掉待还原快照（spec 06「显式动作清快照」）。
  setForm: (form) => set({ form, preflightIssues: null, agentEntrySnapshot: null }),
  replaceDraft: (draft) =>
    set(() => ({
      draft: { ...draft, references: [...draft.references] },
      // 复用/重试回填是显式动作：它带的是该资产当时的模型身份（可能为空），
      // 回填之后不该再由默认预选替用户换一个别的模型。
      generationModelChosen: true,
    })),
  // 目录到达时写入默认预选：用户已显式选过模型则不覆盖（守卫见 applyGenerationDefault）。
  setCatalog: (catalog) =>
    set((state) => ({
      catalog,
      ...applyGenerationDefault(state, catalog, state.generationDefaultModelId),
    })),
  setCatalogLoaded: (loaded) => set({ catalogLoaded: loaded }),
  setGenerationDefaultModelId: (modelId) =>
    set((state) => ({
      generationDefaultModelId: modelId,
      ...applyGenerationDefault(state, state.catalog, modelId),
    })),
  setAgentSelection: (patch) =>
    set((state) => ({ agentSelection: { ...state.agentSelection, ...patch } })),
  setAgentThinkingTier: (thinkingTier) =>
    set((state) => ({
      agentSelection: { ...state.agentSelection, thinkingTier },
      agentThinkingTierChosen: true,
    })),
  // 换模型时的档位规则见 `resolveAgentTierOnModelChange`：默认档位只在校用它时生效，
  // 用户改过的选择在不冲突时原样保留（spec 37：不替用户挑他没表达过的档位）。
  selectAgentModel: (modelId) =>
    set((state) => {
      const resolved = resolveAgentTierOnModelChange(state, modelId);
      return {
        agentSelection: { ...state.agentSelection, modelId, thinkingTier: resolved.thinkingTier },
        agentThinkingTierChosen: resolved.thinkingTierChosen,
      };
    }),
  setChatCatalog: (catalog) =>
    set((state) => ({ chatCatalog: catalog, ...applyAgentDefault(state, catalog, state.agentDefaultModelId) })),
  setChatCatalogLoaded: (loaded) => set({ chatCatalogLoaded: loaded }),
  setAgentDefaultModelId: (modelId) =>
    set((state) => ({ agentDefaultModelId: modelId, ...applyAgentDefault(state, state.chatCatalog, modelId) })),
  // 显式绑定变更（首次提交受理写回绑定）：形态切到 agent 并绑定既有/新会话，清掉待还原快照。
  bindAgentSession: (binding) =>
    set(() => ({
      agentBinding: { ...binding },
      agentEntrySnapshot: null,
      preflightIssues: null,
    })),
  // 「新会话」是显式解绑动作：清掉待还原快照（spec 06「显式动作清快照」）。
  unbindAgentSession: () =>
    set({ agentBinding: null, agentEntrySnapshot: null, preflightIssues: null }),
  clearAgentEntrySnapshot: () => set({ agentEntrySnapshot: null }),
  restoreAgentEntrySnapshot: (reason) => {
    const snapshot = usePromptDockStore.getState().agentEntrySnapshot;
    if (snapshot === null) return false;
    // 还原只回形态与绑定：草稿、参考、输入内容一律不动（spec 06「还原不丢弃任何 draft」）。
    set({
      form: snapshot.form,
      agentBinding: snapshot.binding === null ? null : { ...snapshot.binding },
      agentEntrySnapshot: null,
      preflightIssues: null,
    });
    console.debug('[promptDock] agent entry snapshot restored', {
      reason,
      form: snapshot.form,
      nodeId: snapshot.nodeId,
    });
    return true;
  },
  markAgentSessionCurrent: (agentSessionId) =>
    set((state) => {
      const snapshot = state.agentEntrySnapshot;
      if (snapshot === null || snapshot.agentSessionId !== agentSessionId) return {};
      // 受理即粘滞：这条消息已经落到该会话，还原快照会把用户从正在进行的对话里拽回去。
      console.debug('[promptDock] agent session sticky: entry snapshot cleared', {
        agentSessionId,
        nodeId: snapshot.nodeId,
      });
      return { agentEntrySnapshot: null };
    }),
  clearAgentEntrySnapshotForNodes: (nodeIds) =>
    set((state) => {
      const snapshot = state.agentEntrySnapshot;
      if (snapshot === null) return {};
      if (!nodeIds.includes(snapshot.nodeId)) return {};
      // 条件跳过留痕：删除带走了进入目标，快照不再可还原。
      console.debug('[promptDock] agent entry snapshot cleared: entry node removed', {
        nodeId: snapshot.nodeId,
      });
      return { agentEntrySnapshot: null };
    }),
  setSubmitting: (submitting) => set({ submitting }),
  setPreflightIssues: (issues) => set({ preflightIssues: issues }),
}));

/**
 * 进入某 Agent 节点的会话（spec docs/agent/06「形态切换入口」）。
 *
 * 调用方两条，语义差异只在快照：
 * - `enterAgentFormForSelection`（选中驱动）：记录进入前的「形态 + 绑定」快照，未粘滞时离开即还原；
 * - `enterAgentFormForNode`（「使用 agent」幂等兜底）：显式动作，清掉待还原快照。
 *
 * 已处于该会话时两者都早返回（幂等）：不重置会话视图、不重置快照、不重复请求聚焦。
 */
function applyAgentEntry(params: {
  nodeId: string;
  agentSessionId: string;
  recordSnapshot: boolean;
}): boolean {
  const { nodeId, agentSessionId, recordSnapshot } = params;
  const state = usePromptDockStore.getState();
  if (
    state.form === 'agent' &&
    state.agentBinding !== null &&
    state.agentBinding.nodeId === nodeId &&
    state.agentBinding.agentSessionId === agentSessionId
  ) {
    // 幂等：已是该会话。选中驱动路径下「点击当前已绑定节点」走这里——
    // 不重置快照、不重置会话视图滚动位置、不重复聚焦。
    return true;
  }
  const snapshot: PromptDockAgentEntrySnapshot | null = recordSnapshot
    ? {
        nodeId,
        agentSessionId,
        form: state.form,
        binding: state.agentBinding === null ? null : { ...state.agentBinding },
      }
    : null;
  usePromptDockStore.setState({
    form: 'agent',
    agentBinding: { nodeId, agentSessionId },
    agentEntrySnapshot: snapshot,
    preflightIssues: null,
    agentEntryFocusToken: state.agentEntryFocusToken + 1,
  });
  return true;
}

/**
 * 选中驱动进入（spec 06「选中驱动的进入—还原—粘滞」）：普通单击选中单个持有会话引用的
 * Agent 节点时调用。进入语义与「使用 agent」一致，差别只在记录待还原快照。
 *
 * 标识不全时跳过并留痕（调用方已按节点收窄，这里是防御）。
 */
export function enterAgentFormForSelection(nodeId: string, agentSessionId: string): boolean {
  if (!nodeId || !agentSessionId) {
    console.debug('[promptDock] selection entry skipped: incomplete identity', {
      hasNodeId: Boolean(nodeId),
      hasAgentSessionId: Boolean(agentSessionId),
    });
    return false;
  }
  return applyAgentEntry({ nodeId, agentSessionId, recordSnapshot: true });
}

/**
 * 显式进入该 Agent 节点的会话（Agent 节点选中态工具栏「使用 agent」，spec docs/agent/02）。
 *
 * 直接进入，不弹 draft 去向确认框（2026-09-20 裁撤）：draft 按形态独立保存，
 * 进入 agent 形态不覆盖生成式草稿，返回生成式形态时原样恢复。
 * 显式动作清掉待还原快照；已处于该会话时为幂等操作。
 */
export function enterAgentFormForNode(nodeId: string, agentSessionId: string): boolean {
  if (!nodeId || !agentSessionId) {
    console.debug('[promptDock] enter agent form skipped: incomplete identity', {
      hasNodeId: Boolean(nodeId),
      hasAgentSessionId: Boolean(agentSessionId),
    });
    return false;
  }
  return applyAgentEntry({ nodeId, agentSessionId, recordSnapshot: false });
}

/** 只读选择：当前已选 model_id 的目录条目（O(1) 由外部 Map 传入时使用）。 */
export const selectPromptDockDraft = (): PromptDockDraft =>
  usePromptDockStore.getState().draft;
