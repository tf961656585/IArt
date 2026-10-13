'use client';

import { createRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { IconPlus } from '@tabler/icons-react';

import type {
  PromptCollectionItem,
  TextInputNodeData,
  TextInputSegment,
  TextInputSeparatorPreset,
} from '../../types';
import {
  composeEnhancedTextInput,
  createLocalTextSegment,
  prunePromptPresetSnapshots,
} from '../../nodes/textInput/enhancedTextNode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useTextNodeMentionContext } from './shared/useTextNodeMentionContext';
import type { PromptTextSurface } from './shared/PromptPresetTokenEditor';
import { countPromptCharacters } from '../../nodes/textInput/promptLengthLimit';
import { EnhancedTextInputSegmentCard } from './EnhancedTextInputSegmentCard';

const EMPTY_SEGMENTS: TextInputSegment[] = [];

function segmentKey(segment: TextInputSegment): string {
  return `local:${segment.id}`;
}

function moveItem<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return list;
  const next = [...list];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return list;
  next.splice(toIndex, 0, item);
  return next;
}

function ensureAtLeastOneLocal(segments: TextInputSegment[]): TextInputSegment[] {
  if (segments.some((s) => s.kind === 'local')) return segments;
  return [createLocalTextSegment(''), ...segments];
}

export interface EnhancedTextInputEditorProps {
  nodeId: string;
  data: TextInputNodeData;
  onUpdate: (patch: Partial<TextInputNodeData>) => void;
  readOnly: boolean | undefined;
  layout: 'horizontal' | 'vertical' | undefined;
  className: string | undefined;
}

export const EnhancedTextInputEditor = memo(function EnhancedTextInputEditor({
  nodeId,
  data,
  onUpdate,
  readOnly = false,
  layout = 'horizontal',
  className,
}: EnhancedTextInputEditorProps) {
  const segments = data.segments ?? EMPTY_SEGMENTS;
  const [draftByLocalId, setDraftByLocalId] = useState<Record<string, string>>({});
  const composingIdSetRef = useRef<Set<string>>(new Set());
  const focusedLocalIdRef = useRef<string | null>(null);
  const committedTextByLocalIdRef = useRef<Record<string, string>>({});
  const surfaceRefByLocalIdRef = useRef<Record<string, React.RefObject<PromptTextSurface | null>>>({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const getLocalSurfaceRef = useCallback((localId: string) => {
    const existing = surfaceRefByLocalIdRef.current[localId];
    if (existing) return existing;
    const next = createRef<PromptTextSurface>();
    surfaceRefByLocalIdRef.current[localId] = next;
    return next;
  }, []);

  const composed = useMemo(
    () => composeEnhancedTextInput({ data, options: undefined }),
    [data],
  );

  // @ 上下文（spec：prompt内联交互）：前提满足时提供 @ 触发；
  // 不满足时 mentionDisplay 为空表，已有 [[@asset:]] token 渲染失效态
  const {
    mentionEnabled,
    candidates: mentionCandidates,
    mentionDisplay,
  } = useTextNodeMentionContext(nodeId);
  const composedCharCount = useMemo(() => countPromptCharacters(composed), [composed]);

  // 外部数据变更时（撤销/重做/脚本修改/连线同步/拖拽重排），同步本地草稿，但不打断正在输入的光标/输入法状态
  useEffect(() => {
    const committed = committedTextByLocalIdRef.current;
    const localIds: string[] = [];

    for (const seg of segments) {
      if (seg.kind !== 'local') continue;
      localIds.push(seg.id);
      committed[seg.id] = seg.text;
    }

    const alive = new Set(localIds);
    for (const key of Object.keys(committed)) {
      if (!alive.has(key)) {
        delete committed[key];
      }
    }

    setDraftByLocalId((prev) => {
      let changed = false;
      const next: Record<string, string> = {};

      for (const seg of segments) {
        if (seg.kind !== 'local') continue;
        const id = seg.id;
        const isActive = focusedLocalIdRef.current === id || composingIdSetRef.current.has(id);
        const desired = isActive ? (prev[id] ?? seg.text) : seg.text;
        next[id] = desired;
        if (prev[id] !== desired) changed = true;
      }

      if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
      return next;
    });
  }, [segments]);

  const updateSegments = useCallback(
    (
      next: TextInputSegment[],
      options: { promptPresetSnapshots: TextInputNodeData['promptPresetSnapshots'] | undefined } | undefined = undefined,
    ) => {
      if (readOnly) return;
      const baseSnapshots = (options !== null && options !== undefined ? options.promptPresetSnapshots : undefined) ?? data.promptPresetSnapshots;
      const promptPresetSnapshots = prunePromptPresetSnapshots({
        segments: next,
        promptPresetSnapshots: baseSnapshots ?? null,
      });
      onUpdate({
        segments: ensureAtLeastOneLocal(next),
        ...(promptPresetSnapshots ? { promptPresetSnapshots } : {}),
      });
    },
    [data.promptPresetSnapshots, onUpdate, readOnly],
  );

  const handleAddLocalSegment = useCallback(() => {
    if (readOnly) return;
    updateSegments([...segments, createLocalTextSegment('')]);
  }, [readOnly, segments, updateSegments]);

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      if (readOnly) return;
      const next = segments.map((seg) => (seg.id === id ? { ...seg, enabled } : seg));
      updateSegments(next);
    },
    [readOnly, segments, updateSegments],
  );

  const handleLocalTextChange = useCallback(
    (id: string, text: string) => {
      if (readOnly) return;
      if (committedTextByLocalIdRef.current[id] === text) return;
      committedTextByLocalIdRef.current[id] = text;
      const next = segments.map((seg) => {
        if (seg.kind !== 'local') return seg;
        if (seg.id !== id) return seg;
        return { ...seg, text };
      });
      updateSegments(next);
    },
    [readOnly, segments, updateSegments],
  );

  const handleLocalTextChangeWithPromptPreset = useCallback(
    (id: string, text: string, presetSnapshot: PromptCollectionItem) => {
      if (readOnly) return;
      committedTextByLocalIdRef.current[id] = text;
      const nextSegments = segments.map((seg) => {
        if (seg.kind !== 'local') return seg;
        if (seg.id !== id) return seg;
        return { ...seg, text };
      });
      const base = data.promptPresetSnapshots ?? {};
      const merged = (presetSnapshot !== null && presetSnapshot !== undefined ? presetSnapshot.id : undefined) ? { ...base, [presetSnapshot.id]: presetSnapshot } : base;
      updateSegments(nextSegments, { promptPresetSnapshots: merged });
    },
    [data.promptPresetSnapshots, readOnly, segments, updateSegments],
  );

  const handleLocalDraftChange = useCallback(
    (id: string, text: string) => {
      if (readOnly) return;
      setDraftByLocalId((prev) => (prev[id] === text ? prev : { ...prev, [id]: text }));
      if (composingIdSetRef.current.has(id)) return;
      handleLocalTextChange(id, text);
    },
    [handleLocalTextChange, readOnly],
  );

  const handleLocalDraftChangeWithPromptPreset = useCallback(
    (id: string, text: string, presetSnapshot: PromptCollectionItem) => {
      if (readOnly) return;
      setDraftByLocalId((prev) => (prev[id] === text ? prev : { ...prev, [id]: text }));
      handleLocalTextChangeWithPromptPreset(id, text, presetSnapshot);
    },
    [handleLocalTextChangeWithPromptPreset, readOnly],
  );

  const handleRemoveLocal = useCallback(
    (id: string) => {
      if (readOnly) return;
      const next = segments.filter((seg) => !(seg.kind === 'local' && seg.id === id));
      updateSegments(next);
    },
    [readOnly, segments, updateSegments],
  );

  const handleMove = useCallback(
    (id: string, direction: -1 | 1) => {
      if (readOnly) return;
      const fromIndex = segments.findIndex((seg) => seg.id === id);
      if (fromIndex < 0) return;
      const toIndex = fromIndex + direction;
      if (toIndex < 0 || toIndex >= segments.length) return;
      updateSegments(moveItem(segments, fromIndex, toIndex));
    },
    [readOnly, segments, updateSegments],
  );

  // 拖拽排序（设计文档 text-segment-interaction-design）：只改数组顺序，走 updateSegments 单写路径，
  // 复用 timeline 已验证的 dnd-kit 组合，但无时间轴领域逻辑。
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (readOnly) return;
      const { active, over } = event;
      if (over === null || active.id === over.id) return;
      const oldIndex = segments.findIndex((s) => s.id === active.id);
      const newIndex = segments.findIndex((s) => s.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      updateSegments(arrayMove(segments, oldIndex, newIndex));
    },
    [readOnly, segments, updateSegments],
  );

  return (
    <div className={cn('flex gap-4', layout === 'vertical' && 'flex-col', className)}>
      {/* 左侧编辑区域 */}
      <div className="flex-1 min-w-0 space-y-4">
        <div className="space-y-2">
          <Label>文本段</Label>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={segments.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {segments.map((seg, index) => (
                  <EnhancedTextInputSegmentCard
                    key={segmentKey(seg)}
                    segment={seg}
                    index={index}
                    totalCount={segments.length}
                    readOnly={readOnly}
                    draftText={draftByLocalId[seg.id] ?? seg.text}
                    promptPresetSnapshots={data.promptPresetSnapshots ?? null}
                    mentionEnabled={mentionEnabled}
                    mentionCandidates={mentionCandidates}
                    mentionDisplay={mentionDisplay}
                    surfaceRef={getLocalSurfaceRef(seg.id)}
                    onToggle={handleToggle}
                    onMove={handleMove}
                    onRemove={handleRemoveLocal}
                    onDraftChange={handleLocalDraftChange}
                    onDraftChangeWithPromptPreset={handleLocalDraftChangeWithPromptPreset}
                    onFocus={(id) => {
                      focusedLocalIdRef.current = id;
                    }}
                    onBlur={(id) => {
                      if (focusedLocalIdRef.current === id) {
                        focusedLocalIdRef.current = null;
                      }
                      if (composingIdSetRef.current.has(id)) return;
                      handleLocalTextChange(id, draftByLocalId[id] ?? segments.find((s) => s.id === id)?.text ?? '');
                    }}
                    onCompositionStart={(id) => {
                      composingIdSetRef.current.add(id);
                    }}
                    onCompositionEnd={(id) => {
                      composingIdSetRef.current.delete(id);
                      const surface = getLocalSurfaceRef(id).current;
                      const nextValue = surface !== null && surface !== undefined
                        ? surface.getValue()
                        : draftByLocalId[id] ?? segments.find((s) => s.id === id)?.text ?? '';
                      handleLocalDraftChange(id, nextValue);
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <div className="pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={handleAddLocalSegment} disabled={readOnly}>
              <IconPlus className="mr-1 size-4" />
              新增文本段
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label>分隔符</Label>
          <Select
            value={data.separator ?? 'comma'}
            disabled={readOnly}
            onValueChange={(value) => onUpdate({ separator: value as TextInputSeparatorPreset })}
          >
            <SelectTrigger size="default">
              <SelectValue placeholder="选择分隔符" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comma">逗号 + 空格（默认）</SelectItem>
              <SelectItem value="space">空格</SelectItem>
              <SelectItem value="newline">换行</SelectItem>
              <SelectItem value="doubleNewline">双换行</SelectItem>
              <SelectItem value="none">无</SelectItem>
              <SelectItem value="custom">自定义</SelectItem>
            </SelectContent>
          </Select>

          {data.separator === 'custom' && (
            <Input
              value={data.customSeparator ?? ''}
              onChange={(event) => onUpdate({ customSeparator: event.target.value })}
              placeholder="例如：;  或  | "
              disabled={readOnly}
            />
          )}
        </div>
      </div>

      {/* 右侧预览区域 */}
      <div className={cn('space-y-2', layout === 'vertical' ? 'w-full' : 'w-64 shrink-0')}>
        <Label className="text-muted-foreground">最终输出预览</Label>
        <div className="h-full min-h-[200px] rounded-md border bg-muted/30 p-3">
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {composed || '（还没有内容）'}
          </p>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>拼接已开启段落</span>
          <span>
            {composedCharCount} 字符
          </span>
        </div>
      </div>
    </div>
  );
});
