'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconPlus } from '@tabler/icons-react';
import { Paperclip } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { usePromptDockStore } from '../promptDockStore';
import { addNodesToReferences, resolveReferenceCandidate } from '../referenceOps';
import { reassignSlot } from '../referenceSlotModel';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import { PromptDockReferenceAreaChip } from './PromptDockReferenceAreaChip';
import { PromptDockReferenceSlotBadge } from './PromptDockReferenceSlotBadge';

/**
 * 附件参考区（资产多选）。资产引用由草稿承载，不创建连线/节点。
 * chip 形态对齐原型（prototypes/shared/promptdock-refs.js）：真实媒体缩略图 +
 * 资产标签 + hover 放大预览（详见 PromptDockReferenceAreaChip）。
 * 支持：识别资产、移除参考、调整顺序（本 MVP 提供移除，顺序按加入顺序）。
 * 「加入选中」走共享操作层 referenceOps（去重 + 仅图片资产/媒体类型判定，
 * 与画布资产节点选中态底栏「用作参考」同一实现，spec PD-MR-003/004）；
 * 反馈在本面收敛为按钮行内短文案，不弹 toast。
 */

/** 行内反馈自动消失时长 */
const INLINE_NOTICE_TTL_MS = 2500;

/** 行内反馈种类：duplicate = 全部命中已有引用；unsupported = 选中项不符参考要求 */
type InlineNoticeKind = 'duplicate' | 'unsupported';

const INLINE_NOTICE_COPY: Record<InlineNoticeKind, string> = {
  duplicate: '已在参考里',
  unsupported: '当前选中不能作参考',
};

export function PromptDockReferenceArea({
  entry = null,
}: {
  entry?: PromptDockCatalogEntry | null;
}) {
  const references = usePromptDockStore((s) => s.draft.references);
  const setDraft = usePromptDockStore((s) => s.setDraft);

  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodeGraph = useCanvasStore((s) => s.nodeGraph);
  const mediaAssets = useCanvasStore((s) => s.mediaAssets);

  const [notice, setNotice] = useState<InlineNoticeKind | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedNodes = useMemo(
    () => (nodeGraph?.nodes ?? []).filter((n) => selectedNodeIds.includes(n.id)),
    [nodeGraph, selectedNodeIds],
  );

  // 候选数 = 选中且符合参考要求（复用操作层准入判定，重复引用也计入）
  const eligibleCount = useMemo(
    () =>
      selectedNodes.filter((n) => resolveReferenceCandidate(n, mediaAssets).ok).length,
    [selectedNodes, mediaAssets],
  );

  const clearNotice = useCallback(() => {
    setNotice(null);
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  const showNotice = useCallback((kind: InlineNoticeKind) => {
    setNotice(kind);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, INLINE_NOTICE_TTL_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const addSelectedAssets = useCallback(() => {
    if (selectedNodes.length === 0) return;
    const result = addNodesToReferences(selectedNodes);
    // 不可访问资产（已删除等罕见情形）：debug 留痕 + 静默跳过，不进行内反馈。
    for (const rejected of result.rejected) {
      if (rejected.kind === 'asset-unavailable') {
        console.debug(
          '[PromptDockReferenceArea] 不可访问的素材已跳过加入参考',
          rejected.label,
        );
      }
    }
    if (result.kind === 'added') {
      // 部分有效同批只加有效项：chip 数量变化即反馈，不再提示。
      clearNotice();
      return;
    }
    if (result.kind === 'duplicate') {
      showNotice('duplicate');
      return;
    }
    // 全部不符且无新增：存在真实类型不符才提示；纯不可访问已留痕静默。
    if (result.rejected.some((rejected) => rejected.kind === 'media-unsupported')) {
      showNotice('unsupported');
    } else {
      clearNotice();
    }
  }, [selectedNodes, clearNotice, showNotice]);

  const selectSlot = useCallback(
    (refId: string, slotId: string | null) => {
      setDraft({ references: reassignSlot(references, refId, slotId, entry) });
    },
    [references, setDraft, entry],
  );

  const removeReference = useCallback(
    (refId: string) => {
      setDraft({ references: references.filter((r) => r.refId !== refId) });
    },
    [references, setDraft],
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="promptdock-reference-area">
      <span
        role="img"
        aria-label="参考素材"
        className="flex items-center text-muted-foreground"
      >
        <Paperclip size={14} aria-hidden="true" />
      </span>
      {references.map((ref) => (
        <span key={ref.refId} className="inline-flex items-center gap-1">
          <PromptDockReferenceAreaChip reference={ref} onRemove={removeReference} />
          <PromptDockReferenceSlotBadge
            reference={ref}
            references={references}
            entry={entry}
            onSelect={selectSlot}
          />
        </span>
      ))}
      <Button
        variant="ghost"
        size="2xs"
        className="gap-1"
        onClick={addSelectedAssets}
        disabled={eligibleCount === 0}
        title={eligibleCount === 0 ? '在画布选中素材后可加入' : undefined}
        data-testid="promptdock-add-references"
      >
        <IconPlus size={14} />
        {eligibleCount > 0 ? `加入选中 (${eligibleCount})` : '加入选中'}
      </Button>
      <span aria-live="polite" className="text-[11px] whitespace-nowrap text-(--st-failed-text)">
        {notice !== null ? INLINE_NOTICE_COPY[notice] : ''}
      </span>
    </div>
  );
}
