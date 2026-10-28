'use client';

import { useMemo } from 'react';
import { Check } from 'lucide-react';
import type { ExecutableCatalogMediaSlot } from '@iart/contracts';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import type { PromptDockReference } from '../PromptDock.types';
import { candidateSlots, slotIdOf, slotIsMulti, slotOccupant } from '../referenceSlotModel';

/**
 * 参考 chip 上的「用途」徽章与用途菜单（设计 §4.1 / §4.2 / §4.4 / §4.6）。
 *
 * 四档状态：
 * - 模型无该媒体类型的候选位 → 不渲染徽章（由既有「不兼容参考」承载）；
 * - 唯一候选 → 只显示文本、不可点；
 * - 唯一候选但当前用途「用不了」（模型切换后原用途不存在）→ 必须可点，否则无出路；
 * - ≥2 候选 → 可点，打开菜单。
 *
 * 菜单里已被另一张占用的单张用途标注「已用于另一张」但**不禁选**（选中即换绑，§4.4）。
 * 多张用途已放满时标注「已满 N 张」并禁用——多张位没有「挤掉哪一张」的合理答案，硬塞会让
 * 提交时超额（§4.7）。
 * 界面不印解释段落：徽章可点、菜单项自带占用标注，用户看得到下一步。
 */

type PromptDockReferenceSlotBadgeProps = {
  reference: PromptDockReference;
  references: readonly PromptDockReference[];
  entry: PromptDockCatalogEntry | null | undefined;
  onSelect: (refId: string, slotId: string | null) => void;
};

/** 当前用途的展示文本：有值取该位标签；无候选位时不显示徽章。 */
const slotLabelOf = (
  slots: readonly ExecutableCatalogMediaSlot[],
  slotId: string | null,
): string | null => {
  if (slotId === null) return null;
  const slot = slots.find((candidate) => candidate.slotId === slotId);
  if (slot === undefined) return null;
  return slot.label.length > 0 ? slot.label : slot.fieldKey;
};

export function PromptDockReferenceSlotBadge({
  reference,
  references,
  entry,
  onSelect,
}: PromptDockReferenceSlotBadgeProps) {
  const slots = useMemo(
    () => candidateSlots(entry, reference.mediaType),
    [entry, reference.mediaType],
  );

  if (slots.length === 0) return null;

  const currentSlotId = slotIdOf(reference);
  const currentLabel = slotLabelOf(slots, currentSlotId);
  const isUnspecified = currentSlotId === null;
  // 「用不了」= 之前有用途，但当前模型没有这个位了（模型切换后的存量引用）。
  const isUnusable = currentSlotId !== null && currentLabel === null;
  // 唯一候选且当前用途有效 → 无需选择；其余情况都要能点（尤其「用不了」必须留出路）。
  const clickable = slots.length > 1 || isUnspecified || isUnusable;

  const text = isUnspecified ? '未指定用途' : (currentLabel ?? '用不了');
  const ariaLabel = isUnspecified
    ? `为「${reference.label}」指定用途`
    : isUnusable
      ? `「${reference.label}」的用途用不了，点开可改`
      : `「${reference.label}」的用途：${text}，点开可改`;

  const badgeClass = cn(
    'inline-flex h-5 items-center gap-0.5 rounded-md px-1 text-[10px] whitespace-nowrap',
    // 未指定是「待办」不是「失败」：用待办强调色，不用失败红（§4.6）。
    isUnspecified && 'bg-(--st-pending-bg) text-(--st-pending-text)',
    isUnusable && 'bg-(--st-failed-bg) text-(--st-failed-text)',
    !isUnspecified && !isUnusable && 'bg-secondary text-muted-foreground',
  );

  if (!clickable) {
    return (
      <span className={badgeClass} data-testid={`promptdock-slot-${reference.refId}`}>
        {text}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(badgeClass, 'hover:brightness-110')}
          aria-label={ariaLabel}
          data-testid={`promptdock-slot-${reference.refId}`}
        >
          {text}
          <span aria-hidden="true">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-44 p-1">
        <div className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">用途</div>
        <div role="listbox" aria-label={`为「${reference.label}」选择用途`}>
          {slots.map((slot) => {
            const occupant = slotOccupant(
              references.filter((other) => other.refId !== reference.refId),
              slot,
            );
            const selected = slot.slotId === currentSlotId;
            const label = slot.label.length > 0 ? slot.label : slot.fieldKey;
            // 多张位的余量按「已绑定条数 vs 声明张数」判；单张位的占用走既有换绑语义（不禁选）。
            const boundCount = references.filter((other) => slotIdOf(other) === slot.slotId).length;
            const atCapacity = slotIsMulti(slot) && boundCount >= slot.maxFiles && !selected;
            return (
              <button
                key={slot.slotId}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={atCapacity}
                aria-label={
                  atCapacity
                    ? `${label}（已满 ${slot.maxFiles} 张）`
                    : occupant === null
                      ? label
                      : `${label}（已用于另一张，选择后会换绑）`
                }
                onClick={() => onSelect(reference.refId, slot.slotId)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px]',
                  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                  selected
                    ? 'bg-accent text-accent-foreground font-medium hover:bg-accent'
                    : 'hover:bg-foreground/5',
                )}
                data-testid={`promptdock-slot-option-${slot.slotId}`}
              >
                <span aria-hidden="true" className="w-3 shrink-0">
                  {selected ? <Check size={11} /> : null}
                </span>
                <span className="truncate">{label}</span>
                {atCapacity ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    已满 {slot.maxFiles} 张
                  </span>
                ) : occupant !== null ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    已用于另一张
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
