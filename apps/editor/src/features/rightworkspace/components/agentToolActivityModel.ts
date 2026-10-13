/**
 * 工具活动组的结构模型（纯函数：不触 DOM、不读 store、无 JSX）。
 *
 * 三块共享事实：
 * - 工具条目消息的形状 / 分组键 / 条目状态：会话流分组（`buildViewEntries`）、工具活动组与
 *   相册组同源消费，避免各自复制一份判断。
 * - 「连续生成相册」聚合模型（spec docs/agent/02「会话视图与多轮历史」2026-09-21 裁决）：
 *   一次调用 = 一次 tool_call（prompt + 参考图）+ 其 tool_result（产物 + 终态）配对；
 *   相册格（已就绪产物格 + 生成中 / 失败状态格）、组头双计数、distinct prompt 诚实判定都在
 *   这里算好，组件只负责呈现。聚合键仍是工具名（连续同名序列由 `buildViewEntries` 折出），
 *   本模块只判「这组是否走相册形态」，不重写分组逻辑。
 * - 会话成功产物的取数口径（`successfulProductAssetIds`）：会话视图的产物呈现按它取数
 *   （spec docs/agent/02「节点身份与数据」），不另立一套计数。Agent 节点折叠态徽章按容器
 *   成员数计数（画布容器口径），不消费本口径。
 */

import type { AgentMessageRecord, AgentToolCallRecord } from '@iart/contracts';
import type { AgentToolCallLive } from '@/features/agent/agentSessionState';
import { isToolStatusGenerating, parseToolArgs } from './toolStatus';

/**
 * 工具活动组只承载这两类消息体（其余消息体走 AgentSessionMessage）。
 * 按消息体判别字段拆成 discriminated union：消费侧用 `message.body.kind` 收窄即可拿到
 * 具名消息类型，不写断言。
 */
type ToolCallBody = Extract<AgentMessageRecord['body'], { kind: 'tool_call' }>;
type ToolResultBody = Extract<AgentMessageRecord['body'], { kind: 'tool_result' }>;

/** 工具调用提案条目（相册组里被排除在聚合之外的那部分仍按提案卡呈现）。 */
export type ToolCallActivityMessage = Omit<AgentMessageRecord, 'body'> & { body: ToolCallBody };

/** 工具调用终态条目。 */
export type ToolResultActivityMessage = Omit<AgentMessageRecord, 'body'> & { body: ToolResultBody };

export type ToolActivityMessage = ToolCallActivityMessage | ToolResultActivityMessage;

/**
 * 消息体判别（用户定义类型守卫，不用断言）：嵌套判别字段收窄的是 `message.body`，
 * 收窄不到父对象；需要按条目整体区分时一律走这两个守卫。
 */
export const isToolCallMessage = (
  message: ToolActivityMessage,
): message is ToolCallActivityMessage => message.body.kind === 'tool_call';

/** 该消息体是否属于工具活动组。 */
export const isToolActivityMessage = (
  message: AgentMessageRecord,
): message is ToolActivityMessage =>
  message.body.kind === 'tool_call' || message.body.kind === 'tool_result';

/**
 * 会话的成功产物 assetId（去重，按首次出现顺序）。
 *
 * 产物只由结果消息承载：**已结算成功**的 `tool_result` 才带 assetIds（失败 / 取消 / 未执行
 * 与尚在生成中的调用都没有产物）。同一产物在多轮结果里重复出现只算一份——计数与呈现都要
 * 「这份产物在不在」，不是「被生成过几次」。
 *
 * 这是会话侧产物计数的唯一口径：会话视图的产物呈现只认这些 assetIds。Agent 节点折叠态
 * 徽章按容器成员数计数（spec docs/agent/02·AG-NP-005），不消费本口径。
 */
export const successfulProductAssetIds = (
  messages: readonly AgentMessageRecord[],
): string[] => {
  const seen = new Set<string>();
  const assetIds: string[] = [];
  for (const message of messages) {
    if (message.body.kind !== 'tool_result') continue;
    if (message.body.status !== 'succeeded') continue;
    for (const assetId of message.body.assetIds) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      assetIds.push(assetId);
    }
  }
  return assetIds;
};

/** 组的分组键：工具名文案（连续同名工具聚合成一组，工具切换即切开）。 */
export const toolActivityGroupKey = (message: ToolActivityMessage): string =>
  message.body.toolName;

/** 条目状态：结果消息按自身结算态；调用消息取活跃态，活跃态缺失（重开项目未回放）按历史渲染。 */
export const entryStatus = (
  message: ToolActivityMessage,
  live: AgentToolCallLive | null,
): AgentToolCallRecord['status'] =>
  message.body.kind === 'tool_result' ? message.body.status : live?.status ?? 'proposed';

/** 条目 + 解析后的状态（组头摘要与相册模型共用，避免各自重复解析活跃态）。 */
export type ToolActivityEntry = {
  message: ToolActivityMessage;
  status: AgentToolCallRecord['status'];
};

/**
 * 相册形态适用的工具集：**图片生成工具**。spec 裁决的聚合對象是「连续同名图片生成工具的
 * 调用序列」，其他工具（视频生成、图片加工类）保持条目卡形态——本裁决只解决图片生成
 * 逐卡堆叠的高度问题，不扩大聚合范围。
 */
const ALBUM_TOOL_NAMES: ReadonlySet<string> = new Set(['generate_image']);

/** 该组是否走相册形态（组内可无进相册的调用，此时由上层回落条目卡组）。 */
export const isAlbumToolGroup = (entries: readonly ToolActivityMessage[]): boolean => {
  const first = entries[0];
  return first !== undefined && ALBUM_TOOL_NAMES.has(toolActivityGroupKey(first));
};

/** 相册的一次调用（归属原子）：prompt / 参考图 / 产物 / 终态都挂在它上面。 */
export type AlbumCall = {
  toolCallId: string;
  /** 所属会话（yolo 单条取消按既有 agent:cancel 通道发出，需要会话标识）。 */
  agentSessionId: string;
  /** 调用序号（1 起，按调用次序）：组头「N 次调用」与格信息条「第 X 次调用」用它。 */
  ordinal: number;
  /** 该次调用的提示词（参数解析不出时为 null，不臆造）。 */
  prompt: string | null;
  /** 该次调用的输入引用（参考图）。 */
  referenceAssetIds: readonly string[];
  status: AgentToolCallRecord['status'];
  /** 已就绪产物（结果消息的 assetIds，按序）；未结算或非成功为空。 */
  assetIds: readonly string[];
  /** 失败 / 未执行的说明（错误详情层呈现）；成功调用为 null。 */
  reason: string | null;
};

/** 已就绪产物格：1:1 cover 缩略，同一次调用的多格天然相邻。 */
export type AlbumImageCell = {
  kind: 'image';
  /** 稳定列表键（调用 id + 图序） */
  key: string;
  call: AlbumCall;
  assetId: string;
  /** 图序（1 起）与该次调用的产物总数 */
  indexInCall: number;
  countInCall: number;
  /** 预览翻页序列下标（序列 = 组内已就绪产物按调用序）。 */
  previewIndex: number;
};

/** 状态格：生成中 / 失败 / 未执行（已取消、未勾选）的占位格，不进预览翻页序列。 */
export type AlbumStateCell = {
  kind: 'state';
  key: string;
  call: AlbumCall;
  state: 'generating' | 'failed' | 'inactive';
};

export type AlbumCell = AlbumImageCell | AlbumStateCell;

/** 相册组模型（组件只呈现，不重算）。 */
export type AlbumModel = {
  /** 组内工具名（组头标题取用户可读工具名）。 */
  toolName: string;
  /** 进相册的调用（待审批不在内）。 */
  calls: readonly AlbumCall[];
  /** 相册格：已就绪产物格（按调用序）+ 状态占位格。 */
  cells: readonly AlbumCell[];
  /** 预览翻页序列（= 已就绪产物格按调用序）。 */
  previewPages: readonly AlbumImageCell[];
  /** 待审批条目：不进相册（行动入口必须立即可点），按提案卡形态渲染在相册组之外。 */
  pendingCalls: readonly ToolCallActivityMessage[];
  /** 组头双计数 */
  callCount: number;
  /** M = 相册格数（已就绪产物 + 生成中 / 失败 / 未执行占位格） */
  imageCount: number;
  generatingCalls: number;
  failedCalls: number;
  /** 诚实判定：全组不同 prompt 数（字符串精确比较；解析不出 prompt 的调用自成一值）。 */
  distinctPrompts: number;
  /** distinct = 1 时的整组摘要；≥ 2 或解析不出时为 null（宁沉默不误导）。 */
  singlePrompt: string | null;
  /** N=1 例外：全组仅 1 张已就绪产物且无状态格 → 真实比例独立带（1:1 裁切会毁掉竖图构图）。 */
  soloCell: AlbumImageCell | null;
};

type CallDraft = {
  toolCallId: string;
  agentSessionId: string;
  ordinal: number;
  prompt: string | null;
  referenceAssetIds: string[];
  status: AgentToolCallRecord['status'];
  assetIds: string[];
  reason: string | null;
};

/** 非成功调用的占位格档：生成中（呼吸点）/ 失败（可点开错误详情）/ 未执行（已取消、未勾选）。 */
const stateCellOf = (status: AgentToolCallRecord['status']): AlbumStateCell['state'] => {
  if (isToolStatusGenerating(status)) return 'generating';
  return status === 'failed' ? 'failed' : 'inactive';
};

/**
 * 组内条目 → 相册模型。
 *
 * 配对规则：tool_result 归属同 toolCallId 的调用；调用消息缺失（结果先到 / 未落库）时结果
 * 自成一次调用（prompt 记 null，不臆造）。待审批（proposed 且**没有对应结果**）的调用消息
 * 不进相册，原样交回上层按提案卡渲染——审批行动入口不得被聚合藏起来。
 *
 * 判定顺序要紧：先按结果消息配对，再看状态。调用消息在没有活跃态时按历史回落成 proposed
 * （`entryStatus` 的重开项目口径），若先看状态就会把「已有结果的历史调用」误判成待审批。
 */
export const buildAlbumModel = (entries: readonly ToolActivityEntry[]): AlbumModel => {
  const drafts: CallDraft[] = [];
  const draftIndexByToolCallId = new Map<string, number>();
  const pendingCalls: ToolCallActivityMessage[] = [];
  const settledToolCallIds = new Set(
    entries.flatMap(({ message }) => (isToolCallMessage(message) ? [] : [message.body.toolCallId])),
  );

  const addDraft = (params: {
    toolCallId: string;
    agentSessionId: string;
    status: AgentToolCallRecord['status'];
    prompt: string | null;
    referenceAssetIds: readonly string[];
    assetIds?: readonly string[];
    reason?: string | null;
  }): void => {
    const draft: CallDraft = {
      toolCallId: params.toolCallId,
      agentSessionId: params.agentSessionId,
      ordinal: drafts.length + 1,
      prompt: params.prompt,
      referenceAssetIds: [...params.referenceAssetIds],
      status: params.status,
      assetIds: [...(params.assetIds ?? [])],
      reason: params.reason ?? null,
    };
    draftIndexByToolCallId.set(draft.toolCallId, drafts.length);
    drafts.push(draft);
  };

  for (const { message, status } of entries) {
    if (isToolCallMessage(message)) {
      if (status === 'proposed' && !settledToolCallIds.has(message.body.toolCallId)) {
        pendingCalls.push(message);
        continue;
      }
      const args = parseToolArgs(message.body.argsJson);
      addDraft({
        toolCallId: message.body.toolCallId,
        agentSessionId: message.agentSessionId,
        status,
        prompt: args.prompt,
        referenceAssetIds: args.referenceAssetIds,
      });
      continue;
    }
    const assetIds = status === 'succeeded' ? message.body.assetIds : [];
    const reason = status === 'succeeded' ? null : message.body.errorSummary ?? message.body.summary;
    const draftIndex = draftIndexByToolCallId.get(message.body.toolCallId);
    const draft = draftIndex === undefined ? undefined : drafts[draftIndex];
    if (draft === undefined) {
      addDraft({
        toolCallId: message.body.toolCallId,
        agentSessionId: message.agentSessionId,
        status,
        prompt: null,
        referenceAssetIds: [],
        assetIds,
        reason,
      });
      continue;
    }
    draft.status = status;
    draft.assetIds = [...assetIds];
    draft.reason = reason;
  }

  const calls: AlbumCall[] = drafts.map((draft) => ({
    toolCallId: draft.toolCallId,
    agentSessionId: draft.agentSessionId,
    ordinal: draft.ordinal,
    prompt: draft.prompt,
    referenceAssetIds: [...draft.referenceAssetIds],
    status: draft.status,
    assetIds: [...draft.assetIds],
    reason: draft.reason,
  }));

  const cells: AlbumCell[] = [];
  const previewPages: AlbumImageCell[] = [];
  for (const call of calls) {
    if (call.status === 'succeeded' && call.assetIds.length > 0) {
      call.assetIds.forEach((assetId, index) => {
        const cell: AlbumImageCell = {
          kind: 'image',
          key: `${call.toolCallId}:${String(index)}`,
          call,
          assetId,
          indexInCall: index + 1,
          countInCall: call.assetIds.length,
          previewIndex: previewPages.length,
        };
        previewPages.push(cell);
        cells.push(cell);
      });
      continue;
    }
    // 结算成功但没有产物：没有可呈现的格（不造空占位格）。
    if (call.status === 'succeeded') continue;
    cells.push({ kind: 'state', key: `${call.toolCallId}:state`, call, state: stateCellOf(call.status) });
  }

  const distinctPrompts = new Set(calls.map((call) => call.prompt)).size;
  const firstCell = cells[0];

  return {
    toolName: entries[0]?.message.body.toolName ?? '',
    calls,
    cells,
    previewPages,
    pendingCalls,
    callCount: calls.length,
    imageCount: cells.length,
    generatingCalls: calls.filter((call) => isToolStatusGenerating(call.status)).length,
    failedCalls: calls.filter((call) => call.status === 'failed').length,
    distinctPrompts,
    singlePrompt: distinctPrompts === 1 ? calls[0]?.prompt ?? null : null,
    soloCell:
      cells.length === 1 && firstCell !== undefined && firstCell.kind === 'image'
        ? firstCell
        : null,
  };
};
