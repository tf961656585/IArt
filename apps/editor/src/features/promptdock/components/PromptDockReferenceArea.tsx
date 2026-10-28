'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconPlus } from '@tabler/icons-react';
import { Paperclip } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { usePromptDockStore } from '../promptDockStore';
import {
  addNodesToReferences,
  resolveReferenceAdmission,
} from '../referenceOps';
import { reassignSlot } from '../referenceSlotModel';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import { PromptDockReferenceAreaChip } from './PromptDockReferenceAreaChip';
import { PromptDockReferenceSlotBadge } from './PromptDockReferenceSlotBadge';

/**
 * 附件参考区（资产多选）。资产引用由草稿承载，不创建连线/节点。
 * chip 形态对齐原型（prototypes/shared/promptdock-refs.js）：真实媒体缩略图 +
 * 资产标签 + hover 放大预览（详见 PromptDockReferenceAreaChip）。
 * 支持：识别资产、移除参考、调整顺序（本 MVP 提供移除，顺序按加入顺序）。
 * 「加入选中」走共享操作层 referenceOps（去重 + 当前模型媒体能力/参考位余量准入，
 * 与画布素材选中态底栏「用作参考」同一实现，spec PD-MR-003/004）；
 * 反馈在本面收敛为按钮行内短文案，不弹 toast。
 */

/** 行内反馈自动消失时长 */
const INLINE_NOTICE_TTL_MS = 2500;

/** 固定的行内反馈文案（容量类文案随结果携带，不走这两个常量）。 */
const NOTICE_DUPLICATE = '已在参考里';
const NOTICE_UNSUPPORTED = '当前选中不能作参考';

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

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedNodes = useMemo(
    () => (nodeGraph?.nodes ?? []).filter((n) => selectedNodeIds.includes(n.id)),
    [nodeGraph, selectedNodeIds],
  );

  // 逐项准入预判（与「加入选中」共用同一判定）：当前模型接受该媒体类型 + 该类型参考位有余量。
  // 重复引用直接放行（由合并层记「已在参考里」）。
  const admissions = useMemo(
    () =>
      selectedNodes.map((node) => ({
        node,
        admission: resolveReferenceAdmission({ node, mediaAssets, entry, references }),
      })),
    [selectedNodes, mediaAssets, entry, references],
  );

  const eligibleCount = useMemo(
    () => admissions.filter(({ admission }) => admission.ok).length,
    [admissions],
  );

  // 有选中但一项都加不进去时，把第一项被拒原因挂在禁用按钮上（否则用户只看到一个灰按钮）。
  const blockedReason = useMemo(() => {
    if (eligibleCount > 0) return undefined;
    for (const { admission } of admissions) {
      if (!admission.ok) return admission.reason;
    }
    return undefined;
  }, [admissions, eligibleCount]);

  const clearNotice = useCallback(() => {
    setNotice(null);
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
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
      // 例外是容量不足——用户会以为整批都加进去了，必须说明超量的那几张没加入。
      const capacityRejection = result.rejected.find(
        (rejected) => rejected.kind === 'slot-capacity-exceeded',
      );
      if (capacityRejection !== undefined) {
        showNotice(capacityRejection.reason);
        return;
      }
      clearNotice();
      return;
    }
    if (result.kind === 'duplicate') {
      showNotice(NOTICE_DUPLICATE);
      return;
    }
    // 全部不符且无新增：存在媒体不支持才提示（文案由准入层按模型能力给出，
    // 如「当前模型不支持视频参考」）；纯不可访问已留痕静默。
    const unsupported = result.rejected.find(
      (rejected) => rejected.kind === 'media-unsupported',
    );
    if (unsupported !== undefined) {
      showNotice(unsupported.reason.length > 0 ? unsupported.reason : NOTICE_UNSUPPORTED);
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
        title={
          eligibleCount === 0
            ? (blockedReason ?? '在画布选中素材后可加入')
            : undefined
        }
        data-testid="promptdock-add-references"
      >
        <IconPlus size={14} />
        {eligibleCount > 0 ? `加入选中 (${eligibleCount})` : '加入选中'}
      </Button>
      <span aria-live="polite" className="text-[11px] whitespace-nowrap text-(--st-failed-text)">
        {notice ?? ''}
      </span>
    </div>
  );
}
