'use client';

import { useMemo } from 'react';
import type { AgentToolCallRecord } from '@iart/contracts';
import { cn } from '@/lib/utils';
import { cancelAgentToolCall } from '@/features/agent/agentSessionStore';
import { MediaBand, soloMediaCardStyle, useSessionMediaItems } from './AgentSessionMedia';
import { TOOL_STATUS_LABEL, TOOL_STATUS_TONE, isToolStatusGenerating, parseToolArgs, toolLabel } from './toolStatus';
import type { ToolCallActivityMessage, ToolResultActivityMessage } from './agentToolActivityModel';

/**
 * 工具条目卡（提案条目卡 / 结果条目卡）与 yolo 单条取消行。
 *
 * 从 `AgentSessionToolActivity` 拆出：条目卡既服务「条目卡组」（非相册形态的工具组），
 * 也被相册组复用——相册组里待审批的提案仍按条目卡渲染在相册之外（审批行动入口不藏进聚合）。
 *
 * 呈现契约（批次 C 去 folder 化）：**条目卡是唯一容器**（--card + 1px border + rounded-lg +
 * overflow-hidden），信息行（padding 10px 12px）+ 满幅媒体带；状态由行 1 状态词 + 生成中呼吸点
 * 表达，没有组级/条目级状态色条。
 */

/** 条目信息行的状态词（生成中档前带 6px 呼吸点）。 */
const EntryStatusWord = ({ status }: { status: AgentToolCallRecord['status'] }) => (
  <span
    className={cn('ml-auto inline-flex flex-none items-center text-[11px]', TOOL_STATUS_TONE[status])}
    data-testid="agent-tool-call-status"
  >
    {isToolStatusGenerating(status) ? (
      <i
        aria-hidden="true"
        className="agent-session-breathe mr-1 inline-block size-1.5 rounded-full bg-(--st-generating)"
      />
    ) : null}
    {TOOL_STATUS_LABEL[status]}
  </span>
);

/**
 * yolo 自动执行的短提示 + 单条取消（只在生成类条目、执行中、本轮在途时出现）。
 * `label` 由相册组改写为带调用序号的说法——相册里每个格不再自带卡头，取消必须指明是哪一次调用。
 */
export const ToolYoloCancelRow = ({
  onCancel,
  label = '已自动开始执行，可取消',
}: {
  onCancel: () => void;
  label?: string;
}) => (
  <div className="flex items-center gap-1.5" data-testid="agent-tool-yolo-cancel">
    <span className="text-[11px] text-muted-foreground">{label}</span>
    <button
      type="button"
      onClick={onCancel}
      className="inline-flex h-5 items-center rounded-sm border border-transparent px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-(--st-failed-text) hover:text-(--st-failed-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      取消
    </button>
  </div>
);

/** 工具调用条目卡：行 1（工具名 / 目标模型 / 状态 / yolo 取消）+ 行 2（prompt）+ 引用媒体带。 */
export const ToolCallEntryCard = ({
  message,
  status,
  inFlight,
  yoloMode,
}: {
  message: ToolCallActivityMessage;
  status: AgentToolCallRecord['status'];
  inFlight: boolean;
  yoloMode: boolean;
}) => {
  // 提案条目内容（spec 06：model_id、prompt、引用、状态）：等待确认态展示。
  const args = useMemo(
    () => (status === 'proposed' ? parseToolArgs(message.body.argsJson) : null),
    [status, message.body.argsJson],
  );
  const referenceIds = args?.referenceAssetIds ?? [];
  const mediaItems = useSessionMediaItems(referenceIds);
  // yolo 自动派发（spec 05「自动执行」）：生成类条目执行中给短提示 + 单条取消——取消命令
  // 携带该条目标识，只中止该条目（spec 04「单条取消」），不波及同轮其他条目与整轮。
  const isYoloAutoRun =
    yoloMode && message.body.toolKind === 'generation' && isToolStatusGenerating(status) && inFlight;

  return (
    <article
      className="flex flex-col overflow-hidden rounded-lg border bg-card"
      style={soloMediaCardStyle(mediaItems)}
      data-testid="agent-session-tool-call"
      data-tool-name={message.body.toolName}
      data-status={status}
    >
      <div className="flex flex-col gap-0.5 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-medium">{toolLabel(message.body.toolName)}</span>
          {message.body.modelId ? (
            <span className="truncate text-muted-foreground" title={message.body.modelId}>
              {message.body.modelId}
            </span>
          ) : null}
          <EntryStatusWord status={status} />
        </div>
        {args !== null && args.prompt !== null ? (
          <p
            className="truncate text-[12px] text-muted-foreground"
            title={args.prompt}
            data-testid="agent-tool-proposal-details"
          >
            {args.prompt}
          </p>
        ) : null}
        {isYoloAutoRun ? (
          <ToolYoloCancelRow
            onCancel={() => cancelAgentToolCall(message.agentSessionId, message.body.toolCallId)}
          />
        ) : null}
      </div>
      {mediaItems.length > 0 ? <MediaBand items={mediaItems} /> : null}
    </article>
  );
};

/** 工具结果条目卡：行 1（工具名 / 状态）+ 行 2（结果摘要 / 错误）+ 产物媒体带。 */
export const ToolResultEntryCard = ({
  message,
  status,
}: {
  message: ToolResultActivityMessage;
  status: AgentToolCallRecord['status'];
}) => {
  const assetIds = message.body.status === 'succeeded' ? message.body.assetIds : [];
  const mediaItems = useSessionMediaItems(assetIds);
  return (
    <article
      className="flex flex-col overflow-hidden rounded-lg border bg-card"
      style={soloMediaCardStyle(mediaItems)}
      data-testid="agent-session-tool-result"
      data-tool-name={message.body.toolName}
      data-status={status}
    >
      <div className="flex flex-col gap-0.5 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-medium">{toolLabel(message.body.toolName)}</span>
          <EntryStatusWord status={status} />
        </div>
        <p className="text-[12px] text-muted-foreground">{message.body.summary}</p>
        {message.body.errorSummary ? (
          <p className="text-[12px] text-(--st-failed-text)">{message.body.errorSummary}</p>
        ) : null}
      </div>
      {mediaItems.length > 0 ? <MediaBand items={mediaItems} /> : null}
    </article>
  );
};
