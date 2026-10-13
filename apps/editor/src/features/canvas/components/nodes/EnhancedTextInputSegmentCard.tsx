'use client';

import { memo, type CSSProperties } from 'react';

import { IconArrowDown, IconArrowUp, IconGripVertical, IconTrash } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { PromptPresetSlashPopover } from './shared/PromptPresetSlashPopover';
import { PromptMentionPopover } from './shared/PromptMentionPopover';
import { PromptPresetTokenEditor } from './shared/PromptPresetTokenEditor';
import { useSegmentCardSortable } from './EnhancedTextInputSegmentCard.hooks';
import type { EnhancedTextInputSegmentCardProps } from './EnhancedTextInputSegmentCard.types';

/**
 * 文本段卡片 — 文本节点属性面板文本段列表的单段单元（设计文档 text-segment-interaction-design）。
 *
 * 布局：拖拽手柄（最左）+ 段落标题 + 操作组（上移/下移/开关/删除）+ contentEditable 文本面。
 * - 拖拽仅手柄可触发（整卡不可拖，避免与文本划选手势冲突）；上移/下移保留作键盘/细调兜底。
 * - 所有变更通过回调上抛，由父组件走 updateSegments 单写路径（undo + 预览联动）。
 * - readOnly 时手柄与全部操作禁用。
 */
export const EnhancedTextInputSegmentCard = memo(function EnhancedTextInputSegmentCard({
  segment,
  index,
  totalCount,
  readOnly,
  draftText,
  promptPresetSnapshots,
  mentionDisplay,
  mentionEnabled,
  mentionCandidates,
  promptLimit,
  surfaceRef,
  onToggle,
  onMove,
  onRemove,
  onDraftChange,
  onDraftChangeWithPromptPreset,
  onFocus,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
}: EnhancedTextInputSegmentCardProps) {
  const { attributes, listeners, setNodeRef, style, isDragging } = useSegmentCardSortable(
    segment.id,
    !readOnly,
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('rounded-md border p-2', isDragging && 'opacity-60')}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing disabled:cursor-default disabled:text-muted-foreground/20"
            disabled={readOnly}
            aria-label="拖拽排序文本段"
            title="拖拽排序"
            {...(readOnly ? {} : attributes)}
            {...(readOnly ? {} : listeners)}
          >
            <IconGripVertical size={16} />
          </button>
          <span className="truncate text-sm font-medium">{`段落 ${index + 1}`}</span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onMove(segment.id, -1)}
            disabled={readOnly || index === 0}
            aria-label="上移"
            title="上移"
          >
            <IconArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onMove(segment.id, 1)}
            disabled={readOnly || index === totalCount - 1}
            aria-label="下移"
            title="下移"
          >
            <IconArrowDown className="size-4" />
          </Button>

          <div className="ml-1 flex items-center gap-2">
            <Switch
              checked={segment.enabled}
              onCheckedChange={(v) => onToggle(segment.id, v)}
              disabled={readOnly}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onRemove(segment.id)}
              disabled={readOnly}
              aria-label="删除"
              title="删除"
            >
              <IconTrash className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="relative">
        <PromptPresetTokenEditor
          ref={surfaceRef}
          value={draftText}
          promptPresetSnapshots={promptPresetSnapshots}
          editingSessionActive={true}
          placeholder="输入文本..."
          readOnly={readOnly}
          promptLimit={promptLimit}
          containerClassName={undefined}
          mentionDisplay={mentionDisplay}
          style={{ fieldSizing: 'fixed' } as CSSProperties}
          onChange={(nextValue) => onDraftChange(segment.id, nextValue)}
          onFocus={() => onFocus(segment.id)}
          onBlur={() => onBlur(segment.id)}
          onCompositionStart={() => onCompositionStart(segment.id)}
          onCompositionEnd={() => onCompositionEnd(segment.id)}
          className="whitespace-pre-wrap break-words resize-y overflow-y-auto"
        />
        <PromptPresetSlashPopover
          surfaceRef={surfaceRef}
          disabled={readOnly}
          onInsert={({ nextValue, preset }) => onDraftChangeWithPromptPreset(segment.id, nextValue, preset)}
        />
        {mentionEnabled ? (
          <PromptMentionPopover
            surfaceRef={surfaceRef}
            candidates={mentionCandidates}
            disabled={readOnly}
            onInsert={({ nextValue }) => onDraftChange(segment.id, nextValue)}
          />
        ) : null}
      </div>
    </div>
  );
});
