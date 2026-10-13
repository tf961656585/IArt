import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeGraph } from '../../types/nodeGraph';
import { __setMockCanvasState, useCanvasStore } from '../../store/canvasStore';
import { useCanvasDeleteShortcuts } from '../useCanvasDeleteShortcuts';

const createTestGraph = () =>
  createNodeGraph({
    name: 'delete-hook-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

describe('useCanvasDeleteShortcuts', () => {
  const originalDeleteSelectedElements = useCanvasStore.getState().deleteSelectedElements;

  beforeEach(() => {
    const graph = createTestGraph();
    __setMockCanvasState({
      nodeGraph: graph,
      selectedNodeIds: ['node-1'],
      deleteSelectedElements: originalDeleteSelectedElements,
    });
  });

  afterEach(() => {
    __setMockCanvasState({
      selectedNodeIds: [],
      selectedAnnotationIds: [],
      nodeGraph: null,
      deleteSelectedElements: originalDeleteSelectedElements,
    });
  });

  const fireKeyDown = (key: string, target: EventTarget | null = null): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    if (target !== null) {
      (target as HTMLElement).dispatchEvent(event);
    } else {
      document.dispatchEvent(event);
    }
    return event;
  };

  it('enabled=true + 有选中节点 + 按 Delete：调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = fireKeyDown('Delete');
      expect(event.defaultPrevented).toBe(true);
    });

    expect(deleteSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('enabled=true + 有选中注释 + 按 Delete：调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy, selectedNodeIds: [], selectedAnnotationIds: ['ann-1'] });

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = fireKeyDown('Delete');
      expect(event.defaultPrevented).toBe(true);
    });

    expect(deleteSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('enabled=false + 按 Delete：不调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(false));

    act(() => {
      fireKeyDown('Delete');
    });

    expect(deleteSpy).not.toHaveBeenCalled();

    unmount();
  });

  it('焦点在 input 中 + 按 Delete：不调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const input = document.createElement('input');
    document.body.appendChild(input);

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
    });

    expect(deleteSpy).not.toHaveBeenCalled();

    input.remove();
    unmount();
  });

  it('焦点在 textarea 中 + 按 Delete：不调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(event);
    });

    expect(deleteSpy).not.toHaveBeenCalled();

    textarea.remove();
    unmount();
  });

  it('焦点在 contenteditable 中 + 按 Delete：不调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      });
      editable.dispatchEvent(event);
    });

    expect(deleteSpy).not.toHaveBeenCalled();

    editable.remove();
    unmount();
  });

  it('焦点在 [role="textbox"] 中 + 按 Delete：不调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    document.body.appendChild(textbox);

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      });
      textbox.dispatchEvent(event);
    });

    expect(deleteSpy).not.toHaveBeenCalled();

    textbox.remove();
    unmount();
  });

  it('按非 Delete 键：不调用 deleteSelectedElements', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({ deleteSelectedElements: deleteSpy });

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      fireKeyDown('Enter');
    });

    expect(deleteSpy).not.toHaveBeenCalled();

    unmount();
  });

  it('无选中 + 按 Delete：deleteSelectedElements 被调用但内部无操作', () => {
    const deleteSpy = vi.fn();
    __setMockCanvasState({
      deleteSelectedElements: deleteSpy,
      selectedNodeIds: [],
      selectedAnnotationIds: [],
    });

    const { unmount } = renderHook(() => useCanvasDeleteShortcuts(true));

    act(() => {
      const event = fireKeyDown('Delete');
      expect(event.defaultPrevented).toBe(true);
    });

    // hook 层面仍然调用了 deleteSelectedElements
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    unmount();
  });
});
