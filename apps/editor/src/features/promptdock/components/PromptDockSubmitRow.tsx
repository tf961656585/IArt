'use client';

import { IconArrowUp, IconLoader2, IconPlayerStopFilled } from '@tabler/icons-react';

import { Button } from '@/components/ui/button';
import {
  stopCurrentAgentRound,
  useAgentSessionInFlight,
} from '@/features/agent/agentSessionStore';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import type { PromptDockForm } from '../PromptDock.types';
import { usePromptDockStore } from '../promptDockStore';

type PromptDockSubmitRowProps = {
  form: PromptDockForm;
  selectedEntry: PromptDockCatalogEntry | null;
  submitting: boolean;
  onSubmit: () => void;
};

/**
 * 次行右端的主提交钮（R1(b) 动作耦合：配置在左、提交在右，位置两形态恒定，
 * 见 docs/editor/dock-布局规范.md）。
 * 任务数由左侧参数簇的 stepper 承载（见 PromptDockTaskCountStepper）；agent 形态不承载任务数。
 *
 * 形态差异（spec docs/agent/06「文案原则」「Agent 形态的输入面」）：
 * - agent 形态：圆形图标发送钮（ArrowUp），受理前提交等待换 Loader2 旋转；会话在途时
 *   同一位置双态变停止钮（运行中停止：整请求取消，partial 保留，收口后恢复发送态）；
 *   输入为空禁用（空输入不是提交意图，回车路径同口径拦截）；
 *   没有可用模型时保持可点——由前置校验给出可行动的阻断反馈，不用禁用态吞掉反馈。
 * - 生成式形态：「生成」文字胶囊钮；未选模型禁用（现有规则），进行中写「提交中…」。
 */
export function PromptDockSubmitRow({
  form,
  selectedEntry,
  submitting,
  onSubmit,
}: PromptDockSubmitRowProps) {
  const prompt = usePromptDockStore((s) => s.draft.prompt);
  const hasPrompt = prompt.trim().length > 0;
  const agentBinding = usePromptDockStore((s) => s.agentBinding);
  const inFlight = useAgentSessionInFlight(
    agentBinding === null ? null : agentBinding.agentSessionId,
  );

  if (form === 'agent') {
    if (inFlight !== null) {
      return (
        <Button
          type="button"
          onClick={() => stopCurrentAgentRound(inFlight.agentSessionId)}
          aria-label="停止"
          className="h-8 w-8 flex-none rounded-full bg-primary p-0 text-primary-foreground hover:bg-primary/90 active:scale-[0.97]"
          data-testid="promptdock-stop"
        >
          <IconPlayerStopFilled size={16} aria-hidden="true" />
        </Button>
      );
    }
    const canSubmit = hasPrompt && !submitting;
    return (
      <Button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-label="发送"
        className="h-8 w-8 flex-none rounded-full bg-primary p-0 text-primary-foreground hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40"
        data-testid="promptdock-submit"
      >
        {submitting ? (
          <IconLoader2 size={16} className="animate-spin" aria-hidden="true" />
        ) : (
          <IconArrowUp size={16} aria-hidden="true" />
        )}
      </Button>
    );
  }

  const canSubmit = Boolean(selectedEntry) && !submitting;
  return (
    <Button
      type="button"
      onClick={onSubmit}
      disabled={!canSubmit}
      className="h-8 flex-none rounded-full bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90 active:scale-[0.97]"
      data-testid="promptdock-submit"
    >
      {submitting ? '提交中…' : '生成'}
    </Button>
  );
}
