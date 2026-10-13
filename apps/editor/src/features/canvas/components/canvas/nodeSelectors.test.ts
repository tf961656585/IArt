import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { cast } from '@/lib/utils';
import type { GraphNode, TextInputNodeData } from '../../types';
import type { useCanvasStore } from '../../store/canvasStore';
import { selectNodeSnapshot } from '../../store/selectors';
import { createTextInputNodeFixture } from '../__tests__/fixtures/canvasTestBuilders';

const makeGraphNode = (id: string): GraphNode<TextInputNodeData> => ({
  ...createTextInputNodeFixture({ id }),
});

describe('selectNodeSnapshot', () => {
  it('falls back to the provided node when the store node is missing', () => {
    const fallback = makeGraphNode('n1');
    const selector = selectNodeSnapshot('n1', fallback);

    const snapshot = selector(cast<ReturnType<
      typeof useCanvasStore.getState
    >>({ nodeGraph: { id: 'g1', nodes: [] } }));

    expect(snapshot.nodeGraphId).toBe('g1');
    expect(snapshot.node).toBeNull();
    expect(snapshot.data).toBe(fallback.data);
  });

  it('prefers the store node and is shallow-equal across calls', () => {
    const fallback = makeGraphNode('n1');
    const storeNode = makeGraphNode('n1');
    const selector = selectNodeSnapshot('n1', fallback);

    const state = cast<ReturnType<
      typeof useCanvasStore.getState
    >>({ nodeGraph: { id: 'g1', nodes: [storeNode] } });

    const first = selector(state);
    const second = selector(state);

    expect(first.node).toBe(storeNode);
    expect(second.node).toBe(storeNode);
    expect(shallow(first, second)).toBe(true);
  });
});
