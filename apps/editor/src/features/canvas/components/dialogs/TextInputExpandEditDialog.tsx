'use client';

import { memo, type RefObject } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PromptCollectionItem } from '../../types';
import type { AssetMentionCandidate } from '../../engine/promptAssetMentions';
import { PromptPresetTokenEditor, type PromptTextSurface } from '../nodes/shared/PromptPresetTokenEditor';
import { PromptPresetSlashPopover } from '../nodes/shared/PromptPresetSlashPopover';
import { PromptMentionPopover } from '../nodes/shared/PromptMentionPopover';
import { usePromptTextEditorAutoFocusOnOpen } from '../../hooks/usePromptTextEditorAutoFocusOnOpen';

type SelectionRange = { start: number; end: number };

export interface TextInputExpandEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  editorRef: RefObject<PromptTextSurface | null>;
  promptPresetSnapshots: Record<string, PromptCollectionItem> | null | undefined;
  readOnly: boolean | undefined;
  initialSelection: SelectionRange | null | undefined;
  onChange: (nextValue: string) => void;
  onCompositionStart: (() => void) | undefined;
  onCompositionEnd: (() => void) | undefined;
  onBlur: (() => void) | undefined;
  onInsertPreset: (payload: { nextValue: string; preset: PromptCollectionItem }) => void;
  promptLimit?: { max: number; current: number } | null | undefined;
  /** @ 上下文（spec：prompt内联交互）；mentionEnabled=false 时不提供 @ 触发，已有锚点经 mentionDisplay 渲染失效态 */
  mentionEnabled: boolean;
  mentionCandidates: AssetMentionCandidate[];
  mentionDisplay: ReadonlyMap<string, { label: string }>;
  onInsertMention: (payload: { nextValue: string; candidate: AssetMentionCandidate }) => void;
}

export const TextInputExpandEditDialog = memo(function TextInputExpandEditDialog({
  open,
  onOpenChange,
  value,
  editorRef,
  promptPresetSnapshots,
  readOnly = false,
  initialSelection,
  onChange,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
  onInsertPreset,
  promptLimit,
  mentionEnabled,
  mentionCandidates,
  mentionDisplay,
  onInsertMention,
}: TextInputExpandEditDialogProps) {
  const { onOpenAutoFocus } = usePromptTextEditorAutoFocusOnOpen({
    open,
    editorRef,
    initialSelection,
    maxRafAttempts: undefined,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        form="standard"
        size="wide"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <div className="flex max-h-full flex-col gap-3">
          <DialogHeader className="gap-1">
            <DialogTitle>放大编辑</DialogTitle>
            <DialogDescription>在更大的编辑区域内调整文本内容。</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <PromptPresetTokenEditor
              ref={editorRef}
              value={value}
              onChange={onChange}
              promptPresetSnapshots={promptPresetSnapshots}
              editingSessionActive={true}
              placeholder="输入文本..."
              readOnly={readOnly}
              promptLimit={promptLimit}
              containerClassName="min-h-[320px] w-full"
              mentionDisplay={mentionDisplay}
              className="min-h-[320px] w-full overflow-y-auto text-sm leading-relaxed"
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onBlur={onBlur}
            />
            <PromptPresetSlashPopover surfaceRef={editorRef} disabled={readOnly} onInsert={onInsertPreset} />
            {mentionEnabled ? (
              <PromptMentionPopover surfaceRef={editorRef} candidates={mentionCandidates} disabled={readOnly} onInsert={onInsertMention} />
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export default TextInputExpandEditDialog;
