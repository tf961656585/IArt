'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/shared/utils/duration';
import { Button } from '@/components/ui/button';
import {
  rejectAgentToolRound,
  submitAgentToolDecisions,
  useAgentMessages,
  type AgentPendingToolProposalBatch,
  type AgentToolDecisionDeliveryFailure,
} from '@/features/agent/agentSessionStore';
import type { AgentToolCallLive } from '@/features/agent/agentSessionState';
import { ReferenceAssetChips } from './AgentSessionMedia';
import { TOOL_STATUS_LABEL, TOOL_STATUS_TONE, parseToolArgs, toolLabel } from './toolStatus';

/**
 * 批量审批面板（spec docs/agent/05「Confirm 决裁流程」、06「工具提案交互」）。
 *
 * - 触发与取数：会话存在在途轮次、且该轮仍有未决（`proposed`）条目时出现（选择器
 *   `useAgentPendingToolProposals` 派生，本组件只呈现）。提案按条平铺、**默认全部勾选**，
 *   取消勾选即过滤——提交携带本批全部未决条目的完整映射，未勾选条目按不执行结算。
 * - 批级倒计时：整批共享一个截止时间（同批同值）；归零后界面进入只读，等 Backend 按超时结算，
 *   前端不自行改状态、不自行收起面板。顶部 2px 进度条宽度 = 剩余 / 批级总时长，
 *   剩余 < 25% 换琥珀档、过期转失败档；总时长由「截止时刻 − 本批提案条目落库时刻」得出
 *   （同批同值，不另立一份超时常量），取不到时不猜总时长、只呈现生成中 / 过期两档。
 * - 提交后本面板不自行消失：条目在 live 上离开 `proposed`（派发/结算）后由选择器收起，
 *   逐条条目卡接着呈现执行进度。
 * - 只读门槛（禁用勾选与两枚动作）：提交进行中（防重复提交）与已超时。
 * - 文案与无障碍：勾选框用 `<label for>` 关联条目内容（控件名即条目摘要）；界面不出现
 *   内部档位标识与机制解释。
 */

const TITLE = '勾选确认';
/** group 的无障碍名：标题是控件名（短名词），这里说清「谁在等谁做什么」。 */
const GROUP_ARIA_LABEL = '待你确认的操作';
const SUBMIT_LABEL = '执行所选';
const REJECT_LABEL = '整轮驳回';
const EXPIRED_TEXT = '已超时，本轮未执行。';
/** 过期后的出口指引：输入与继续一律回 PromptDock（本视图不提供重发按钮）。 */
const EXPIRED_HINT = '可回到下方输入框重新发送';

/** 临界档阈值：剩余 < 25% 批级总时长（原型四态之「临界」）。 */
const CRITICAL_REMAINING_RATIO = 0.25;

/** 倒计时档 → 进度条颜色（生成中 / 临界派生深琥珀 / 过期失败）。 */
const PROGRESS_BAR_CLASS: Record<'active' | 'critical' | 'expired', string> = {
  active: 'bg-(--st-generating)',
  // 临界档：浅色下 --st-polling(#ca8a04) 对白底仅 2.94:1（非文本对比度 1.4.11 不达标），
  // 按 spec §5.4.2 的 color-mix 派生模式混黑加深（72% + black ≈ #916303，白底 5.26:1）；
  // 深色底黄本就达标（混黑反而降对比），深色档取原值。
  // 主题分叉走 Tailwind dark:（AppThemeProvider 同时写 .dark class 与 data-theme 属性，两轨一致）；
  // 派生色不落 globals.css（那里无余量），也不写 hex 字面量。
  critical: 'bg-[color:color-mix(in_srgb,var(--st-polling)_72%,black)] dark:bg-(--st-polling)',
  expired: 'bg-(--st-failed)',
};

/**
 * 决裁未送达的两条出口（原因不同，出口不同）：
 * - 连接不可用：恢复后再点一次仍然有效；
 * - 该轮已收口：这一批不会被裁定，重试恒无效，如实告知。
 */
const DELIVERY_FAILED_TEXT: Record<AgentToolDecisionDeliveryFailure, string> = {
  connection_unavailable: '连不上，恢复后再点一次。',
  round_closed: '这一轮已经结束，这一批不会再执行。',
};

/**
 * 批级总时长：截止时刻 − 本批提案条目落库时刻（同批同值，spec 04「提案超时（批级）」）。
 * 提案消息尚未落到会话历史（历史未加载 / 不在本会话）时不猜总时长，返回 null。
 */
const useBatchTotalMs = (
  agentSessionId: string,
  requestId: string,
  items: readonly AgentToolCallLive[],
  expiresAt: number | null,
): number | null => {
  const messages = useAgentMessages(agentSessionId);
  return useMemo(() => {
    if (expiresAt === null) return null;
    const batchToolCallIds = new Set(items.map((item) => item.toolCallId));
    for (const message of messages) {
      if (message.requestId !== requestId || message.body.kind !== 'tool_call') continue;
      if (!batchToolCallIds.has(message.body.toolCallId)) continue;
      const totalMs = expiresAt - message.createdAt;
      return totalMs > 0 ? totalMs : null;
    }
    return null;
  }, [messages, requestId, items, expiresAt]);
};

/**
 * 批级倒计时：每秒心跳一次，截止时间到达后停止（到期后的状态变化只来自 Backend 结算）。
 */
const useBatchCountdown = (expiresAt: number | null): { expired: boolean; remainingMs: number } => {
  const [now, setNow] = useState(() => Date.now());
  const expired = expiresAt !== null && expiresAt <= now;
  useEffect(() => {
    if (expiresAt === null || expired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, expired]);
  return {
    expired,
    remainingMs: expiresAt === null ? 0 : Math.max(0, expiresAt - now),
  };
};

/** 单条提案行：勾选框 + 条目摘要（工具名 / 目标模型 / 任务数 / 状态 / prompt / 引用）。 */
const ProposalRow = ({
  item,
  checked,
  disabled,
  onCheckedChange,
}: {
  item: AgentToolCallLive;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (toolCallId: string, checked: boolean) => void;
}) => {
  const args = parseToolArgs(item.argsJson);
  const tone = TOOL_STATUS_TONE[item.status];
  const checkboxId = `agent-tool-proposal-checkbox-${item.toolCallId}`;
  return (
    <li
      className={cn('flex flex-col gap-1.5', checked ? '' : 'opacity-55')}
      data-testid="agent-tool-proposal-item"
      data-tool-call-id={item.toolCallId}
      data-tool-name={item.toolName}
    >
      <div className="flex items-start gap-2">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 h-4 w-4 flex-none accent-primary disabled:opacity-50"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange(item.toolCallId, event.target.checked)}
        />
        <label
          htmlFor={checkboxId}
          className={cn('flex min-w-0 flex-1 flex-col gap-0.5', disabled ? 'cursor-default' : 'cursor-pointer')}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">{toolLabel(item.toolName)}</span>
            {item.modelId !== null ? (
              <span className="truncate text-[11px] text-muted-foreground" title={item.modelId}>
                {item.modelId}
              </span>
            ) : null}
            {args.taskCount !== null ? (
              <span className="text-[11px] text-muted-foreground">任务数 {args.taskCount}</span>
            ) : null}
            <span className={cn('text-[11px]', tone)} data-testid="agent-tool-proposal-status">
              {TOOL_STATUS_LABEL[item.status]}
            </span>
          </span>
          {args.prompt !== null ? (
            <span className="truncate text-[11px] text-muted-foreground" title={args.prompt}>
              {args.prompt}
            </span>
          ) : null}
        </label>
      </div>
      {/* 引用缩略图放在 label 之外：缩略图自带预览动作，点它不应顺带切换勾选态 */}
      {args.referenceAssetIds.length > 0 ? (
        <div className="pl-6">
          <ReferenceAssetChips assetIds={args.referenceAssetIds} />
        </div>
      ) : null}
    </li>
  );
};

export function AgentToolProposalPanel({
  agentSessionId,
  batch,
}: {
  agentSessionId: string;
  batch: AgentPendingToolProposalBatch;
}) {
  const { requestId, expiresAt, items } = batch;
  // 勾选态按 toolCallId 记「用户改成了什么」，缺省即勾选——默认全部勾选，不预写整批状态。
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failureReason, setFailureReason] = useState<AgentToolDecisionDeliveryFailure | null>(null);
  const { expired, remainingMs } = useBatchCountdown(expiresAt);
  const totalMs = useBatchTotalMs(agentSessionId, requestId, items, expiresAt);
  const locked = submitting || expired;

  const isChecked = useCallback(
    (toolCallId: string): boolean => selection[toolCallId] ?? true,
    [selection],
  );
  const selectedCount = items.filter((item) => isChecked(item.toolCallId)).length;
  const allChecked = selectedCount === items.length;

  const phase: 'active' | 'critical' | 'expired' = expired
    ? 'expired'
    : totalMs !== null && remainingMs < totalMs * CRITICAL_REMAINING_RATIO
      ? 'critical'
      : 'active';
  // 过期即满格（整批时长已耗尽）；总时长未知时不做比例呈现（不猜进度）。
  const progressPercent =
    phase === 'expired' ? 100 : totalMs === null ? 100 : Math.round((remainingMs / totalMs) * 100);

  const handleCheckedChange = useCallback((toolCallId: string, checked: boolean): void => {
    setSelection((previous) => ({ ...previous, [toolCallId]: checked }));
  }, []);

  /** 全不选 ⇄ 全选：写实整批勾选态（提交映射语义不变，仍是「未勾选按不执行结算」）。 */
  const toggleAll = useCallback((): void => {
    const nextChecked = !allChecked;
    setSelection(Object.fromEntries(items.map((item) => [item.toolCallId, nextChecked])));
  }, [allChecked, items]);

  /** 决裁送达则面板转入只读（防重复提交）；未送达按原因给对应出口，面板保持可操作。 */
  const applyDelivery = (delivery: ReturnType<typeof rejectAgentToolRound>): void => {
    if (delivery.delivered) {
      setSubmitting(true);
      return;
    }
    setFailureReason(delivery.reason);
  };

  const submitSelected = (): void => {
    if (locked) return;
    setFailureReason(null);
    // 完整映射：本批全部未决条目都在载荷里（未勾选者 execute: false，即过滤结果）。
    const decisions = items.map((item) => ({
      toolCallId: item.toolCallId,
      execute: isChecked(item.toolCallId),
    }));
    const delivery = submitAgentToolDecisions(agentSessionId, requestId, decisions);
    if (delivery.delivered) {
      // 提交已送达：把用户的选择写实（缺省仍勾选会让提交后短暂显示成「已勾选」），
      // 面板此后只读，等 live 离开 proposed 后由选择器收起。
      const appliedSelection: Record<string, boolean> = {};
      for (const decision of decisions) appliedSelection[decision.toolCallId] = decision.execute;
      setSelection(appliedSelection);
    }
    applyDelivery(delivery);
  };

  const rejectRound = (): void => {
    if (locked) return;
    setFailureReason(null);
    applyDelivery(rejectAgentToolRound(agentSessionId, requestId));
  };

  return (
    <section
      role="group"
      aria-label={GROUP_ARIA_LABEL}
      className="relative flex flex-col border-t bg-secondary/20 px-3 py-2"
      data-testid="agent-tool-proposal-panel"
      data-request-id={requestId}
      data-phase={phase}
      data-locked={locked ? 'true' : 'false'}
    >
      {/* 批级倒计时进度条：宽度 = 剩余 / 总时长（过期满格），颜色随档位走 */}
      {expiresAt === null ? null : (
        <span
          aria-hidden="true"
          data-testid="agent-tool-proposal-progress"
          className={cn(
            'absolute top-0 left-0 h-0.5 rounded-r-full transition-[width,background-color] duration-300',
            PROGRESS_BAR_CLASS[phase],
          )}
          style={{ width: `${progressPercent}%` }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{TITLE}</span>
        <span className="text-[11px] text-muted-foreground" data-testid="agent-tool-proposal-summary">
          共 {items.length} 项 · 将执行 {selectedCount} 项
        </span>
        <Button
          type="button"
          variant="ghost"
          size="2xs"
          onClick={toggleAll}
          disabled={locked}
          className="ml-auto"
          data-testid="agent-tool-proposal-toggle-all"
        >
          {allChecked ? '全不选' : '全选'}
        </Button>
        {expiresAt === null ? null : (
          <span
            className={cn(
              'text-[11px] tabular-nums',
              expired ? 'text-(--st-failed-text)' : 'text-muted-foreground',
            )}
            data-testid="agent-tool-proposal-clock"
          >
            {formatDuration(remainingMs) ?? '0:00'}
          </span>
        )}
      </div>

      <ul className="mt-2 flex max-h-[240px] flex-col gap-2 overflow-y-auto">
        {items.map((item) => (
          <ProposalRow
            key={item.toolCallId}
            item={item}
            checked={isChecked(item.toolCallId)}
            disabled={locked}
            onCheckedChange={handleCheckedChange}
          />
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="2xs"
          loading={submitting}
          disabled={locked}
          onClick={submitSelected}
          data-testid="agent-tool-proposal-submit"
        >
          {SUBMIT_LABEL}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="2xs"
          disabled={locked}
          onClick={rejectRound}
          data-testid="agent-tool-proposal-reject"
        >
          {REJECT_LABEL}
        </Button>
        {expired ? (
          <span
            className="flex flex-1 flex-col text-[11px] text-muted-foreground"
            data-testid="agent-tool-proposal-expired-note"
          >
            <b className="text-[12px] font-medium text-(--st-failed-text)">{EXPIRED_TEXT}</b>
            {EXPIRED_HINT}
          </span>
        ) : null}
      </div>

      {failureReason !== null ? (
        <p
          role="alert"
          className="mt-1 text-[11px] text-(--st-failed-text)"
          data-testid="agent-tool-proposal-failure"
        >
          {DELIVERY_FAILED_TEXT[failureReason]}
        </p>
      ) : null}
    </section>
  );
}

export default AgentToolProposalPanel;
