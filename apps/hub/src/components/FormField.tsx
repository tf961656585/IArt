import type { ReactNode } from 'react';
import { cn } from '@iart/ui';

/**
 * 表单字段的标签 + 控件布局。
 *
 * 标签必须是控件的**兄弟**，不能把控件包在带文字色的容器里：控件文字色由自身钉死，
 * 但容器一旦设 `text-muted-foreground`，任何没有显式覆色的控件都会把已填内容画成
 * 占位色（2026-10-27 接口格式页实证）。规范见 `docs/ui-form-control-standard.md`。
 */
export function FormField({
  label,
  htmlFor,
  hint,
  description,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const labelClass = 'text-2xs text-muted-foreground';
  return (
    <div data-slot="form-field" className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-1">
        {htmlFor === undefined ? (
          <span className={labelClass}>{label}</span>
        ) : (
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        )}
        {hint}
      </div>
      {children}
      {description === undefined ? null : (
        <p className="text-2xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
