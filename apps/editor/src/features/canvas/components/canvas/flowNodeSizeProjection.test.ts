import { describe, expect, it } from 'vitest';

import { readFlowNodeActualSize } from './flowNodeActualSize';
import { buildProjectionSizeByNodeId } from './flowNodeSizeProjection';
import type { CanvasLayoutSnapshotNode } from '../../store/selectors';
import type { DesiredSize } from '../../types';

const SNAPSHOT_NODES: CanvasLayoutSnapshotNode[] = [
  {
    id: 'node-1',
    type: 'model',
    position: { x: 0, y: 0 },
    draggable: true,
  },
];

const desired = (
  size: { width: number; height: number },
  state: DesiredSize['state'] = 'pending',
  semanticKey = 'semantic-test',
): Record<string, DesiredSize> => ({
  'node-1': { size, state, semanticKey },
});

describe('flowNodeActualSize', () => {
  it('prefers measured size over width/height fallback', () => {
    expect(readFlowNodeActualSize({
      width: 300,
      height: 200,
      measured: { width: 320, height: 180 },
    })).toEqual({ width: 320, height: 180 });
  });

  it('falls back to width/height when measured is unavailable', () => {
    expect(readFlowNodeActualSize({
      width: 301,
      height: 199,
    })).toEqual({ width: 301, height: 199 });
  });
});

describe('buildProjectionSizeByNodeId (Layout-Model-Driven)', () => {
  it('prefers layoutModel over measured when both present', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {
        'node-1': { width: 320, height: 200 },
      },
      desiredSizeByNodeId: desired({ width: 360, height: 220 }, 'pending'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {
        'node-1': { width: 400, height: 300 },
      },
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    expect(projection['node-1']).toEqual({ width: 400, height: 300 });
  });

  it('falls back to measured when layoutModel is missing', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {
        'node-1': { width: 320, height: 200 },
      },
      desiredSizeByNodeId: desired({ width: 360, height: 220 }, 'pending'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {},
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    expect(projection['node-1']).toEqual({ width: 320, height: 200 });
  });

  it('falls back to accepted desired size when layoutModel and actual are missing', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {},
      desiredSizeByNodeId: desired({ width: 360, height: 220 }, 'accepted'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {},
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    expect(projection['node-1']).toEqual({ width: 360, height: 220 });
  });

  it('falls back to default when no layoutModel, no measured, no accepted desired', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {},
      desiredSizeByNodeId: desired({ width: 360, height: 220 }, 'pending'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {},
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    // pending desired no longer drives projection (startup zero-feedback loop)
    expect(projection['node-1']).toEqual({ width: 280, height: 180 });
  });

  it('pending desired no longer dominates projection when measured exists', () => {
    // pending desired WAS the driver pre-migration; now it yields to measured
    // (spec: desired收窄为 runtime 漂移校准，pending 态不进入主优先级链)。
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {
        'node-1': { width: 320, height: 200 },
      },
      desiredSizeByNodeId: desired({ width: 420, height: 260 }, 'pending'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {},
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    expect(projection['node-1']).toEqual({ width: 320, height: 200 });
  });

  it('keeps transient dimensions as interaction-only override', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {},
      desiredSizeByNodeId: {},
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {},
      nodes: SNAPSHOT_NODES,
      transientDimensions: {
        'node-1': { width: 500, height: 320 },
      },
    });

    expect(projection['node-1']).toEqual({ width: 500, height: 320 });
  });

  it('layoutModel is the single source across many nodes', () => {
    const nodes: CanvasLayoutSnapshotNode[] = Array.from({ length: 104 }, (_, index) => ({
      id: `node-${index + 1}`,
      type: index < 33 ? 'model' : index < 65 ? 'textInput' : 'imageInput',
      position: { x: index * 8, y: index * 4 },
      draggable: true,
      connectable: true,
    }));
    const desiredSizeByNodeId: Record<string, DesiredSize> = {};
    const actualSizeByNodeId: Record<string, { width: number; height: number }> = {};
    const fallbackSizeByNodeId: Record<string, { width: number; height: number }> = {};
    const layoutModelByNodeId: Record<string, { width: number; height: number }> = {};
    for (const node of nodes) {
      const size = node.type === 'textInput'
        ? { width: 360, height: 240 }
        : { width: 240, height: 160 };
      desiredSizeByNodeId[node.id] = {
        size,
        state: 'accepted',
        semanticKey: 'semantic-converged',
      };
      // actual != layoutModel size, to verify layoutModel takes priority
      actualSizeByNodeId[node.id] = { width: 180, height: 120 };
      fallbackSizeByNodeId[node.id] = { width: 100, height: 80 };
      layoutModelByNodeId[node.id] = size;
    }

    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId,
      desiredSizeByNodeId,
      fallbackSizeByNodeId,
      layoutModelByNodeId,
      nodes,
      transientDimensions: {},
    });

    expect(Object.keys(projection)).toHaveLength(104);
    for (const node of nodes) {
      const expectedSize = node.type === 'textInput'
        ? { width: 360, height: 240 }
        : { width: 240, height: 160 };
      expect(projection[node.id]).toEqual(expectedSize);
    }
  });

  it('accepted desired is used as runtime drift fallback when measured is missing', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {},
      desiredSizeByNodeId: desired({ width: 420, height: 260 }, 'accepted'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {},
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    expect(projection['node-1']).toEqual({ width: 420, height: 260 });
  });

  it('layoutModel wins over accepted desired (layoutModel is single source of truth)', () => {
    const projection = buildProjectionSizeByNodeId({
      actualSizeByNodeId: {},
      desiredSizeByNodeId: desired({ width: 420, height: 260 }, 'accepted'),
      fallbackSizeByNodeId: {
        'node-1': { width: 280, height: 180 },
      },
      layoutModelByNodeId: {
        'node-1': { width: 500, height: 400 },
      },
      nodes: SNAPSHOT_NODES,
      transientDimensions: {},
    });

    expect(projection['node-1']).toEqual({ width: 500, height: 400 });
  });
});
