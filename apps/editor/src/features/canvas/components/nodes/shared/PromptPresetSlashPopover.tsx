'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { PromptCollectionStore } from '../../../services/promptCollectionStore';
import type { PromptCollectionItem } from '../../../types/promptCollection';
import type { PromptTextSurface } from './promptTextSurface';
import {
  usePromptTriggerSuggestion,
  type TriggerMatch,
} from './usePromptTriggerSuggestion';

const normalizeQuery = (value: string): string => value.trim().toLowerCase();

/** / 触发匹配：仅在行首/空白后触发；光标前存在更近的 @ 时让位给 mention（互斥规则）。 */
export const findSlashMatch = (text: string, cursor: number): TriggerMatch | null => {
  const safeCursor = Math.max(0, Math.min(text.length, cursor));
  const slashIndex = text.lastIndexOf('/', safeCursor - 1);
  if (slashIndex < 0) return null;

  // D1=B：仅在行首/空白后触发（对齐 @ 的“分隔符触发”直觉，避免 URL/路径误触发）
  if (slashIndex > 0 && !/\s/.test(text[slashIndex - 1] ?? '')) return null;

  // 避免与 @ mention 同时触发：若光标前存在更靠近的 @，交由 mention 处理。
  const atIndex = text.lastIndexOf('@', safeCursor - 1);
  if (atIndex > slashIndex) return null;

  const query = text.slice(slashIndex + 1, safeCursor);
  if (!query && safeCursor === slashIndex + 1) {
    return { triggerIndex: slashIndex, cursor: safeCursor, query: '' };
  }
  // 遇到空白或换行则视为不是 slash 场景
  if (/\s/.test(query)) return null;
  return { triggerIndex: slashIndex, cursor: safeCursor, query };
};

const truncateContent = (content: string, maxLength = 90) => {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '...';
};

export function PromptPresetSlashPopover({
  surfaceRef,
  disabled,
  onInsert,
}: {
  surfaceRef: React.RefObject<PromptTextSurface | null>;
  disabled: boolean | undefined;
  onInsert: (payload: { nextValue: string; preset: PromptCollectionItem }) => void;
}) {
  const [presets, setPresets] = useState<PromptCollectionItem[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadPresets = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const all = await PromptCollectionStore.getAll(undefined);
      setPresets(all);
      setError(null);
      setHasLoaded(true);
    } catch (e) {
      setPresets([]);
      setError(e instanceof Error ? e : new Error(String(e)));
      setHasLoaded(true);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  const filterPresets = useCallback(
    (all: PromptCollectionItem[], query: string) => {
      // D2=A：仅按名称过滤
      const q = normalizeQuery(query);
      if (!q) return all;
      return all.filter((item) => item.name.toLowerCase().includes(q));
    },
    [],
  );

  const buildInsertText = useCallback(
    (preset: PromptCollectionItem) => `[[pp:${preset.id}]] `,
    [],
  );

  // 避免出现 `//` 残留：若光标后紧跟另一个 /，一并替换掉
  const adjustReplaceRange = useCallback(
    (value: string, match: TriggerMatch) => ({
      start: match.triggerIndex,
      end: value[match.cursor] === '/' ? match.cursor + 1 : match.cursor,
    }),
    [],
  );

  const handlePick = useCallback(
    (preset: PromptCollectionItem, nextValue: string) => {
      onInsert({ nextValue, preset });
    },
    [onInsert],
  );

  const {
    open,
    panelPosition,
    panelRef,
    activeQuery,
    filteredCandidates: filteredPresets,
    activeIndex,
    setItemRef,
    handlePanelPointerMove,
    pick,
  } = usePromptTriggerSuggestion<PromptCollectionItem>({
    surfaceRef,
    disabled,
    kind: 'pp',
    findMatch: findSlashMatch,
    candidates: presets,
    filterCandidates: filterPresets,
    buildInsertText,
    adjustReplaceRange,
    onPick: handlePick,
    panelSize: { width: 360, height: 320 },
  });

  useEffect(() => {
    if (!open) {
      // 关闭后重置加载态，下次打开重新拉取（与原实现一致）
      setHasLoaded(false);
      setError(null);
      return;
    }
    if (disabled) return;
    if (hasLoaded) return;
    void loadPresets();
  }, [disabled, hasLoaded, loadPresets, open]);

  const emptyText = useMemo(() => {
    if (error) return '预设没能加载出来，请重试';
    if (!hasLoaded || isLoading) return '加载中...';
    return activeQuery ? '没有匹配的预设' : '还没有预设，先去提示词收藏里添加';
  }, [activeQuery, error, hasLoaded, isLoading]);

  if (!open || !panelPosition) {
    return null;
  }

  const panel = (
    <div
      ref={panelRef}
      role="button"
      tabIndex={-1}
      aria-label="提示词预设"
      className={cn(
        'fixed z-popover pointer-events-auto',
        'w-[360px] rounded-md border bg-popover text-popover-foreground shadow-lg',
        'animate-in fade-in-0 zoom-in-95',
      )}
      style={{ left: panelPosition.left, top: panelPosition.top }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerMove={handlePanelPointerMove}
    >
      <Command
        // 受控 value 把 cmdk 内部选中态钉在与 activeIndex 同一项上（id 唯一）：
        // cmdk Item 会用自己的内部选中态覆盖消费方传入的 data-selected，若放任其内部
        // 自管，键盘移动 activeIndex 后旧项仍挂着 data-selected 高亮（双高亮/高亮不跟随）。
        // 可见高亮的权威来源是下面的 data-active 绑定；此 value 只负责消除陈旧高亮。
        value={filteredPresets[activeIndex]?.id ?? ''}
      >
        <CommandList className="max-h-[320px]">
          <CommandEmpty>{emptyText}</CommandEmpty>
          <CommandGroup heading="提示词预设">
            {filteredPresets.map((preset, index) => (
              <CommandItem
                key={preset.id}
                value={preset.id}
                data-active={index === activeIndex ? 'true' : undefined}
                data-candidate-index={index}
                ref={(element) => setItemRef(index, element)}
                onSelect={() => pick(preset)}
                className="data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="truncate font-mono">/{preset.name}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">
                    {truncateContent(preset.content)}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(panel, document.body);
}

export default PromptPresetSlashPopover;
