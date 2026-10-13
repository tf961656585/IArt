import type { AgentApprovalMode } from '@iart/contracts';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import type { DynamicPayload } from '@/client/api/clientTypes';
import type { PromptCollectionItem } from '@/features/canvas/types';

/**
 * PromptDock 创作面 Editor-local 类型（Todo 6）。
 *
 * PromptDockDraft 是未提交编辑态，不具运行域身份、不进 packages/contracts
 * （spec PromptDock生成主链.md「契约与投影边界」）。跨边界 DTO 只由 contracts 承载，
 * 本文件禁止复制其字段 schema。
 */

/** 参考区引用条目（Editor-local）。资产引用由 PromptDock 草稿承载，不建连线。 */
export type PromptDockReference = {
  /** 引用条目的稳定本地 id（用于去重与 React key） */
  refId: string;
  /** 画布已持久化媒体资产 id；缺失时不可用（前置校验阻断） */
  assetId: string;
  /** 媒体类型（image/video/audio），用于与模型能力判兼容性 */
  mediaType: 'image' | 'video' | 'audio';
  /** 加入时的资产显示标签（chip 与 hover 预览识别资产用；仅呈现，不参与提交） */
  label: string;
};

/**
 * PromptDock 创作形态（spec docs/agent/06-UI交互与PromptDock接入.md「两种形态」）。
 * `generate` = 生成式形态（默认，直接生成图片/视频/音频）；
 * `agent` = agent 形态（对话式创作，配置为模型/思考/审批）。
 * 互斥单值：同一时刻只有一个形态；只经创作条上的常驻切换器改变。
 */
export type PromptDockForm = 'generate' | 'agent';

/**
 * agent 形态的审批档位（spec docs/agent/05-审批规则.md：会话级、两档，界面不暴露 confirm/yolo 字面量）。
 * 取值集合的事实源是 contracts 的 `AgentApprovalMode`（会话记录与 WS 提交共用同一枚举），
 * 本端只做命名别名，不另立并列集合（AGENTS.md「共享契约与事实源」）。
 */
export type PromptDockApproval = AgentApprovalMode;

/**
 * agent 形态的形态配置（spec 06「两种形态」：模型 + 思考 + 审批）。
 *
 * 与生成式草稿分开存放，因此两个形态各记各的选择、切换形态互不覆盖（spec 06「形态切换入口」）。
 * `thinkingTier` 用 `off` 表示不思考（恒定可用），其余取值必须来自所选模型目录条目的 `thinking_tiers`。
 */
export type PromptDockAgentSelection = {
  /** 已选对话模型 model_id（直显，不翻译）；null = 未选择 */
  modelId: string | null;
  /** 思考档位标识；`off` = 不思考 */
  thinkingTier: string;
  approval: PromptDockApproval;
};

/** 不思考档位标识（spec 37「思考档位」：恒定可用、不参与声明）。 */
export const PROMPT_DOCK_THINKING_OFF = 'off';

export const EMPTY_PROMPT_DOCK_AGENT_SELECTION: PromptDockAgentSelection = {
  modelId: null,
  thinkingTier: PROMPT_DOCK_THINKING_OFF,
  approval: 'confirm',
};

/**
 * agent 形态的会话绑定（spec docs/agent/02「选中态工具栏」的「使用 agent」）。
 *
 * 绑定后 PromptDock 提交追加到该 `agentSessionId`（不再创建新 Agent 节点），
 * 输入面显示该会话摘要 +「新会话」；「新会话」只解绑，不改形态（spec 06「形态切换入口」）。
 */
export type PromptDockAgentBinding = {
  nodeId: string;
  agentSessionId: string;
};

/**
 * 待还原的进入前状态（spec docs/agent/06「选中驱动的进入—还原—粘滞」）。
 *
 * 选中驱动进入（普通单击选中持有会话引用的 Agent 容器节点、或其成员节点）时记录
 * 「形态 + 绑定」，该会话尚未发出过消息（未粘滞）时，选中集离开该容器的**作用域**
 * （容器自身与其成员之外）即按此快照恢复；消息被受理后成为「当前会话」，
 * 快照清除、选择变化不再还原。
 */
export type PromptDockAgentEntrySnapshot = {
  /** 本次选中驱动进入的 Agent 容器节点（由成员点击进入时也是容器，不是被点的成员）；
   *  选中集离开该容器作用域即还原 */
  nodeId: string;
  /** 本次绑定的会话（向它发出的消息被受理后粘滞） */
  agentSessionId: string;
  /** 进入前的形态 */
  form: PromptDockForm;
  /** 进入前的绑定（null = 未绑定） */
  binding: PromptDockAgentBinding | null;
};

/** PromptDock 未提交草稿。 */
export type PromptDockDraft = {
  /** 已选 model_id（直显，不翻译）；null = 未选择 */
  modelId: string | null;
  /** 所选模型的模型能力与参数投影版本（capability version） */
  modelVersion: string | null;
  /** prompt 文本 */
  prompt: string;
  /** 当前有效模型参数（参数承载分层：inline + Sheet 的唯一下层事实源；开放结构沿用 DynamicPayload 命名） */
  arguments: DynamicPayload;
  /** 参考区引用（顺序即用户可见顺序） */
  references: PromptDockReference[];
  /**
   * prompt 文本中 `[[pp:<presetId>]]` 预设 token 的插入时快照（id → 预设）。
   * 快照随 token 生命周期：删 token 即清快照；提交前由 Editor 展开为正文，
   * 后端不认识预设 token 形态（spec docs/editor/prompt内联交互.md）。
   * 无 token 时为 undefined。
   */
  promptPresetSnapshots: Record<string, PromptCollectionItem> | undefined;
  /** 固定任务数 N（1..10） */
  taskCount: number;
};

/** 前置校验失败定位反馈（spec 节点执行前置校验.md：不提交 + 定位 + 覆盖全部）。 */
export type PromptDockPreflightIssue = {
  code:
    | 'required-input-missing'
    | 'reference-unavailable'
    | 'required-param-missing'
    | 'deployment-not-executable'
    | 'incompatible-reference'
    | 'preset-token-invalid';
  /** 用户可读原因，已定位到问题输入 */
  message: string;
  /** 问题字段（参数 fieldKey、引用 assetId 或失效预设 presetId） */
  field: string | null;
  /**
   * 该问题的修复出口。'hub-providers' = 修复入口在主窗口的「设置 → 服务商与模型」，
   * 界面据此渲染跨窗口跳转动作；null = 修复在 Editor 现场完成，不渲染跨窗口动作
   * （docs/hub/首次指引-design.md §4.4）。
   */
  exit: 'hub-providers' | null;
};

/** 提交受理前的一次完整校验结果。 */
export type PromptDockPreflightResult =
  | { ok: true }
  | { ok: false; issues: PromptDockPreflightIssue[] };

export type { PromptDockCatalogEntry };
