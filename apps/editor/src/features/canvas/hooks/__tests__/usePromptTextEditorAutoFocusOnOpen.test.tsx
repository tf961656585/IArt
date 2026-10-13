import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { cast } from '@/lib/utils';
import type { PromptTextSurface } from '../../components/nodes/shared/promptTextSurface';
import { usePromptTextEditorAutoFocusOnOpen } from '../usePromptTextEditorAutoFocusOnOpen';

describe('usePromptTextEditorAutoFocusOnOpen', () => {
  beforeEach(() => {
    let nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      nextId += 1;
      cb(0);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      // noop
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('open 周期内仅应用一次 focus + 初始选区，不随 rerender 重置', async () => {
    const focus = vi.fn();
    const setSelectionRange = vi.fn();

    const surface = cast<PromptTextSurface>({
      focus,
      getElement: () => null,
      getValue: () => 'hello',
      getSelectionRange: () => ({ start: 0, end: 0 }),
      tryGetSelectionRange: () => ({ start: 0, end: 0 }),
      setSelectionRange,
      getCaretViewportRect: () => ({ left: 0, top: 0, bottom: 0, height: 0 }),
      setSuggestionOpen: () => undefined,
      suppressNextInput: () => undefined,
    });

    const editorRef = { current: surface } as RefObject<PromptTextSurface | null>;

    const { rerender } = renderHook(
      ({ open, selection }) =>
          usePromptTextEditorAutoFocusOnOpen({
            open,
            editorRef,
            initialSelection: selection,
            maxRafAttempts: undefined,
          }),
      {
        initialProps: {
          open: false,
          selection: { start: 1, end: 3 },
        },
      },
    );

    expect(focus).not.toHaveBeenCalled();
    expect(setSelectionRange).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ open: true, selection: { start: 1, end: 3 } });
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(setSelectionRange).toHaveBeenCalledTimes(1);
    expect(setSelectionRange).toHaveBeenCalledWith(1, 3);

    // rerender（模拟 value 变化/父组件刷新），不应重复 setSelectionRange
    await act(async () => {
      rerender({ open: true, selection: { start: 2, end: 4 } });
    });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(setSelectionRange).toHaveBeenCalledTimes(1);
  });

  it('未提供初始选区时 fallback 到末尾，并做 clamp', async () => {
    const focus = vi.fn();
    const setSelectionRange = vi.fn();

    const surface = cast<PromptTextSurface>({
      focus,
      getElement: () => null,
      getValue: () => 'hello',
      getSelectionRange: () => ({ start: 0, end: 0 }),
      tryGetSelectionRange: () => ({ start: 0, end: 0 }),
      setSelectionRange,
      getCaretViewportRect: () => ({ left: 0, top: 0, bottom: 0, height: 0 }),
      setSuggestionOpen: () => undefined,
      suppressNextInput: () => undefined,
    });

    const editorRef = { current: surface } as RefObject<PromptTextSurface | null>;

    const { rerender } = renderHook(
      ({ open, selection }) =>
          usePromptTextEditorAutoFocusOnOpen({
            open,
            editorRef,
            initialSelection: selection,
            maxRafAttempts: undefined,
          }),
      {
        initialProps: {
          open: false,
          selection: null as { start: number; end: number } | null,
        },
      },
    );

    await act(async () => {
      rerender({ open: true, selection: null });
    });
    expect(setSelectionRange).toHaveBeenCalledWith(5, 5);
  });
});
