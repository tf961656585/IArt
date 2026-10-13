import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '../../store/canvasStore';
import {
  createTextInputNodeFixture,
  createTestNodeGraphParams,
} from '../../components/__tests__/fixtures/canvasTestBuilders';
import { createNodeGraph, type NodeGraph } from '../../types/nodeGraph';
import { resolveAutoSizeCurrentSize } from '../resolveAutoSizeCurrentSize';

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.ui.desiredSizeByNodeId = {};
  });
};

describe('resolveAutoSizeCurrentSize', () => {
  beforeEach(() => resetStore());

  it('优先返回 runtime 尺寸', () => {
    const graph: NodeGraph = createNodeGraph(createTestNodeGraphParams('test'));
    graph.nodes = [
      createTextInputNodeFixture({
        id: 'node-1',
        position: { x: 0, y: 0 },
      }),
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.ui.desiredSizeByNodeId = { 'node-1': { size: { width: 320, height: 180 }, state: 'accepted', semanticKey: 'test' } };
    });

    expect(resolveAutoSizeCurrentSize({ currentMeasuredSize: { width: 320, height: 180 }, fallback: { width: 10, height: 10 } })).toEqual({
      width: 320,
      height: 180,
    });
  });

  it('runtime 缺失时回退 fallback', () => {
    const graph: NodeGraph = createNodeGraph(createTestNodeGraphParams('test'));
    graph.nodes = [
      createTextInputNodeFixture({
        id: 'node-1',
        position: { x: 0, y: 0 },
      }),
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.ui.desiredSizeByNodeId = {};
    });

    expect(resolveAutoSizeCurrentSize({
      currentMeasuredSize: undefined,
      fallback: { width: 220, height: 120 },
    })).toEqual({
      width: 220,
      height: 120,
    });
  });
});
