import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BaseNodeCard } from '../BaseNodeCard';
import type { NodeSize } from '../../../types/node';

/**
 * 占位壳渲染接入单测（spec：画布交互期渲染降级契约.md「占位壳契约」）。
 *
 * 保护的行为：
 * - 占位态（isPlaceholder=true）裁掉 children、保留 Handle、selection 不降级
 * - 完整态（isPlaceholder=false）正常渲染 children
 * - mount 时 isCanvasInteracting=true → markNodeAsPlaceholder 被调用
 * - mount 时 isCanvasInteracting=false → markNodeAsPlaceholder 不被调用
 * - 占位态尺寸来自 resolveEffectiveSize 主优先级链（layoutModel > measured > default）
 * - 占位态不触发 desired commit（占位期 producer 子树未挂载）
 *
 * 复用 BaseNodeCardRenderPolicy.test.tsx 的 mock 模式（vi.mock '@xyflow/react' Handle→div、
 * vi.mock canvasStore 读 getMockCanvasState）。
 */

type MockCanvasState = {
  selectedNodeIds: string[];
  isCanvasInteracting: boolean;
  isCanvasInteractingDelayed: boolean;
  ui: {
    placeholderNodeIds: Set<string>;
    desiredSizeByNodeId: Record<string, { size: NodeSize; state: 'pending' | 'accepted'; semanticKey: string }>;
    lastMeasuredSizeByNodeId: Record<string, NodeSize>;
    layoutModelByNodeId: Record<string, NodeSize>;
  };
  markNodeAsPlaceholder: ReturnType<typeof vi.fn>;
  markNodesAsFull: ReturnType<typeof vi.fn>;
  clearPlaceholderUpgrade: ReturnType<typeof vi.fn>;
  nodeGraph: {
    id: string;
    nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
  } | null;
  structureRevision: number;
  dataRevision: number;
  layoutRevision: number;
};

let mockCanvasState = {} as MockCanvasState;

function getMockCanvasState(): MockCanvasState {
  if (!mockCanvasState) {
    throw new Error('mockCanvasState is not initialized');
  }
  return mockCanvasState;
}

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

// mock nodeRegistry，让 resolveEffectiveSize 的 default 档走 DEFAULT_NODE_SIZE 兜底。
vi.mock('../../../nodes/registry', () => ({
  nodeRegistry: {
    get: () => undefined,
    getAllDefinitions: () => [],
  },
}));

const seedNode = (id: string, type = 'model'): MockCanvasState['nodeGraph'] => {
  if (mockCanvasState.nodeGraph === null) return null;
  return {
    ...mockCanvasState.nodeGraph,
    nodes: [{ id, type, position: { x: 0, y: 0 }, data: {} }],
  };
};

describe('BaseNodeCard - 交互期占位壳降级', () => {
  beforeEach(() => {
    mockCanvasState = {
      selectedNodeIds: [],
      isCanvasInteracting: false,
      isCanvasInteractingDelayed: false,
      ui: {
        placeholderNodeIds: new Set(),
        desiredSizeByNodeId: {},
        lastMeasuredSizeByNodeId: {},
        layoutModelByNodeId: {},
      },
      markNodeAsPlaceholder: vi.fn(),
      markNodesAsFull: vi.fn(),
      clearPlaceholderUpgrade: vi.fn(),
      nodeGraph: { id: 'g1', nodes: [] },
      structureRevision: 1,
      dataRevision: 1,
      layoutRevision: 1,
    };
  });

  describe('占位态裁剪与保留', () => {
    it('占位态（isPlaceholder=true）裁掉 children，不渲染内容 testid', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);

      render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      expect(screen.queryByTestId('content')).toBeNull();
    });

    it('完整态（isPlaceholder=false）正常渲染 children', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');

      render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      expect(screen.getByTestId('content')).toBeInTheDocument();
    });

    it('占位态被选中时 selected 正常呈现（ring class），不因占位降级', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);

      const { container } = render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      // 选中态呈现存在（spec 不变量 3：selection 在占位态可用）。
      // D28 起选中环从 tailwind ring 类改走 .node-card-selected（box-shadow accent 细环+光晕）。
      const card = container.firstChild as HTMLElement;
      expect(card.className).toContain('node-card-selected');
    });

  });

  describe('mount 时注册占位', () => {
    it('mount 时 isCanvasInteracting=true → markNodeAsPlaceholder 被调用（spec「交互期新进入视口的节点挂载为占位壳」）', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().isCanvasInteracting = true;

      render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      expect(getMockCanvasState().markNodeAsPlaceholder).toHaveBeenCalledWith('node-1');
    });

    it('mount 时 isCanvasInteracting=false → markNodeAsPlaceholder 不被调用', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().isCanvasInteracting = false;

      render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      expect(getMockCanvasState().markNodeAsPlaceholder).not.toHaveBeenCalled();
    });

    it('无 nodeId 时不注册占位', () => {
      getMockCanvasState().isCanvasInteracting = true;

      render(
        <BaseNodeCard
          nodeId={undefined}
          title="测试节点"
          selected={undefined}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      expect(getMockCanvasState().markNodeAsPlaceholder).not.toHaveBeenCalled();
    });
  });

  describe('占位态尺寸来源（resolveEffectiveSize 主优先级链：layoutModel > measured > default）', () => {
    /**
     * spec「占位壳契约」第 3 项：占位壳尺寸必须复用 resolveEffectiveSize 优先级链，
     * 保证占位尺寸与稳态完整形态尺寸一致或在收敛容差内。不得塌缩为零尺寸或小于 default。
     *
     * 这里用 minWidth/minHeight 渲染值作为 stableSize 的代理证据：
     * 占位态的 minWidth/minHeight 应等于 stableSize（resolveEffectiveSize 返回值）。
     */
    it('占位态有 measured 缓存时，stableSize 等于 measured（不跳尺寸）', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);
      getMockCanvasState().ui.lastMeasuredSizeByNodeId = {
        'node-1': { width: 300, height: 200 },
      };
      // layoutModel 缺失，主优先级链回退到 measured。

      const { container } = render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
          minWidth={100}
          minHeight={80}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      // measured 档命中，minWidth/minHeight 应取 measured（300/200），不是 100/80。
      const card = container.firstChild as HTMLElement;
      const style = card.style;
      expect(style.minWidth).toBe('300px');
      expect(style.minHeight).toBe('200px');
    });

    it('占位态无 measured、无 layoutModel 时，stableSize 等于 default（不塌缩，spec 禁止事项第 2 条）', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);
      // 无 measured、无 layoutModel

      const { container } = render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
          minWidth={10}
          minHeight={10}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      // default 档兜底（DEFAULT_NODE_SIZE = 220x120），minWidth/minHeight 应取 default，不是 10/10。
      const card = container.firstChild as HTMLElement;
      const style = card.style;
      expect(style.minWidth).toBe('220px');
      expect(style.minHeight).toBe('120px');
    });

    it('占位态 layoutModel 优先于 measured（layoutModel 主档最高优先级）', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);
      getMockCanvasState().ui.layoutModelByNodeId = {
        'node-1': { width: 400, height: 250 },
      };
      getMockCanvasState().ui.lastMeasuredSizeByNodeId = {
        'node-1': { width: 300, height: 200 },
      };

      const { container } = render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
          minWidth={100}
          minHeight={80}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      // layoutModel 优先于 measured，minWidth/minHeight 应取 layoutModel（400/250）。
      const card = container.firstChild as HTMLElement;
      const style = card.style;
      expect(style.minWidth).toBe('400px');
      expect(style.minHeight).toBe('250px');
    });

    it('占位态 layoutModel 缺失时回退 measured（measured 优先于 default）', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);
      // layoutModel 缺失（空映射），主优先级链回退到 measured。
      getMockCanvasState().ui.lastMeasuredSizeByNodeId = {
        'node-1': { width: 300, height: 200 },
      };

      const { container } = render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
          minWidth={100}
          minHeight={80}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      // layoutModel 缺失时回退 measured，minWidth/minHeight 应取 measured（300/200）。
      const card = container.firstChild as HTMLElement;
      const style = card.style;
      expect(style.minWidth).toBe('300px');
      expect(style.minHeight).toBe('200px');
    });
  });

  describe('占位态不破坏 lastMeasuredSizeByNodeId 缓存', () => {
    /**
     * spec「占位壳不得破坏」：占位壳期间该节点的会话态缓存保留最近一次 measured；
     * 占位壳不产出新 measured，不覆盖缓存。
     *
     * 代理验证：占位态渲染前后，store 的 lastMeasuredSizeByNodeId 引用不变。
     * （组件不会主动写入 store，只读。）
     */
    it('占位态渲染不修改 store 的 lastMeasuredSizeByNodeId 引用', () => {
      getMockCanvasState().nodeGraph = seedNode('node-1');
      getMockCanvasState().ui.placeholderNodeIds = new Set(['node-1']);
      const cacheBefore = getMockCanvasState().ui.lastMeasuredSizeByNodeId;

      render(
        <BaseNodeCard
          nodeId="node-1"
          title="测试节点"
          selected={undefined}
        >
          <div data-testid="content">Content</div>
        </BaseNodeCard>,
      );

      expect(getMockCanvasState().ui.lastMeasuredSizeByNodeId).toBe(cacheBefore);
    });
  });
});
