import type { ViewportRect } from './textareaPopoverPosition';

export type SelectionRange = { start: number; end: number };

export type PromptTextSurface = {
  focus: () => void;
  getElement: () => HTMLElement | null;
  getValue: () => string;
  /**
   * 兼容旧语义：当选区不可用/不在 editor 内时，可能返回 { start:0, end:0 }。
   * 调用方若需要区分“有效/无效选区”，优先使用 tryGetSelectionRange()。
   */
  getSelectionRange: () => SelectionRange;
  /**
   * 增量扩展：返回 null 表示当前没有可用选区（例如 selection 不在 editor 内）。
   * 用于避免把 { start:0, end:0 } 误当作有效选区。
   */
  tryGetSelectionRange: () => SelectionRange | null | undefined;
  setSelectionRange: (start: number, end: number) => void;
  getCaretViewportRect: () => ViewportRect;
  setSuggestionOpen: (kind: 'pp' | 'mention', open: boolean) => void | undefined;
  suppressNextInput: () => void | undefined;
};
