'use client';

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { IconCheck, IconX } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { resolveTaskStatusMeta, type CanvasTaskStatus } from '../../../utils/taskStatusMeta';

export interface TaskStatusBadgeProps {
  status: CanvasTaskStatus | string;
  className: string | undefined;
  /** 紧凑模式：隐藏文字，仅保留图标/点，减少占用宽度 */
  compact: boolean | undefined;
  /** 覆盖默认状态文案（用于节点内定制表达） */
  labelOverride: string | undefined;
  /** 可选：激活回调（用于点击徽章打开详情面板等场景） */
  onActivate: ((event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>) => void | undefined) | undefined;
  /** 可选：无文字时的可访问性标签 */
  ariaLabel: string | undefined;
}

/**
 * 状态白 pill 徽章（原型 .task-status-badge 同款）。
 * 配色经 --task-dot-* / --task-badge-text-* 令牌消费
 * （docs/editor/visual-design.md §5.5：白 pill 白底恒定 → 700/600 档固定）。
 */
export function TaskStatusBadge({
  status,
  className,
  compact,
  labelOverride,
  onActivate,
  ariaLabel,
}: TaskStatusBadgeProps) {
  const statusMeta = resolveTaskStatusMeta(status, undefined);
  if (!statusMeta) return null;
  const meta = statusMeta.badge;
  const isActive = Boolean(meta.active);
  const label = (typeof labelOverride === 'string' && labelOverride.trim()) ? labelOverride.trim() : statusMeta.label;
  const isInteractive = typeof onActivate === 'function';

  const renderIndicator = () => {
    if (meta.icon === 'check') {
      return <IconCheck size={12} style={{ color: meta.textVar }} />;
    }
    if (meta.icon === 'x') {
      return <IconX size={12} style={{ color: meta.textVar }} />;
    }

    return (
      <span className="relative flex h-2.5 w-2.5 items-center justify-center">
        {isActive && (
          <span
            className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
            style={{ background: meta.pingVar ?? meta.dotVar }}
          />
        )}
        <span
          className="relative inline-flex h-2.5 w-2.5 rounded-full"
          style={{ background: meta.dotVar }}
        />
      </span>
    );
  };

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border border-black/5 bg-white/90 py-0.5 shadow-sm',
        compact ? 'gap-1 px-1.5' : 'gap-1.5 px-2',
        isInteractive && 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
      style={{ color: meta.textVar, fontSize: 10, fontWeight: 500 }}
      title={compact ? label : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={ariaLabel || (compact ? label : undefined)}
      onClick={isInteractive ? onActivate : undefined}
      onKeyDown={
        isInteractive
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onActivate(event);
            }
          : undefined
      }
    >
      {renderIndicator()}
      {!compact ? <span className="leading-none">{label}</span> : null}
    </div>
  );
}

export default TaskStatusBadge;
