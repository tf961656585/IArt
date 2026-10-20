import { cn } from '@iart/ui';
import type { BindingTone } from './ProviderNoticeBar';

/**
 * 状态「点 + 文字」。
 *
 * 为什么不再用胶囊（2026-10-19）：同屏曾有四个状态词（已启用 / 可用 / 已设置 / 生成默认），
 * 全都做成视觉语言相近的小胶囊，用户会把「服务商开着」读成「模型能用」。
 * 降为点 + 文字后状态词靠**文字**区分，颜色只承担异常提示；胶囊形态留给需要强调的异常
 * （见 `StatusPill`）。状态词按对象分域的口径见 `docs/ui-copy-standard.md` 第 9 条。
 */
export function StatusDot({ tone, label }: { tone: BindingTone; label: string }) {
  const dot: Readonly<Record<BindingTone, string>> = {
    ok: 'bg-success',
    warn: 'bg-warning',
    bad: 'bg-destructive',
    idle: 'bg-muted-foreground',
  };
  const text: Readonly<Record<BindingTone, string>> = {
    ok: 'text-foreground',
    warn: 'text-warning',
    bad: 'text-destructive',
    idle: 'text-muted-foreground',
  };
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-2xs', text[tone])}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot[tone])} aria-hidden="true" />
      {label}
    </span>
  );
}
