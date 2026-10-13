'use client';

import { useMemo, useState } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import type { AgentToolCallRecord } from '@iart/contracts';
import { cn } from '@/lib/utils';
import {
  useAgentSessionInFlight,
  useAgentSessionMeta,
  useAgentSessionStore,
} from '@/features/agent/agentSessionStore';
import { AgentSessionMediaAlbum } from './AgentSessionMediaAlbum';
import { ToolCallEntryCard, ToolResultEntryCard } from './AgentSessionToolEntries';
import {
  buildAlbumModel,
  entryStatus,
  isAlbumToolGroup,
  isToolCallMessage,
  type ToolActivityEntry,
  type ToolActivityMessage,
} from './agentToolActivityModel';
import { TOOL_STATUS_LABEL, isToolStatusGenerating, toolLabel } from './toolStatus';

/**
 * 工具活动组（spec docs/agent/05「Yolo 语义」、06「工具提案交互」、02「会话视图与多轮历史」）。
 *
 * 一条连续同名工具条目序列 = 一个组。两种形态：
 * - **相册组**（连续同名图片生成工具，spec 02 2026-09-21 裁决）：组头轻行「N 次调用 · M 张图」
 *   + 相册网格（或 N=1 真实比例独立带），替代逐调用「提案卡 + 结果卡」堆叠；形态与归属呈现
 *   见 `AgentSessionMediaAlbum`。整组都是待审批提案时不走相册，回落条目卡组。
 * - **条目卡组**（其余工具）：组头轻行 + 条目卡列表——组本身无背景、无边框、无组级状态色条
 *   （组头摘要文字与条目卡行 1 承载状态）；**条目卡是唯一容器**（--card + 1px border +
 *   rounded-lg + overflow-hidden），信息行（padding 10px 12px）+ 满幅媒体带。
 *
 * 折叠：含产物组永不自动折叠；无产物的全部终态组 >2 项时默认折叠，用户手动切换优先。
 * 相册组的产物口径 = 相册格数（已就绪产物 + 状态占位格）。
 *
 * 决裁边界不变：`confirm` 档的出口只在批量审批面板（`AgentToolProposalPanel`）；
 * 本模块只保留 `yolo` 档自动执行场景的单条取消（条目卡组在卡内、相册组在组头下，spec 04）。
 */

/** 自动折叠阈值：组内条目数（无产物的组全部终态时）。 */
const AUTO_COLLAPSE_MIN_ITEMS = 2;

/** 组头摘要的 fragment 分档（生成中 / 等待确认 / 已完成 / 失败 / 已取消 / 未执行）。 */
const GROUP_FRAGMENTS: {
  id: string;
  word: string;
  tone: string;
  match: (status: AgentToolCallRecord['status']) => boolean;
}[] = [
  {
    id: 'generating',
    word: '生成中',
    tone: 'text-(--st-generating-text)',
    match: isToolStatusGenerating,
  },
  {
    id: 'proposed',
    word: TOOL_STATUS_LABEL.proposed,
    tone: 'text-muted-foreground',
    match: (status) => status === 'proposed',
  },
  {
    id: 'succeeded',
    word: TOOL_STATUS_LABEL.succeeded,
    tone: 'text-muted-foreground',
    match: (status) => status === 'succeeded',
  },
  {
    id: 'failed',
    word: TOOL_STATUS_LABEL.failed,
    tone: 'text-(--st-failed-text)',
    match: (status) => status === 'failed',
  },
  {
    id: 'cancelled',
    word: TOOL_STATUS_LABEL.cancelled,
    tone: 'text-muted-foreground',
    match: (status) => status === 'cancelled',
  },
  {
    id: 'skipped',
    word: TOOL_STATUS_LABEL.skipped,
    tone: 'text-muted-foreground',
    match: (status) => status === 'skipped',
  },
];

/** 组头摘要的分档计数：「<工具名> · N 项 · N 生成中 · N 已完成 …」。 */
const groupSummaryFragments = (
  statuses: readonly AgentToolCallRecord['status'][],
): { id: string; word: string; tone: string; count: number }[] =>
  GROUP_FRAGMENTS.map((fragment) => ({
    id: fragment.id,
    word: fragment.word,
    tone: fragment.tone,
    count: statuses.filter((status) => fragment.match(status)).length,
  })).filter((fragment) => fragment.count > 0);

/** 产物总数（条目卡组：折叠时显示「N 项产物」；含产物条目永不自动折叠）。 */
const artifactCountOf = (entries: readonly ToolActivityMessage[]): number =>
  entries.reduce(
    (count, message) => count + (message.body.kind === 'tool_result' ? message.body.assetIds.length : 0),
    0,
  );

/**
 * 一组连续的同名工具条目：相册形态走 `AgentSessionMediaAlbum`，其余走组头 + 条目卡列表。
 * 组内条目状态在此解析一次（结果消息按自身结算态；调用消息取活跃态），下游不再重复取数。
 */
export function AgentSessionToolActivity({ entries }: { entries: readonly ToolActivityMessage[] }) {
  const agentSessionId = entries[0]?.agentSessionId ?? null;
  const liveEntries = useAgentSessionStore((state) =>
    agentSessionId ? state.toolCallsLiveBySessionId[agentSessionId] ?? null : null,
  );
  const inFlight = useAgentSessionInFlight(agentSessionId);
  const session = useAgentSessionMeta(agentSessionId);
  const resolvedEntries = useMemo(
    () =>
      entries.map(
        (message): ToolActivityEntry => ({
          message,
          status: entryStatus(
            message,
            isToolCallMessage(message) ? liveEntries?.[message.body.toolCallId] ?? null : null,
          ),
        }),
      ),
    [entries, liveEntries],
  );
  const albumModel = useMemo(
    () => (isAlbumToolGroup(entries) ? buildAlbumModel(resolvedEntries) : null),
    [entries, resolvedEntries],
  );
  // 产出物口径：相册组看相册格数（已就绪产物 + 状态占位格），其余组看结果消息里的资产数。
  const productCount = albumModel === null ? artifactCountOf(entries) : albumModel.imageCount;
  const allTerminal = resolvedEntries.every(
    ({ status }) => !isToolStatusGenerating(status) && status !== 'proposed',
  );
  const defaultCollapsed = productCount === 0 && allTerminal && entries.length > AUTO_COLLAPSE_MIN_ITEMS;
  // 用户手动切换前跟随派生默认（全终态后自动折叠仍然生效）。
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const collapsed = userCollapsed ?? defaultCollapsed;

  // 整组都是待审批提案时相册里没有可聚合的调用：回落条目卡组（审批行动入口不藏进聚合）。
  const album = albumModel !== null && albumModel.callCount > 0 ? albumModel : null;
  if (album !== null) {
    return (
      <AgentSessionMediaAlbum
        model={album}
        collapsed={collapsed}
        onToggleCollapsed={() => setUserCollapsed(!collapsed)}
        inFlight={inFlight !== null}
        yoloMode={session?.approvalMode === 'yolo'}
      />
    );
  }

  const verb = toolLabel(entries[0]?.body.toolName ?? '');
  const fragments = groupSummaryFragments(resolvedEntries.map((entry) => entry.status));

  return (
    <section
      className="flex flex-col border-t pt-2"
      data-testid="agent-session-tool-group"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={`${verb} · ${entries.length} 项`}
    >
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        data-testid="agent-tool-group-toggle"
        className="flex w-full items-center gap-1.5 pb-1.5 text-left text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate" data-testid="agent-tool-group-summary">
          {verb} · {entries.length} 项
          {fragments.map((fragment) => (
            <span key={fragment.id} className={fragment.tone}>
              {' · '}
              {fragment.count} {fragment.word}
            </span>
          ))}
        </span>
        {collapsed && productCount > 0 ? <span className="flex-none">{productCount} 项产物</span> : null}
        <IconChevronDown
          size={12}
          aria-hidden="true"
          className={cn('ml-auto flex-none transition-transform', collapsed && '-rotate-90')}
        />
      </button>
      {collapsed ? null : (
        <div className="flex flex-col gap-2 pb-1">
          {resolvedEntries.map(({ message, status }) =>
            isToolCallMessage(message) ? (
              <ToolCallEntryCard
                key={message.seq}
                message={message}
                status={status}
                inFlight={inFlight !== null}
                yoloMode={session?.approvalMode === 'yolo'}
              />
            ) : (
              <ToolResultEntryCard key={message.seq} message={message} status={status} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

export default AgentSessionToolActivity;
