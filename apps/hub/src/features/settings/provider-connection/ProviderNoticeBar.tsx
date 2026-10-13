import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@iart/ui';
import type { ProviderNotice } from './useProviderConnectionData';

/**
 * 服务商管理分区的用户提示条。
 *
 * 口径（UI 设计 §7「反馈通道的硬要求」）：
 * - 成功与失败必须可区分（颜色 + 图标），不得共用一行灰字；
 * - 提示不得被紧随其后的数据刷新清空——因此提示状态由 `useProviderConnectionData` 独立持有，
 *   `reload()` 不触碰它，只有用户操作或显式关闭才改变。
 *
 * 颜色用 Hub 自身令牌（`--success` / `--warning` / `--destructive`，见 `apps/hub/src/app/globals.css`），
 * 不复用原型 `--st-*` 变量。
 */

const TONE_STYLE: Readonly<Record<ProviderNotice['tone'], { icon: typeof CheckCircle2; className: string }>> = {
  success: { icon: CheckCircle2, className: 'border-success/40 text-success' },
  warn: { icon: Info, className: 'border-warning/40 text-warning' },
  error: { icon: AlertCircle, className: 'border-destructive/40 text-destructive' },
};

export function ProviderNoticeBar({
  notice,
  onDismiss,
}: {
  notice: ProviderNotice | null;
  onDismiss: () => void;
}) {
  if (notice === null) return null;
  const tone = TONE_STYLE[notice.tone];
  const Icon = tone.icon;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs',
        tone.className,
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{notice.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * 服务商与模型的状态徽章。
 *
 * 口径：「可用」只表示配置完整、接入关系成立，**不代表已验证连通性**
 * ——本产品不做连接测试（后端无健康探测端点），因此界面不出现「已通过 / 连接正常」。
 */
export type BindingTone = 'ok' | 'warn' | 'bad' | 'idle';

const TONE_PILL: Readonly<Record<BindingTone, string>> = {
  ok: 'border-success/40 text-success',
  warn: 'border-warning/40 text-warning',
  bad: 'border-destructive/40 text-destructive',
  idle: 'border-border text-muted-foreground',
};

const TONE_DOT: Readonly<Record<BindingTone, string>> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  idle: 'bg-muted-foreground',
};

export function StatusPill({ tone, label }: { tone: BindingTone; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-2 py-px text-2xs',
        TONE_PILL[tone],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} aria-hidden="true" />
      {label}
    </span>
  );
}
