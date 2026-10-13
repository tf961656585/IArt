'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useListNavigation, useOverlayLayer } from '@iart/ui';
import {
  getTextareaCaretViewportRect,
  getContentEditableCaretViewportRect,
  resolvePopoverPosition,
  type ViewportRect,
} from './textareaPopoverPosition';
import type { PromptTextSurface } from './promptTextSurface';

type PanelPosition = { left: number; top: number };

/**
 * 候选项悬停同步用的自定义属性（挂在每个候选列表项上，值为渲染下标）。
 *
 * 必须走「面板级 onPointerMove 委托 + 自有 data 属性」而不能把 onPointerMove 直接传给
 * cmdk 的 CommandItem：cmdk Item 渲染时会在展开消费方 props 之后硬编码自己的
 * onPointerMove（内部选中态 S）与 data-selected，同名 prop 一律被覆盖。data-active
 * 等非冲突属性可以安全透传。
 */
export const CANDIDATE_INDEX_ATTRIBUTE = 'data-candidate-index';

/** 触发字符（@ 或 /）匹配结果：triggerIndex 为触发符位置，cursor 为光标，query 为触发符后的过滤串。 */
export type TriggerMatch = {
  triggerIndex: number;
  cursor: number;
  query: string;
};

/**
 * prompt 编辑面触发式候选弹层共享 hook（@ 资产引用与 / 提示词预设共用）。
 *
 * 承载：触发匹配 → 弹层定位 → 键盘导航（收编统一基元 useListNavigation：ArrowUp/Down 循环、
 * Home/End、Enter/Tab 选中、Shift+Enter 让位换行、IME 组合期让位；Escape 仍走浮层栈）
 * → 选中断言替换（含 suppressNextInput 与光标复位）→ suggestionOpen 槽位同步
 * （与 PromptPresetTokenEditor 的 Enter 让位判定联动）。两个触发在同一编辑面共存时，
 * 由各自 findMatch 的「更近触发符让位」规则保证互斥，不在这里做跨触发状态协调。
 */
export function usePromptTriggerSuggestion<TCandidate>(params: {
  surfaceRef: React.RefObject<PromptTextSurface | null>;
  disabled: boolean | undefined;
  /** suggestion 槽位（pp / mention），与 PromptTextSurface.setSuggestionOpen 对齐 */
  kind: 'pp' | 'mention';
  findMatch: (text: string, cursor: number) => TriggerMatch | null;
  /** 全量候选（未按 query 过滤） */
  candidates: TCandidate[];
  filterCandidates: (candidates: TCandidate[], query: string) => TCandidate[];
  /** 选中候选项后插入的文本（token 字面量，含必要的尾随空格） */
  buildInsertText: (candidate: TCandidate) => string;
  /** 自定义替换区间（默认替换 [triggerIndex, cursor)） */
  adjustReplaceRange?: (value: string, match: TriggerMatch) => { start: number; end: number };
  onPick: (candidate: TCandidate, nextValue: string) => void;
  panelSize: { width: number; height: number };
}) {
  const {
    surfaceRef,
    disabled,
    kind,
    findMatch,
    candidates,
    filterCandidates,
    buildInsertText,
    adjustReplaceRange,
    onPick,
    panelSize,
  } = params;

  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRectRef = useRef<ViewportRect | null>(null);

  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const [activeMatch, setActiveMatch] = useState<TriggerMatch | null>(null);

  const setSuggestionOpen = useCallback(
    (nextOpen: boolean) => {
      const surface = surfaceRef.current;
      if (surface !== null && surface !== undefined) {
        surface.setSuggestionOpen(kind, nextOpen);
      }
    },
    [kind, surfaceRef],
  );

  const close = useCallback(() => {
    setSuggestionOpen(false);
    setOpen(false);
    setActiveMatch(null);
    setPanelPosition(null);
  }, [setSuggestionOpen]);

  // 候选浮层 open 时经浮层栈注册（spec docs/editor/浮层堆栈管理.md「业务面接入清单」）：
  // 替代原先元素级 capture + stopPropagation 抢占，Esc 只关候选、不再直接落到画布基底。
  // id 带 kind 与实例 useId：编辑面（文本节点 / 分段卡）可多实例共存，层身份必须逐实例唯一。
  const layerId = useId();
  useOverlayLayer({
    active: open,
    id: `prompt-trigger-suggestion:${kind}:${layerId}`,
    onClose: close,
  });

  const syncFromSurface = useCallback(() => {
    if (disabled) {
      close();
      return;
    }
    const surface = surfaceRef.current;
    const element = surface !== null && surface !== undefined ? surface.getElement() : null;
    if (!surface || !element) {
      close();
      return;
    }
    const value = surface.getValue() ?? '';
    const selection = surface.getSelectionRange();
    const cursor = typeof selection.start === 'number' ? selection.start : value.length;
    const match = findMatch(value, cursor);
    if (!match) {
      close();
      return;
    }

    const anchor =
      element instanceof HTMLTextAreaElement
        ? getTextareaCaretViewportRect(element, cursor)
        : getContentEditableCaretViewportRect(element);
    anchorRectRef.current = anchor;
    const nextPosition = resolvePopoverPosition({
      anchor,
      panelSize,
      gap: 6,
      margin: 12,
    });
    setSuggestionOpen(true);
    setPanelPosition(nextPosition);
    setActiveMatch(match);
    setOpen(true);
  }, [close, disabled, findMatch, panelSize, setSuggestionOpen, surfaceRef]);

  const activeQuery = activeMatch !== null ? activeMatch.query : undefined;

  const filteredCandidates = useMemo(
    () => (activeMatch === null ? [] : filterCandidates(candidates, activeMatch.query)),
    [activeMatch, candidates, filterCandidates],
  );

  const pick = useCallback(
    (candidate: TCandidate) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const value = surface.getValue() ?? '';
      const selection = surface.getSelectionRange();
      const cursor = typeof selection.start === 'number' ? selection.start : value.length;
      const match = findMatch(value, cursor);
      if (!match) return;

      const range = adjustReplaceRange
        ? adjustReplaceRange(value, match)
        : { start: match.triggerIndex, end: match.cursor };
      const insertText = buildInsertText(candidate);
      const next = value.slice(0, range.start) + insertText + value.slice(range.end);
      const nextCursor = range.start + insertText.length;

      surface.suppressNextInput();
      onPick(candidate, next);
      close();

      // 等待 React 同步 value 后再设置光标位置
      requestAnimationFrame(() => {
        const el = surfaceRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [adjustReplaceRange, buildInsertText, close, findMatch, onPick, surfaceRef],
  );

  // 键盘导航收编到统一基元 useListNavigation（形态 1）：
  // - 索引重置（open/query 变化）与候选数 clamp 由基元承担，替代原先两个手写 effect；
  // - wrap 缺省即循环：末项 ArrowDown 回首项、首项 ArrowUp 到末项（新行为，用户痛点）；
  // - Home/End 移动高亮（WAI-ARIA combobox 模式，有意接受的行为变化）；
  // - Enter/Tab 选中、Shift+Enter 让位换行、IME 组合期让位、候选为空放行均由基元内置，
  //   与本 hook 既有裁决一致。
  const handleSelectByIndex = useCallback(
    (index: number) => {
      const picked = filteredCandidates[index];
      if (picked === undefined) return;
      pick(picked);
    },
    [filteredCandidates, pick],
  );

  const {
    activeIndex,
    setActiveIndex,
    setItemRef,
    handleKeyDown: handleListNavKeyDown,
  } = useListNavigation({
    count: filteredCandidates.length,
    open,
    resetKey: `${open}:${activeQuery ?? ''}`,
    onSelect: handleSelectByIndex,
  });

  /**
   * 悬停同步（面板级委托）：cmdk Item 会用自己的内部 onPointerMove 覆盖消费方同名 prop，
   * 悬停写入高亮索引只能挂在候选面板容器上，经 CANDIDATE_INDEX_ATTRIBUTE 找到目标项。
   * 悬停与键盘共用基元的同一 activeIndex（单一事实源），悬停后按 Enter 选中悬停项。
   */
  const handlePanelPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest(`[${CANDIDATE_INDEX_ATTRIBUTE}]`);
      if (item === null) return;
      const raw = item.getAttribute(CANDIDATE_INDEX_ATTRIBUTE);
      const index = raw === null ? Number.NaN : Number(raw);
      if (!Number.isInteger(index) || index < 0) return;
      setActiveIndex(index);
    },
    [setActiveIndex],
  );

  // 候选数变化会改变面板实际高度：open 期间按真实面板尺寸重算定位（与键盘导航无关，勿删）。
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const anchor = anchorRectRef.current;
    if (!panel || !anchor) return;

    const panelRect = panel.getBoundingClientRect();
    const nextPosition = resolvePopoverPosition({
      anchor,
      panelSize: { width: panelRect.width, height: panelRect.height },
      gap: 6,
      margin: 12,
    });

    setPanelPosition((prev) => {
      if (!prev) return nextPosition;
      if (prev.left === nextPosition.left && prev.top === nextPosition.top) return prev;
      return nextPosition;
    });
  }, [filteredCandidates.length, open, panelPosition?.left, panelPosition?.top]);

  useEffect(() => {
    if (disabled) {
      close();
      return;
    }

    const surface = surfaceRef.current;
    const element = surface !== null && surface !== undefined ? surface.getElement() : null;
    if (!element) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // 键盘导航（ArrowUp/Down 循环、Home/End、Enter/Tab 选中）由基元 handleKeyDown 承担：
      // IME 组合期（isComposing/keyCode 229）与 Shift+Enter 让位、候选为空放行、open=false
      // 放行都在基元内置。返回 true 表示已消费（基元已 preventDefault），原生 capture 监听
      // 场景按契约补 stopPropagation 阻断后续冒泡处理。
      if (handleListNavKeyDown(event)) {
        event.stopPropagation();
      }
    };

    const handleInput = () => {
      syncFromSurface();
    };

    const handleClick = () => {
      syncFromSurface();
    };

    const handleBlur = () => {
      close();
    };

    element.addEventListener('keydown', handleKeyDown, { capture: true });
    element.addEventListener('input', handleInput);
    element.addEventListener('click', handleClick);
    element.addEventListener('blur', handleBlur);

    return () => {
      element.removeEventListener('keydown', handleKeyDown, { capture: true });
      element.removeEventListener('input', handleInput);
      element.removeEventListener('click', handleClick);
      element.removeEventListener('blur', handleBlur);
    };
    // 基元契约：handleKeyDown 闭包随配置（activeIndex/count/onSelect/open）变化重建，
    // 原生 addEventListener 场景必须把它列入监听 effect 依赖，否则拿到过期索引/候选数。
  }, [close, disabled, handleListNavKeyDown, syncFromSurface, surfaceRef]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = () => {
      syncFromSurface();
    };

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    const surface = surfaceRef.current;
    const element = surface !== null && surface !== undefined ? surface.getElement() : null;
    if (element) {
      element.addEventListener('scroll', handleViewportChange);
    }

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      if (element) {
        element.removeEventListener('scroll', handleViewportChange);
      }
    };
  }, [open, syncFromSurface, surfaceRef]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const panel = panelRef.current;
      const surface = surfaceRef.current;
      const element = surface !== null && surface !== undefined ? surface.getElement() : null;
      if (!panel || !element) return;
      const target = event.target as Node;
      if (panel.contains(target)) return;
      if (element.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [close, open, surfaceRef]);

  return {
    open,
    panelPosition,
    panelRef,
    activeQuery,
    filteredCandidates,
    activeIndex,
    /** 悬停同步入口（面板级 onPointerMove 委托，见 handlePanelPointerMove 注释）。 */
    setActiveIndex,
    /** 逐项注册候选元素（滚动跟随），列表项上挂 `ref={(element) => setItemRef(index, element)}`。 */
    setItemRef,
    /** 面板级 onPointerMove 处理器（悬停与键盘共用 activeIndex）。 */
    handlePanelPointerMove,
    close,
    pick,
  };
}
