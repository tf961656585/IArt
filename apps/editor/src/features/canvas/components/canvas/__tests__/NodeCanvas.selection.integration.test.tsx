import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import {
  createPrimaryClickEvent,
  getCanvasSelectionCommandDriver,
  mockRuntime,
  NodeCanvas,
  resetCanvasStore,
  seedMinimalGraph,
  type MockReactFlowProps,
  useCanvasStore,
} from './nodeCanvasSelectionTestHarness';

describe('NodeCanvas 选择态主链', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime.reactFlowProps = null;
    mockRuntime.flowNodes = [];
    mockRuntime.flowEdges = [];
    resetCanvasStore();
    seedMinimalGraph();
  });

  it('左键点击节点时应立刻同步 ReactFlow 视觉选中与 store 业务投影', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);
    expect(
      mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
    ).toBe(true);
  });

  it('点击 pane 空白区域时应同时清空业务选择与 ReactFlow 视觉选择态', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 先通过 onNodeClick 选中节点
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    // 确认选中生效
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);

    // 点击空白处清空
    await act(async () => {
      props.onPaneClick?.(createPrimaryClickEvent({ clientX: 48, clientY: 48 }));
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
    expect(
      mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
    ).not.toBe(true);
  });

  it('切换到另一个节点时，旧节点必须同步取消视觉选中', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 先点击 node-1
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    // 再点击 node-2（replace-selection）
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 260, clientY: 24 }),
        { id: 'node-2' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-2']);
    expect(
      mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
    ).toBe(false);
    expect(
      mockRuntime.flowNodes.find((node) => node.id === 'node-2')?.selected,
    ).toBe(true);
  });

  it('pane 点击清空选择时，普通 textbox 焦点不阻止清空', async () => {
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['node-1'];
    });

    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    mockRuntime.flowNodes = [
      { id: 'node-1', selected: true },
      { id: 'node-2', selected: false },
    ];

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    try {
      await act(async () => {
        props.onPaneClick?.(createPrimaryClickEvent({ clientX: 12, clientY: 12 }));
      });

      expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
      expect(
        mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
      ).toBe(false);
    } finally {
      input.remove();
    }
  });

  it('文本编辑保护：contenteditable + data-canvas-selection-edit-session 聚焦时 pane 点击不清空选择', async () => {
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['node-1'];
    });

    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    mockRuntime.flowNodes = [
      { id: 'node-1', selected: true },
      { id: 'node-2', selected: false },
    ];

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;
    const editor = document.createElement('div');
    editor.setAttribute('tabindex', '0');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('data-canvas-selection-edit-session', 'true');
    document.body.appendChild(editor);
    editor.focus();

    try {
      await act(async () => {
        props.onPaneClick?.(createPrimaryClickEvent({ clientX: 12, clientY: 12 }));
      });

      // 文本编辑保护生效：选择不被清空
      expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);
      expect(
        mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
      ).toBe(true);
    } finally {
      editor.remove();
    }
  });

  it('程序化节点选中命令应同时驱动 ReactFlow 视觉选中与 store 业务投影', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    await act(async () => {
      getCanvasSelectionCommandDriver().selectNodes(
        ['node-1'],
        'selection-test',
      );
    });

    await waitFor(() => {
      expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);
      expect(
        mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
      ).toBe(true);
    });
  });

  it('程序化清空选中命令应同时清空 ReactFlow 视觉选中与 store 业务投影', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    await act(async () => {
      getCanvasSelectionCommandDriver().selectNodes(
        ['node-1'],
        'selection-test',
      );
    });

    await waitFor(() => {
      expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);
      expect(
        mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
      ).toBe(true);
    });

    await act(async () => {
      getCanvasSelectionCommandDriver().applySelectionCommand(
        {
          kind: 'replace-selection',
          selection: {
            nodeIds: [],
            annotationIds: [],
          },
        },
        'selection-test',
      );
    });

    await waitFor(() => {
      expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
      expect(
        mockRuntime.flowNodes.find((node) => node.id === 'node-1')?.selected,
      ).toBe(false);
    });
  });
});

describe('NodeCanvas onNodeClick 多选', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime.reactFlowProps = null;
    mockRuntime.flowNodes = [];
    mockRuntime.flowEdges = [];
    resetCanvasStore();
    seedMinimalGraph();
  });

  it('点击节点 A → Ctrl+点击节点 B → store 应包含两个节点', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 点击 node-1
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);

    // Ctrl+点击 node-2
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 260, clientY: 24, ctrlKey: true }),
        { id: 'node-2' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1', 'node-2']);
  });

  it('点击节点 A → Ctrl+点击节点 A → store 应为空（toggle off）', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 点击 node-1
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);

    // Ctrl+点击 node-1（toggle off）
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24, ctrlKey: true }),
        { id: 'node-1' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
  });

  it('点击节点 A → Shift+点击节点 B → store 应包含两个节点', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 点击 node-1
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);

    // Shift+点击 node-2
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 260, clientY: 24, shiftKey: true }),
        { id: 'node-2' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1', 'node-2']);
  });

  it('点击节点 A → Meta+点击节点 B → store 应包含两个节点', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 点击 node-1
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1']);

    // Meta+点击 node-2
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 260, clientY: 24, metaKey: true }),
        { id: 'node-2' },
      );
    });

    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['node-1', 'node-2']);
  });
});
