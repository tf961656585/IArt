import type { ReactNode } from 'react';
import { cn } from '@iart/ui';

/**
 * 接口格式编辑页的「一行草稿」外壳：弹性换行，不按 12 栅格切列。
 *
 * 每个字段自带最小宽度；一行放不下时整块换到下一行，而不是把窄窗口里的内容压出边界
 * （固定栅格 + 末列右对齐会让必填开关和删除按钮向左溢出压住默认值输入框）。
 */
export function InterfaceFormatDraftRow({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-wrap items-end gap-2 rounded-md border border-border p-2', className)}>
      {children}
    </div>
  );
}
