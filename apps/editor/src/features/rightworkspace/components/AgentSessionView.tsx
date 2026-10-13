'use client';

import { Fragment, useEffect, useMemo, useRef } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { AgentMessageRecord, AgentSendRecord } from '@iart/contracts';
import { resolveAgentFailureText } from '@/features/agent/agentErrorText';
import {
  ensureAgentMessagesLoaded,
  useAgentMessages,
  useAgentPendingToolProposals,
  useAgentSendRecords,
  useAgentSessionError,
  useAgentSessionInFlight,
  useAgentSessionMeta,
  useAgentSessionStore,
  useAgentStreamingText,
} from '@/features/agent/agentSessionStore';
import { formatBeijingDateDivider, getBeijingDateKey } from '@/shared/utils/time';
import { Button } from '@/components/ui/button';
import { AgentMessageMarkdown } from './AgentMessageMarkdown';
import { AgentSessionMessage, MessageBody } from './AgentSessionMessage';
import { AgentSessionToolActivity } from './AgentSessionToolActivity';
import {
  isToolActivityMessage,
  toolActivityGroupKey,
  type ToolActivityMessage,
} from './agentToolActivityModel';
import { AgentToolProposalPanel } from './AgentToolProposalPanel';
// 会话视图自有样式（状态条呼吸动画 / 流式光标）：组件级 import（NodeCanvas 同款），PostCSS/Tailwind 管线处理。
import '../agentSessionView.css';

/**
 * Agent 会话视图 — 右侧工作区的正式内容之一（spec docs/agent/02「会话视图与多轮历史」）。
 *
 * - 只读：呈现该会话的完整多轮历史，按时间顺序；流式回复同步渲染。
 *   输入与继续一律回到 PromptDock——本视图不提供输入框，也没有会话切换器。
 * - 会话身份信息（标题 / 模型 / 消息量 / 最新时间）不在此重复：面板标题栏已给会话标题，
 *   节点头部给 model_id，「最近一次对话」的时间口径见 spec 02，视图内只呈现消息流本身。
 * - 发送留痕（spec 03「发送留痕先于受理可见」）按时间序并入会话流：还没落成正式
 *   user 消息的留痕记录（受理前 / 该轮失败）在这里可见；受理后由正式消息承载，不重复渲染。
 * - 打开时按需读取消息（spec 03「生命周期与 IPC」：不在项目打开时全量加载）：
 *   视图区分「正在读取 / 读取失败 / 空」三种无内容态，不把「还没读到」说成「没有消息」，
 *   也不把读取失败呈现成无限加载。读取态留在顶部（内容到达时不跳动），空 / 失败终态居中。
 * - 消息流按北京时间日期分界插入分隔条（`time.ts` 共享 helper，禁止就地格式化）。
 * - 该轮失败的呈现（消息列表尾部的错误条，文案按错误码映射）+ 11px 出口指引：出口是
 *   画布底部的创作条（PromptDock）；视图内不提供重新发送按钮（spec 02 只读口径）。
 * - 连续的同名工具条目在流内聚合成工具活动组（`AgentSessionToolActivity`）：
 *   连续同名**图片生成**工具调用走相册组（`AgentSessionMediaAlbum`，spec 02 2026-09-21 裁决：
 *   组头双计数 + 相册网格 / N=1 独立带 + 提示词明细，替代逐调用「提案卡 + 结果卡」堆叠；
 *   待审批提案不进相册）；其余工具走组头轻行 + 条目卡，组本身无背景无边框，
 *   状态由组头摘要与条目卡行 1 承载。
 * - 存在未决工具提案时，列表下方常驻批量审批面板（spec 05「Confirm 决裁流程」）：
 *   勾选提交与整轮驳回都在面板内，卡片不再逐条给出决裁出口。
 * - 流式粘底跟随：距底 ≤80px 时新内容自动跟到最新；用户向上滚开后停跟随（不抢滚动位置）。
 * - 只改右侧工作区状态，不触碰画布：打开/关闭不移动画布 viewport 或兄弟节点。
 * - 会话数据读不到时给明确说明（含出口），不显示空白面板或零值摘要。
 */

/** 粘底跟随引擎用已装依赖 use-stick-to-bottom（内容尺寸监听驱动，设计见
 * docs/agent/Agent会话视图跟随滚动-design.md §3 R1）：距底 ≤70px（库内建
 * isNearBottom 语义）视作「在底部」，任何来源的内容长高（流式打字 / 工具
 * 活动卡 / 产物媒体 / 渲染回填）都自动跟随；用户向上滚动即停（不抢滚动
 * 条），滚回底部自动恢复，「回到底部」按钮一键回底（R3 恢复出口）。
 * 行为验收走真实浏览器（本交互 jsdom/静态门禁不覆盖，见设计文档 §7）。 */

/** 会话流时间线条目：正式消息（seq 序）与未受理的发送留痕（createdAt 序）按时间合并。 */
type TimelineEntry =
  | { kind: 'message'; message: AgentMessageRecord; sortKey: number }
  | { kind: 'sendRecord'; record: AgentSendRecord; sortKey: number };

/**
 * 合并规则：正式消息按存储写入端分配的 seq 升序（权威顺序，createdAt 只作与留痕
 * 对齐的时间键）；留痕只保留尚无正式 user 消息对应的 requestId（受理前 / 失败轮），
 * 同刻先留痕后消息（留痕先于受理落库）。
 */
const buildTimeline = (
  messages: readonly AgentMessageRecord[],
  sendRecords: readonly AgentSendRecord[],
): TimelineEntry[] => {
  const messageEntries: TimelineEntry[] = messages.map((message) => ({
    kind: 'message',
    message,
    sortKey: message.createdAt,
  }));
  const acceptedRequestIds = new Set(
    messages.flatMap((message) =>
      message.role === 'user' && message.requestId !== null ? [message.requestId] : [],
    ),
  );
  const pendingRecords = [...sendRecords]
    .filter((record) => !acceptedRequestIds.has(record.requestId))
    .sort((a, b) => a.createdAt - b.createdAt);

  const merged: TimelineEntry[] = [];
  let j = 0;
  for (const entry of messageEntries) {
    while (j < pendingRecords.length) {
      const record = pendingRecords[j];
      if (record === undefined || record.createdAt > entry.sortKey) break;
      merged.push({ kind: 'sendRecord', record, sortKey: record.createdAt });
      j += 1;
    }
    merged.push(entry);
  }
  for (; j < pendingRecords.length; j += 1) {
    const record = pendingRecords[j];
    if (record === undefined) break;
    merged.push({ kind: 'sendRecord', record, sortKey: record.createdAt });
  }
  return merged;
};

/**
 * 会话流渲染条目：连续的同名工具条目折成一条工具活动组（工具切换即切开），
 * 其余条目按时间序单排。时间线合并规则（buildTimeline）不动，这里只做呈现分组。
 */
type ViewEntry =
  | { kind: 'message'; message: AgentMessageRecord }
  | { kind: 'sendRecord'; record: AgentSendRecord }
  | { kind: 'toolRun'; key: string; entries: ToolActivityMessage[] };

const buildViewEntries = (timeline: readonly TimelineEntry[]): ViewEntry[] => {
  const viewEntries: ViewEntry[] = [];
  for (const entry of timeline) {
    if (entry.kind === 'sendRecord') {
      viewEntries.push({ kind: 'sendRecord', record: entry.record });
      continue;
    }
    const { message } = entry;
    if (!isToolActivityMessage(message)) {
      viewEntries.push({ kind: 'message', message });
      continue;
    }
    const previous = viewEntries[viewEntries.length - 1];
    if (previous?.kind === 'toolRun') {
      const lastOfRun = previous.entries[previous.entries.length - 1];
      if (lastOfRun !== undefined && toolActivityGroupKey(lastOfRun) === toolActivityGroupKey(message)) {
        previous.entries.push(message);
        continue;
      }
    }
    viewEntries.push({ kind: 'toolRun', key: `tool-run-${String(message.seq)}`, entries: [message] });
  }
  return viewEntries;
};

/** 条目时间（日期分隔比较用）：工具活动组取组内首条消息的时间。 */
const entryCreatedAt = (entry: ViewEntry): number | null => {
  if (entry.kind === 'message') return entry.message.createdAt;
  if (entry.kind === 'sendRecord') return entry.record.createdAt;
  const first = entry.entries[0];
  return first === undefined ? null : first.createdAt;
};

/** 列表键（正式消息按 seq，留痕按 recordId，工具活动组按组键）。 */
const entryKey = (entry: ViewEntry): string => {
  if (entry.kind === 'toolRun') return entry.key;
  if (entry.kind === 'sendRecord') return entry.record.recordId;
  return `message-${String(entry.message.seq)}`;
};

export function AgentSessionView({ agentSessionId }: { agentSessionId: string }) {
  const session = useAgentSessionMeta(agentSessionId);
  const messages = useAgentMessages(agentSessionId);
  const sendRecords = useAgentSendRecords(agentSessionId);
  const streamingText = useAgentStreamingText(agentSessionId);
  const inFlight = useAgentSessionInFlight(agentSessionId);
  const sessionError = useAgentSessionError(agentSessionId);
  const messagesLoaded = useAgentSessionStore(
    (state) => state.messagesLoadedSessionIds[agentSessionId] === true,
  );
  const messagesLoadFailed = useAgentSessionStore(
    (state) => state.messagesLoadFailedSessionIds[agentSessionId] === true,
  );
  // 未决提案批（在途轮次 + 该轮 proposed 条目）：批量审批面板的数据源，无批时为 null。
  const pendingProposals = useAgentPendingToolProposals(agentSessionId);

  useEffect(() => {
    void ensureAgentMessagesLoaded(agentSessionId);
  }, [agentSessionId]);

  const timeline = useMemo(() => buildTimeline(messages, sendRecords), [messages, sendRecords]);
  const viewEntries = useMemo(() => buildViewEntries(timeline), [timeline]);

  // 流式粘底跟随：内容尺寸监听驱动（use-stick-to-bottom）——任何来源的长高统一进入
  // 「是否在底部」判定，不逐类订阅输出信号。scrollRef 挂滚动容器、contentRef 挂内容层；
  // resize 用 instant（大块插入不拖尾）、initial 关闭（进入会话由定位 effect 瞬时贴底）。
  const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom } = useStickToBottom({
    resize: 'instant',
    initial: false,
  });

  // 会话切换：瞬时定位到最新消息（R4，不平滑长滚）。触发点 = 会话身份变化或消息内容
  // 到达（异步读取完成后消息记录落 store、渲染撑出内容——依赖用 messages 引用变化，
  // 因为 messagesLoaded 在「曾打开过」的会话上恒为 true，重开视图不再变化，会漏掉重定位）。
  // 瞬时直接写 scrollTop（不走 scrollToBottom 的动画 promise）。
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [agentSessionId, messages, messagesLoadFailed]);

  const isReplying = inFlight !== null || streamingText.length > 0;

  if (session === null) {
    return (
      <div
        className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground"
        data-testid="agent-session-view-unavailable"
      >
        这个会话已经不在了，删掉这个节点后可以重新开始。
      </div>
    );
  }

  const isWaitingForMessages =
    messages.length === 0 && !isReplying && !messagesLoaded && !messagesLoadFailed;
  const isEmpty = messages.length === 0 && !isReplying && messagesLoaded;
  // 终态（空 / 读取失败）只有在列表里确实没有别的内容时才居中，否则按普通提示条跟在流内。
  const terminalStateAlone =
    viewEntries.length === 0 && !isReplying && sessionError === null && messages.length === 0;

  const renderEntry = (entry: ViewEntry) => {
    if (entry.kind === 'toolRun') {
      return <AgentSessionToolActivity entries={entry.entries} />;
    }
    if (entry.kind === 'sendRecord') {
      return (
        <article
          className="flex flex-col gap-1 [content-visibility:auto] [contain-intrinsic-size:auto_120px]"
          data-testid="agent-session-send-record"
          data-request-id={entry.record.requestId}
        >
          <MessageBody message={sendRecordAsMessageProjection(entry.record)} />
        </article>
      );
    }
    return <AgentSessionMessage message={entry.message} />;
  };

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="agent-session-view"
      data-agent-session-id={agentSessionId}
    >
      {/* 消息流：会话身份信息不在视图内重复（标题在面板标题栏、模型在节点头部）；
          role="log" 让辅助技术按「追加的日志流」理解这块区域，不打断式播报（不加 aria-live）。 */}
      <div
        ref={(node) => {
          listRef.current = node;
          scrollRef(node);
        }}
        role="log"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-3"
        data-testid="agent-session-message-list"
      >
        <div ref={contentRef} className="flex flex-col gap-5">
        {/* 读取态留在顶部：内容到达时列表不整体位移（终态才居中）。 */}
        {isWaitingForMessages ? (
          <p className="text-xs text-muted-foreground" data-testid="agent-session-view-loading">
            正在读取…
          </p>
        ) : null}

        {isEmpty || messagesLoadFailed ? (
          <div
            className={
              terminalStateAlone
                ? 'flex flex-1 flex-col items-center justify-center px-4 text-center'
                : 'flex flex-col'
            }
          >
            {messagesLoadFailed ? (
              <p className="text-[11px] text-muted-foreground" data-testid="agent-session-view-load-failed">
                会话内容没能读出来，关掉这个面板再打开试试。
              </p>
            ) : null}
            {isEmpty ? (
              <p className="text-[11px] text-muted-foreground" data-testid="agent-session-view-empty">
                还没有消息，在创作条里说说你想做什么吧。
              </p>
            ) : null}
          </div>
        ) : null}

        {viewEntries.map((entry, index) => {
          const createdAt = entryCreatedAt(entry);
          const previousEntry = index > 0 ? viewEntries[index - 1] : undefined;
          const previousCreatedAt =
            previousEntry === undefined ? null : entryCreatedAt(previousEntry);
          const dateKey = createdAt === null ? '' : getBeijingDateKey(createdAt);
          const previousDateKey =
            previousCreatedAt === null ? '' : getBeijingDateKey(previousCreatedAt);
          // 相邻条目跨北京时间日期即插分隔条；时间缺失（不合法时间戳）时不插，也不误判成新的一天。
          const dividerLabel =
            dateKey.length > 0 && dateKey !== previousDateKey
              ? formatBeijingDateDivider(createdAt)
              : '';
          return (
            <Fragment key={entryKey(entry)}>
              {dividerLabel.length > 0 ? (
                <div
                  className="flex items-center gap-2 pt-1"
                  data-testid="agent-session-date-divider"
                  data-date={dateKey}
                >
                  <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                    {dividerLabel}
                  </span>
                  <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
                </div>
              ) : null}
              {renderEntry(entry)}
            </Fragment>
          );
        })}

        {/* 流式回复实时渲染：无盒，meta + 左侧 primary 状态条表达进行中，文本尾随 2px 闪烁光标 */}
        {isReplying ? (
          <article className="relative flex flex-col gap-1 pb-1 pl-4" data-testid="agent-session-streaming">
            <span
              aria-hidden="true"
              className="agent-session-pulse absolute inset-y-0 left-0 w-0.5 rounded-full bg-primary"
            />
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Agent</span>
              <span aria-hidden="true">·</span>
              <span>正在回复…</span>
            </div>
            {streamingText.length > 0 ? (
              <div className="min-w-0">
                <AgentMessageMarkdown
                  text={streamingText}
                  streaming
                  className="agent-session-caret-host"
                />
              </div>
            ) : null}
          </article>
        ) : null}

        {/* 该轮失败的呈现（受理后的失败只到这里与一次性 toast）：文案按错误码映射，不印后端原文；
            出口是画布底部的创作条（本视图没有输入区，也不提供重试按钮）。 */}
        {sessionError !== null ? (
          <div
            className="flex flex-col gap-0.5 rounded-lg bg-(--st-failed)/10 px-3 py-2"
            data-testid="agent-session-error"
          >
            <p className="text-[13px] leading-[1.6] text-(--st-failed-text)">
              {resolveAgentFailureText(sessionError.code)}
            </p>
            <p className="text-[11px] text-muted-foreground" data-testid="agent-session-error-hint">
              可在画布底部的创作条里重新发送
            </p>
          </div>
        ) : null}
        </div>
      </div>

      {/* 「回到底部」：跟随停止（用户上翻历史）后的恢复出口（R3）。显隐判据是
          几何是否在底部（isAtBottom，含 isNearBottom 语义），与「跟随是否被
          劫持」无关——处于底部即隐藏，离开即出现。 */}
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={() => {
          stopScroll();
          void scrollToBottom({ animation: 'smooth' });
        }}
        aria-label="回到底部"
        data-testid="agent-session-scroll-to-bottom"
        className={
          'absolute bottom-3 left-1/2 z-10 -translate-x-1/2 bg-popover shadow-md transition-opacity ' +
          (isAtBottom ? 'pointer-events-none opacity-0' : 'opacity-100')
        }
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" className="size-3.5">
          <path
            d="M8 2.5v10.5m0 0 4.5-4.5M8 13 3.5 8.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>

      {/* 批量审批面板：有未决提案时常驻列表下方（不随滚动跑出视野；提交后由 live 态驱动收起） */}
      {pendingProposals !== null ? (
        <AgentToolProposalPanel agentSessionId={agentSessionId} batch={pendingProposals} />
      ) : null}
    </div>
  );
}

/**
 * 发送留痕 → user 消息投影（只读投影，不改 store 形状）：留痕的 content 映射成 chat
 * 消息体供 MessageBody 渲染；列表键用 recordId，seq 无消费方。
 */
const sendRecordAsMessageProjection = (record: AgentSendRecord): AgentMessageRecord => ({
  agentSessionId: record.agentSessionId,
  seq: -1,
  role: 'user',
  requestId: record.requestId,
  body: { kind: 'chat', content: record.content },
  plan: null,
  createdAt: record.createdAt,
  isPartial: false,
});

export default AgentSessionView;
