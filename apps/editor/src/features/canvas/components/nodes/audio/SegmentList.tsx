'use client';

import { memo } from 'react';
import { IconCheck, IconClock, IconEdit } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { AudioSegment } from '../../../types/audioSegment';
import { formatTime } from '../../../types/audioSegment';

interface SegmentListProps {
  segments: AudioSegment[];
  onEditClick: () => void;
}

/**
 * 节点内分段列表紧凑组件
 * - 显示分段名称、时间范围、状态指示器
 * - 点击编辑按钮打开分段编辑弹窗
 * - 分段**全量渲染不做内部滚动**（spec：画布节点尺寸管理架构.md 禁止节点内容区内部滚动）；
 *   列表高度由 Layout Model 按分段数派生（audioInputSizePolicy.ts），溢出语义为撑高节点外壳。
 */
export const SegmentList = memo(function SegmentList({
  segments,
  onEditClick,
}: SegmentListProps) {
  if (segments.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">
          分段列表 ({segments.length})
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[11px]"
          onClick={(e) => {
            e.stopPropagation();
            onEditClick();
          }}
        >
          <IconEdit size={12} className="mr-0.5" />
          编辑
        </Button>
      </div>
      <div className="space-y-0.5">
        {segments.map((seg) => (
          <div
            key={seg.id}
            className={cn(
              'flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]',
              seg.sliced
                ? 'bg-green-50 dark:bg-green-950/30'
                : 'bg-muted/50'
            )}
          >
            {seg.sliced ? (
              <IconCheck
                size={12}
                className="shrink-0 text-green-600 dark:text-green-500"
              />
            ) : (
              <IconClock
                size={12}
                className="shrink-0 text-yellow-600 dark:text-yellow-500"
              />
            )}
            <span className="flex-1 truncate font-medium">{seg.name}</span>
            <span className="shrink-0 text-muted-foreground">
              {formatTime(seg.startTime)}-{formatTime(seg.endTime)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

export default SegmentList;
