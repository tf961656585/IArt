import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ReactFlow, type Node } from '@xyflow/react';
import { useFlowRenderState } from './useFlowRenderState';

const makeInitialNodes = (): Node[] => [
  {
    id: 'node-1',
    position: { x: 0, y: 0 },
    data: { label: 'node-1' },
    width: 240,
    height: 120,
    measured: { width: 240, height: 120 },
  },
  {
    id: 'node-2',
    position: { x: 200, y: 0 },
    data: { label: 'node-2' },
    width: 240,
    height: 120,
    measured: { width: 240, height: 120 },
  },
];

const isVisuallySuppressed = (element: Element): boolean => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
    return false;
  }
  return (
    Boolean(
      (element instanceof HTMLElement && element.hidden) ||
        element.getAttribute('aria-hidden') === 'true' ||
        element.style.display === 'none' ||
        element.style.visibility === 'hidden' ||
        element.style.opacity === '0',
    )
  );
};

const collectDragContinuitySample = (
  container: HTMLElement,
  step: number,
): { step: number; nodeCount: number; hiddenCriticalCount: number } => {
  const criticalElements = Array.from(
    container.querySelectorAll('.react-flow__node'),
  );

  return {
    step,
    nodeCount: container.querySelectorAll('.react-flow__node').length,
    hiddenCriticalCount: criticalElements.filter(isVisuallySuppressed).length,
  };
};

const assertContinuousSample = (
  sample: { step: number; nodeCount: number; hiddenCriticalCount: number },
  samples: readonly { step: number; nodeCount: number; hiddenCriticalCount: number }[],
) => {
  const allSamples = [...samples, sample];
  const diagnostic = JSON.stringify(allSamples, null, 2);
  if (sample.nodeCount !== 2) {
    throw new Error(`拖拽采样发现节点 DOM 数量异常：\n${diagnostic}`);
  }
  if (sample.hiddenCriticalCount !== 0) {
    throw new Error(`拖拽采样发现节点被隐藏：\n${diagnostic}`);
  }
};

function FlowRenderStateHarness({ dragStep }: { dragStep: number }) {
  const stableNodes = React.useMemo(() => makeInitialNodes(), []);
  const {
    renderNodes,
    beginRenderDragSession,
    applyRenderPositionUpdates,
  } = useFlowRenderState({
    stableNodes,
    nodeGraphId: 'graph-1',
    structureRevision: 1,
    positionRevision: 1,
    flowComputationEnabled: true,
  });

  React.useEffect(() => {
    if (dragStep <= 0) return;
    beginRenderDragSession();
    applyRenderPositionUpdates(
      [{ id: 'node-1', position: { x: dragStep * 80, y: dragStep * 20 } }],
    );
  }, [applyRenderPositionUpdates, beginRenderDragSession, dragStep]);

  return (
    <div style={{ width: 960, height: 640 }}>
      <ReactFlow
        nodes={renderNodes}
        edges={[]}
        fitView={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

describe('FlowRenderState + ReactFlow drag continuity', () => {
  it('连续拖拽 render position 更新期间节点保持可见连续', async () => {
    const samples: { step: number; nodeCount: number; hiddenCriticalCount: number }[] = [];
    const { container, rerender } = render(<FlowRenderStateHarness dragStep={0} />);

    await waitFor(() => {
      assertContinuousSample(collectDragContinuitySample(container, 0), samples);
    });
    samples.push(collectDragContinuitySample(container, 0));

    for (const step of [1, 2, 3, 4]) {
      rerender(<FlowRenderStateHarness dragStep={step} />);
      await waitFor(() => {
        assertContinuousSample(collectDragContinuitySample(container, step), samples);
      });
      samples.push(collectDragContinuitySample(container, step));
    }

    expect(samples).toHaveLength(5);
    expect(samples.every((sample) => sample.nodeCount === 2)).toBe(true);
    expect(samples.every((sample) => sample.hiddenCriticalCount === 0)).toBe(true);
  });
});
