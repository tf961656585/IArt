import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BaseNodeCard } from '../BaseNodeCard';

type MockCanvasState = {
  selectedNodeIds: string[];
  updateNodeMeasured: ReturnType<typeof vi.fn>;
  ui: {
    placeholderNodeIds: Set<string>;
    desiredSizeByNodeId: Record<string, unknown>;
    lastMeasuredSizeByNodeId: Record<string, unknown>;
  };
  nodeGraph: { id: string; nodes: unknown[] } | null;
  structureRevision: number;
  dataRevision: number;
  layoutRevision: number;
  preparationPhase: string;
};

let mockCanvasState = {} as MockCanvasState;

function getMockCanvasState(): MockCanvasState {
  if (!mockCanvasState) {
    throw new Error('mockCanvasState is not initialized');
  }
  return mockCanvasState;
}

const { logCanvasDebugEvent } = vi.hoisted(() => ({
  logCanvasDebugEvent: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  Handle: ({ children }: { children?: React.ReactNode }) => <div data-testid="handle">{children}</div>,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useReactFlow: () => ({ setCenter: vi.fn() }),
  useUpdateNodeInternals: () => vi.fn(),
}));

vi.mock('../../../store/canvasStore', () => {
  const useCanvasStore = <T,>(selector: (state: MockCanvasState) => T): T => selector(getMockCanvasState());
  useCanvasStore.getState = getMockCanvasState;
  return { useCanvasStore };
});

vi.mock('../../../debug/canvasDebug', () => ({
  logCanvasDebugEvent,
}));

// jsdom 不做布局：clientHeight/scrollHeight 恒为 0。测试需要临时覆写原型 getter，
// 让内容区 div 的「可见高度/内容自然高度」可控，驱动溢出检测。
const originalDescriptors = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
};

const mockContentGeometry = (opts: { clientHeight: number; scrollHeight: number; clientWidth?: number }) => {
  const define = (name: 'clientHeight' | 'clientWidth' | 'scrollHeight', value: number) => {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      enumerable: false,
      get: () => value,
    });
  };
  define('clientHeight', opts.clientHeight);
  define('clientWidth', opts.clientWidth ?? 200);
  define('scrollHeight', opts.scrollHeight);
};

const restoreContentGeometry = () => {
  const restore = (name: 'clientHeight' | 'clientWidth' | 'scrollHeight', descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  };
  restore('clientHeight', originalDescriptors.clientHeight);
  restore('clientWidth', originalDescriptors.clientWidth);
  restore('scrollHeight', originalDescriptors.scrollHeight);
};

describe('BaseNodeCard - 内容区溢出可观测性（scrollHeight 留痕）', () => {
  beforeEach(() => {
    mockCanvasState = {
      selectedNodeIds: [],
      updateNodeMeasured: vi.fn(),
      ui: {
        placeholderNodeIds: new Set(),
        desiredSizeByNodeId: {},
        lastMeasuredSizeByNodeId: {},
      },
      nodeGraph: null,
      structureRevision: 0,
      dataRevision: 0,
      layoutRevision: 0,
      preparationPhase: 'ready',
    };
    logCanvasDebugEvent.mockClear();
    mockContentGeometry({ clientHeight: 100, scrollHeight: 100 });
  });

  afterEach(() => {
    restoreContentGeometry();
  });

  const renderCard = (props: { nodeId: string; fill?: boolean; content?: string }) => {
    const { nodeId, fill, content } = props;
    return render(
      <BaseNodeCard nodeId={nodeId} title="测试节点" fill={fill} selected={false}>
        <div data-testid="content">{content ?? 'Content'}</div>
      </BaseNodeCard>,
    );
  };

  it('fill 模式 + runtime 期，内容高度 > 可见高度时打 node:contentOverflow 留痕', () => {
    mockContentGeometry({ clientHeight: 100, scrollHeight: 160 });
    renderCard({ nodeId: 'node-1', fill: true });

    expect(logCanvasDebugEvent).toHaveBeenCalledTimes(1);
    expect(logCanvasDebugEvent).toHaveBeenCalledWith(
      'node:contentOverflow',
      expect.objectContaining({
        nodeId: 'node-1',
        contentSize: { width: 200, height: 160 },
        viewportSize: { width: 200, height: 100 },
      }),
    );
  });

  it('非 fill 模式（无固定外壳）不检测，即使内容高度 > 可见高度', () => {
    mockContentGeometry({ clientHeight: 100, scrollHeight: 160 });
    renderCard({ nodeId: 'node-2' });

    expect(logCanvasDebugEvent).not.toHaveBeenCalled();
  });

  it('内容未溢出时不打日志', () => {
    mockContentGeometry({ clientHeight: 100, scrollHeight: 100 });
    renderCard({ nodeId: 'node-3', fill: true });

    expect(logCanvasDebugEvent).not.toHaveBeenCalled();
  });

  it('持续溢出去重：同溢出量不重复打日志，溢出量变化超过阈值或恢复后再溢出才再打', () => {
    mockContentGeometry({ clientHeight: 100, scrollHeight: 160 });
    const { rerender } = renderCard({ nodeId: 'node-4', fill: true, content: 'v1' });
    expect(logCanvasDebugEvent).toHaveBeenCalledTimes(1);

    // 内容不变（children 引用变化）但溢出量不变：去重，不重复打日志。
    rerender(
      <BaseNodeCard nodeId="node-4" title="测试节点" fill selected={false}>
        <div data-testid="content">v1</div>
      </BaseNodeCard>,
    );
    expect(logCanvasDebugEvent).toHaveBeenCalledTimes(1);

    // 溢出量从 160 增到 180（超过 4px 阈值）：再打一次。
    mockContentGeometry({ clientHeight: 100, scrollHeight: 180 });
    rerender(
      <BaseNodeCard nodeId="node-4" title="测试节点" fill selected={false}>
        <div data-testid="content">v2</div>
      </BaseNodeCard>,
    );
    expect(logCanvasDebugEvent).toHaveBeenCalledTimes(2);

    // 恢复不溢出：不打日志，且重置状态。
    mockContentGeometry({ clientHeight: 100, scrollHeight: 90 });
    rerender(
      <BaseNodeCard nodeId="node-4" title="测试节点" fill selected={false}>
        <div data-testid="content">v3</div>
      </BaseNodeCard>,
    );
    expect(logCanvasDebugEvent).toHaveBeenCalledTimes(2);

    // 恢复后再溢出（140）：视为新的首次溢出，再打一次。
    mockContentGeometry({ clientHeight: 100, scrollHeight: 140 });
    rerender(
      <BaseNodeCard nodeId="node-4" title="测试节点" fill selected={false}>
        <div data-testid="content">v4</div>
      </BaseNodeCard>,
    );
    expect(logCanvasDebugEvent).toHaveBeenCalledTimes(3);
  });
});
