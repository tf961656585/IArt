'use client';

import { cn } from '@/lib/utils';
import { usePromptDockStore } from '../promptDockStore';
import type { PromptDockForm } from '../PromptDock.types';

/**
 * 形态切换器（spec docs/agent/06「形态切换入口」，docs/editor/dock-布局规范.md）。
 *
 * 顶带首组、空间锚点（R4/P5）：窄容器折行时恒定行首，不挪动。
 * 高度档（R5）：底座 h-7，选项 h-6 —— 选项命中区 24px，满足 WCAG 2.5.8 下限。
 * 未选中档用 text-foreground/70：muted-foreground on bg-secondary 对比度不足 AA（R7 硬底线）。
 * 创作条的常驻控件：两档「生成」/「Agent」互斥，点击即切换形态；形态不随模型选择
 * 或其他控件隐式改变。切换只改形态，未提交草稿（prompt / 参考）原样保留。
 */
const FORMS: ReadonlyArray<{ value: PromptDockForm; label: string }> = [
  { value: 'generate', label: '生成' },
  { value: 'agent', label: 'Agent' },
];

export function PromptDockFormRow() {
  const form = usePromptDockStore((s) => s.form);
  const setForm = usePromptDockStore((s) => s.setForm);

  return (
    <div
      className="inline-flex h-7 flex-none items-center gap-0.5 rounded-lg border border-border bg-secondary p-px"
      role="radiogroup"
      aria-label="创作形态"
      data-testid="promptdock-form-switch"
    >
      {FORMS.map((item) => {
        const active = form === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setForm(item.value)}
            className={cn(
              'h-6 rounded-[7px] border px-2.5 text-[11px] font-medium leading-none transition-colors',
              'focus-visible:outline-2 focus-visible:outline-(--ring) focus-visible:outline-offset-2',
              active
                ? 'border-transparent bg-primary text-primary-foreground font-semibold hover:bg-primary'
                : 'border-transparent text-foreground/70 hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
