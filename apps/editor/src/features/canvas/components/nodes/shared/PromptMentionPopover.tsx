'use client';

import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { PromptTextSurface } from './promptTextSurface';
import {
  usePromptTriggerSuggestion,
  type TriggerMatch,
} from './usePromptTriggerSuggestion';
import {
  assetMentionTokenOf,
  type AssetMentionCandidate,
} from '../../../engine/promptAssetMentions';

const normalizeQuery = (value: string): string => value.trim().toLowerCase();

/** @ 触发匹配：仅在行首/空白后触发；光标前存在更近的 / 时让位给 slash（互斥规则）。 */
export const findMentionMatch = (text: string, cursor: number): TriggerMatch | null => {
  const safeCursor = Math.max(0, Math.min(text.length, cursor));
  const atIndex = text.lastIndexOf('@', safeCursor - 1);
  if (atIndex < 0) return null;

  // 分隔符触发：仅在行首/空白后触发（避免 email/路径误触发）
  if (atIndex > 0 && !/\s/.test(text[atIndex - 1] ?? '')) return null;

  // 避免与 / slash 同时触发：若光标前存在更靠近的 /，交由 slash 处理
  const slashIndex = text.lastIndexOf('/', safeCursor - 1);
  if (slashIndex > atIndex) return null;

  const query = text.slice(atIndex + 1, safeCursor);
  if (!query && safeCursor === atIndex + 1) {
    return { triggerIndex: atIndex, cursor: safeCursor, query: '' };
  }
  if (/\s/.test(query)) return null;
  return { triggerIndex: atIndex, cursor: safeCursor, query };
};

/**
 * prompt 编辑面的 @ 素材引用候选弹层（spec：docs/editor/prompt内联交互.md）。
 *
 * 候选由调用方注入（模型节点 Inspector：该节点已连线素材；文本输入节点：所有符合
 * 条件的下游消费节点已连线素材并集），弹层本身不推导候选来源；选中插入
 * `[[@asset:<assetId>]]` token（身份绑定），显示编号由编辑器执行期派生。
 * 触发/定位/键盘导航与 / 预设弹层共用 usePromptTriggerSuggestion，禁止另写一套。
 */
export function PromptMentionPopover({
  surfaceRef,
  candidates,
  disabled,
  onInsert,
}: {
  surfaceRef: React.RefObject<PromptTextSurface | null>;
  /** @ 候选集合（调用方按编辑面身份推导后注入） */
  candidates: AssetMentionCandidate[];
  disabled: boolean | undefined;
  onInsert: (payload: { nextValue: string; candidate: AssetMentionCandidate }) => void;
}) {
  const filterCandidates = useCallback(
    (all: AssetMentionCandidate[], query: string) => {
      const q = normalizeQuery(query);
      if (!q) return all;
      return all.filter((candidate) => candidate.label.toLowerCase().includes(q));
    },
    [],
  );

  const buildInsertText = useCallback(
    (candidate: AssetMentionCandidate) => `${assetMentionTokenOf(candidate.assetId)} `,
    [],
  );

  const handlePick = useCallback(
    (candidate: AssetMentionCandidate, nextValue: string) => {
      onInsert({ nextValue, candidate });
    },
    [onInsert],
  );

  const {
    open,
    panelPosition,
    panelRef,
    activeQuery,
    filteredCandidates,
    activeIndex,
    setItemRef,
    handlePanelPointerMove,
    pick,
  } = usePromptTriggerSuggestion<AssetMentionCandidate>({
    surfaceRef,
    disabled: disabled === true,
    kind: 'mention',
    findMatch: findMentionMatch,
    candidates,
    filterCandidates,
    buildInsertText,
    onPick: handlePick,
    panelSize: { width: 360, height: 280 },
  });

  if (!open || !panelPosition) {
    return null;
  }

  const emptyText = activeQuery ? '没有匹配的素材' : '画布上还没有可引用的素材';

  const panel = (
    <div
      ref={panelRef}
      role="button"
      tabIndex={-1}
      aria-label="可引用素材"
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
        // 受控 value 把 cmdk 内部选中态钉在与 activeIndex 同一项上（assetId 唯一）：
        // cmdk Item 会用自己的内部选中态覆盖消费方传入的 data-selected，若放任其内部
        // 自管，键盘移动 activeIndex 后旧项仍挂着 data-selected 高亮（双高亮/高亮不跟随）。
        // 可见高亮的权威来源是下面的 data-active 绑定；此 value 只负责消除陈旧高亮。
        value={filteredCandidates[activeIndex]?.assetId ?? ''}
      >
        <CommandList className="max-h-[280px]">
          <CommandEmpty>{emptyText}</CommandEmpty>
          <CommandGroup heading="可引用素材">
            {filteredCandidates.map((candidate, index) => (
              <CommandItem
                key={candidate.assetId}
                value={candidate.assetId}
                data-active={index === activeIndex ? 'true' : undefined}
                data-candidate-index={index}
                ref={(element) => setItemRef(index, element)}
                onSelect={() => pick(candidate)}
                className="data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
              >
                <span className="truncate font-mono">@{candidate.label}</span>
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

export default PromptMentionPopover;
