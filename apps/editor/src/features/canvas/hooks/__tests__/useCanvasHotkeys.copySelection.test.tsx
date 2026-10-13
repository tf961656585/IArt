import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode, TextInputNodeData } from '../../types/node';
import { __setMockCanvasState, useCanvasStore } from '../../store/canvasStore';
import { useCanvasHotkeys } from '../useCanvasHotkeys';

const mockSelectionCommands = vi.hoisted(() => ({
  selectEntireCanvas: vi.fn(),
  selectNodes: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../components/canvas/useCanvasSelectionBridge', () => ({
  useCanvasSelectionBridge: () => mockSelectionCommands,
}));

describe('useCanvasHotkeys ctrl/cmd + c', () => {
  let copySelectedNodesSpy: ReturnType<typeof vi.fn>;
  let originalCopySelectedNodes: ReturnType<typeof useCanvasStore.getState>['copySelectedNodes'];

  beforeEach(() => {
    const graph = createNodeGraph({
      name: 'test graph',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    const textInputData: TextInputNodeData = {
      label: 'Node 1',
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: 'comma',
      customSeparator: '',
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    };
    graph.nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        data: textInputData,
        position: { x: 0, y: 0 },
        draggable: true,
        size: undefined,
        style: undefined,
        groupId: undefined,
      } satisfies GraphNode,
    ];
    originalCopySelectedNodes = useCanvasStore.getState().copySelectedNodes;
    copySelectedNodesSpy = vi.fn();
    __setMockCanvasState({
      nodeGraph: graph,
      selectedNodeIds: ['node-1'],
      copySelectedNodes: copySelectedNodesSpy,
    });
    mockSelectionCommands.selectEntireCanvas.mockReset();
    mockSelectionCommands.selectNodes.mockReset();
  });

  afterEach(() => {
    __setMockCanvasState({
      nodeGraph: null,
      selectedNodeIds: [],
      copySelectedNodes: originalCopySelectedNodes,
    });
    vi.restoreAllMocks();
  });

  it('skips node copy when there is a non-empty text selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'hello world',
    } as Selection);

    const { unmount } = renderHook(() => useCanvasHotkeys());
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(copySelectedNodesSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    unmount();
  });

  it('copies nodes when selection is empty or whitespace', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => '   ',
    } as Selection);

    const { unmount } = renderHook(() => useCanvasHotkeys());
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(copySelectedNodesSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    unmount();
  });

  it('does not intercept copy inside input elements', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'text',
    } as Selection);

    const { unmount } = renderHook(() => useCanvasHotkeys());
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      textarea.dispatchEvent(event);
    });

    expect(copySelectedNodesSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    textarea.remove();
    unmount();
  });

  it('ctrl/cmd + a 会触发 selectEntireCanvas', () => {
    const { unmount } = renderHook(() => useCanvasHotkeys());
    const ctrlEvent = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const cmdEvent = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      window.dispatchEvent(ctrlEvent);
      window.dispatchEvent(cmdEvent);
    });

    expect(mockSelectionCommands.selectEntireCanvas).toHaveBeenCalledTimes(2);
    expect(mockSelectionCommands.selectEntireCanvas).toHaveBeenNthCalledWith(1, 'hotkey-select-all');
    expect(mockSelectionCommands.selectEntireCanvas).toHaveBeenNthCalledWith(2, 'hotkey-select-all');
    expect(ctrlEvent.defaultPrevented).toBe(true);
    expect(cmdEvent.defaultPrevented).toBe(true);
    unmount();
  });

  it('input/textarea/contenteditable 焦点时 ctrl/cmd + a 不触发 selectEntireCanvas', () => {
    const { unmount } = renderHook(() => useCanvasHotkeys());
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    Object.defineProperty(editable, 'isContentEditable', {
      value: true,
      configurable: true,
    });
    document.body.appendChild(input);
    document.body.appendChild(textarea);
    document.body.appendChild(editable);

    const inputEvent = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const textareaEvent = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const editableEvent = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      input.dispatchEvent(inputEvent);
      textarea.dispatchEvent(textareaEvent);
      editable.dispatchEvent(editableEvent);
    });

    expect(mockSelectionCommands.selectEntireCanvas).not.toHaveBeenCalled();
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(textareaEvent.defaultPrevented).toBe(false);
    expect(editableEvent.defaultPrevented).toBe(false);

    input.remove();
    textarea.remove();
    editable.remove();
    unmount();
  });
});
