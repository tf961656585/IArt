import type { PromptTextSurface, SelectionRange } from '../components/nodes/shared/promptTextSurface';

export type PromptTextSurfaceSnapshot = {
  value: string;
  selection: SelectionRange;
};

export const clampIndex = (value: number, max: number): number => Math.max(0, Math.min(max, value));

export const clampSelectionRange = (range: SelectionRange, length: number): SelectionRange => {
  const start = clampIndex(range.start, length);
  const end = clampIndex(range.end, length);
  return start <= end ? { start, end } : { start: end, end: start };
};

/**
 * 打开 Dialog 前从 surface 采样当前 value + selection。
 * - 若 surface 支持 tryGetSelectionRange() 且返回 null：视为无效选区，fallback 到末尾。
 * - 否则兼容使用 getSelectionRange()。
 */
export const snapshotPromptTextSurface = (
  surface: PromptTextSurface | null | undefined,
  fallbackValue: string,
): PromptTextSurfaceSnapshot => {
  const value = surface !== null && surface !== undefined ? surface.getValue() : fallbackValue;
  const length = value.length;

  let selection: SelectionRange | null = null;
  if (surface) {
    if (typeof surface.tryGetSelectionRange === 'function') {
      const currentSelection = surface.tryGetSelectionRange();
      selection = currentSelection !== undefined ? currentSelection : null;
    } else {
      const fallbackSelection = surface.getSelectionRange();
      selection = fallbackSelection !== undefined ? fallbackSelection : null;
    }
  }

  if (!selection) {
    return { value, selection: { start: length, end: length } };
  }

  return { value, selection: clampSelectionRange(selection, length) };
};
