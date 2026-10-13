'use client';

import { usePromptDockStore } from '../promptDockStore';

const MIN_TASK_COUNT = 1;
const MAX_TASK_COUNT = 10;

/**
 * 固定任务数 stepper（原型 .stepper 形态，PD7：一次提交创建 N 个独立 RuntimeTask）。
 * 任务数只决定受理时创建并直接并发派发的 RuntimeTask 数，不是成功目标/资产数。
 */
export function PromptDockTaskCountStepper() {
  const taskCount = usePromptDockStore((s) => s.draft.taskCount);
  const setDraft = usePromptDockStore((s) => s.setDraft);

  const clampTaskCount = (next: number): number => {
    if (!Number.isFinite(next)) return MIN_TASK_COUNT;
    return Math.min(MAX_TASK_COUNT, Math.max(MIN_TASK_COUNT, Math.floor(next)));
  };

  return (
    // 悬停说明（拍板项 2026-09-20）：「一次生成 N 个任务」从常驻文字降级为 title——
    // 环境已由「任务数 N」说清数值语义，常驻解释属可删文案（ui-copy-standard §1）。
    <div
      className="flex items-center gap-1.5"
      title={`一次生成 ${taskCount} 个任务`}
      data-testid="promptdock-task-count"
    >
      <span className="text-[11px] whitespace-nowrap text-muted-foreground">任务数</span>
      <div className="inline-flex h-7 flex-none items-center overflow-hidden rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setDraft({ taskCount: clampTaskCount(taskCount - 1) })}
          disabled={taskCount <= MIN_TASK_COUNT}
          aria-label="减少任务数"
          className="inline-flex h-full w-[26px] items-center justify-center border-none bg-transparent p-0 text-[13px] leading-none text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          −
        </button>
        <span
          className="min-w-[30px] text-center text-xs leading-none text-foreground tabular-nums"
          aria-live="polite"
        >
          {taskCount}
        </span>
        <button
          type="button"
          onClick={() => setDraft({ taskCount: clampTaskCount(taskCount + 1) })}
          disabled={taskCount >= MAX_TASK_COUNT}
          aria-label="增加任务数"
          className="inline-flex h-full w-[26px] items-center justify-center border-none bg-transparent p-0 text-[13px] leading-none text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ＋
        </button>
      </div>
    </div>
  );
}
