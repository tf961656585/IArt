import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import {
  createPrimaryClickEvent,
  mockRuntime,
  NodeCanvas,
  resetCanvasStore,
  seedMinimalGraph,
  type MockReactFlowProps,
} from './nodeCanvasSelectionTestHarness';

describe('NodeCanvas 渲染投影 selected 属性注入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime.reactFlowProps = null;
    mockRuntime.flowNodes = [];
    mockRuntime.flowEdges = [];
    resetCanvasStore();
    seedMinimalGraph();
  });

  it('节点选中后渲染投影的 flowNodes 应携带 selected: true', async () => {
    render(<NodeCanvas />);

    await waitFor(() => {
      expect(mockRuntime.reactFlowProps).not.toBeNull();
    });

    const props = mockRuntime.reactFlowProps as MockReactFlowProps;

    // 通过 onNodeClick 选中节点
    await act(async () => {
      props.onNodeClick?.(
        createPrimaryClickEvent({ clientX: 24, clientY: 24 }),
        { id: 'node-1' },
      );
    });

    // store 已更新，等待 React 重新渲染
    await waitFor(() => {
      const selectedNode = mockRuntime.flowNodes.find(
        (node) => node.id === 'node-1',
      );
      expect(selectedNode).toBeDefined();
      expect(selectedNode !== undefined ? selectedNode.selected : undefined).toBe(true);
    });
  });

  it('取消选中后渲染投影的 flowNodes 应携带 selected: false', async () => {
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

    await waitFor(() => {
      const selectedNode = mockRuntime.flowNodes.find(
        (node) => node.id === 'node-1',
      );
      expect(selectedNode !== undefined ? selectedNode.selected : undefined).toBe(true);
    });

    // 通过 onPaneClick 取消选中
    await act(async () => {
      props.onPaneClick?.(createPrimaryClickEvent({ clientX: 48, clientY: 48 }));
    });

    // 验证节点 selected 变为 false
    await waitFor(() => {
      const deselectedNode = mockRuntime.flowNodes.find(
        (node) => node.id === 'node-1',
      );
      expect(deselectedNode !== undefined ? deselectedNode.selected : undefined).toBe(false);
    });
  });
});
