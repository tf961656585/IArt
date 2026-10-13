import { describe, expect, it } from 'vitest';
import { clampSelectionRange, snapshotPromptTextSurface } from '../promptTextSurfaceSelection';
import type { PromptTextSurface } from '../../components/nodes/shared/promptTextSurface';

describe('promptTextSurfaceSelection', () => {
  it('clampSelectionRange 会做范围裁剪并归一化 start/end', () => {
    expect(clampSelectionRange({ start: -1, end: 10 }, 5)).toEqual({ start: 0, end: 5 });
    expect(clampSelectionRange({ start: 4, end: 2 }, 5)).toEqual({ start: 2, end: 4 });
  });

  it('surface.tryGetSelectionRange() 返回 null 时 fallback 到末尾（避免固化 0:0）', () => {
    const surface = {
      focus: () => {},
      getElement: () => null,
      getValue: () => 'hello',
      getSelectionRange: () => ({ start: 0, end: 0 }),
      tryGetSelectionRange: () => null,
      setSelectionRange: () => {},
      getCaretViewportRect: () => ({ left: 0, top: 0, bottom: 0, height: 0 }),
      setSuggestionOpen: () => {},
      suppressNextInput: () => {},
    } as PromptTextSurface;

    expect(snapshotPromptTextSurface(surface, '').selection).toEqual({ start: 5, end: 5 });
  });

  it('surface 为空时使用 fallbackValue，并把选区置于末尾', () => {
    expect(snapshotPromptTextSurface(null, 'abc')).toEqual({
      value: 'abc',
      selection: { start: 3, end: 3 },
    });
  });
});
