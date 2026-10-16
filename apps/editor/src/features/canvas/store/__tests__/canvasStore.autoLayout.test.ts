import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode, NodePosition, TextInputNodeData } from '../../types';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { buildCanvasSizeSources, type OccupancyRect } from '../../utils/nodeOccupancy';
import { resolveEffectiveSizeByNodeId } from '../../utils/effectiveSize';
import { rectsIntersect } from '../../utils/taskNodePlacement';

// 全局整理（scope=all）行为测试：真实节点图 → 真实 store action（禁止手工构造理想输入）。
// 覆盖：散点避开容器占位（展开态组按成员派生包围盒）、锚点保持（整块包围盒左上角与
// 整理前一致）、CLI 与工具栏两入口同行为。spec：画布自动布局算法.md「容器几何约束」、
// 画布节点组.md「自动布局协作」。

const createTestGraph = () =>
  createNodeGraph({
    name: 'auto-layout-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = async () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
  });
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
};

const addTextInputNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): GraphNode<TextInputNodeData> => {
  const node: GraphNode<TextInputNodeData> = {
    id,
    type: 'textInput',
    position: { x, y },
    data: {
      label: undefined,
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: undefined,
      customSeparator: undefined,
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
  return node;
};

const findNode = (id: string): GraphNode | undefined => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return undefined;
  return graph.nodes.find((n) => n.id === id);
};

const freeBlockTopLeft = (ids: readonly string[]): NodePosition => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const node = findNode(id);
    if (!node) continue;
    if (node.position.x < minX) minX = node.position.x;
    if (node.position.y < minY) minY = node.position.y;
  }
  return { x: minX, y: minY };
};

describe('全局整理：散点避开容器占位与锚点保持', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AL-GC-001
  it('大组占位区内的散点整理后被挪出容器派生包围盒（组与成员不动）', async () => {
    // 真实链路建组：成员远距离摆放 → 组派生包围盒远大于单节点尺寸（~2200px 高）
    addTextInputNode('gm1', 0, 0);
    addTextInputNode('gm2', 0, 2000);
    const groupId = useCanvasStore.getState().createGroup(['gm1', 'gm2'], undefined);
    expect(groupId).not.toBeNull();
    // 散点落在组派生包围盒内部（现状实现把散点甩到原点单列，与组占位相交）
    addTextInputNode('f1', 100, 100);
    addTextInputNode('f2', 140, 140);
    addTextInputNode('f3', 180, 180);

    const groupBefore = findNode(groupId as string)?.position;
    const gm1Before = findNode('gm1')?.position;
    const gm2Before = findNode('gm2')?.position;
    expect(groupBefore).toBeDefined();

    const result = await useCanvasStore.getState().autoLayout(undefined);
    expect(result).not.toBeNull();
    expect(result?.changedCount).toBeGreaterThan(0);

    // 作用域外不回写：组节点与成员位置保持
    expect(findNode(groupId as string)?.position).toEqual(groupBefore);
    expect(findNode('gm1')?.position).toEqual(gm1Before);
    expect(findNode('gm2')?.position).toEqual(gm2Before);

    // 容器占位用真实派生 owner（与实现同一几何源），禁止手工估算包围盒
    const graph = useCanvasStore.getState().nodeGraph;
    expect(graph).not.toBeNull();
    const sizeSources = buildCanvasSizeSources(useCanvasStore.getState());
    const derived = buildGroupDerivedSize({ nodes: graph?.nodes ?? [], sizeSources });
    const entry = derived.byGroupId[groupId as string];
    expect(entry).toBeDefined();
    if (!entry) return;
    const groupRect: OccupancyRect = {
      x: entry.position.x,
      y: entry.position.y,
      width: entry.size.width,
      height: entry.size.height,
    };
    // 大组判据：派生包围盒远大于默认节点尺寸
    expect(groupRect.height).toBeGreaterThan(1800);

    const freeIds = ['f1', 'f2', 'f3'];
    const freeNodes = (graph?.nodes ?? []).filter((n) => freeIds.includes(n.id));
    const sizes = resolveEffectiveSizeByNodeId(freeNodes, sizeSources);
    for (const id of freeIds) {
      const node = findNode(id);
      expect(node).toBeDefined();
      const size = sizes[id];
      expect(size).toBeDefined();
      const rect: OccupancyRect = {
        x: node?.position.x ?? 0,
        y: node?.position.y ?? 0,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
      };
      expect(rectsIntersect(rect, groupRect)).toBe(false);
    }
  });

  // @spec: AL-GC-002
  it('CLI 路径（autoLayout 缺省 options）整理后整块包围盒左上角与整理前一致（不甩到原点）', async () => {
    addTextInputNode('f1', 1000, 1000);
    addTextInputNode('f2', 1040, 1040);

    await useCanvasStore.getState().autoLayout(undefined);

    expect(freeBlockTopLeft(['f1', 'f2'])).toEqual({ x: 1000, y: 1000 });
  });

  // @spec: AL-GC-002
  it('--columns 透传后锚点补偿照旧（块形状变化不改变锚点口径）', async () => {
    addTextInputNode('f1', 1000, 1000);
    addTextInputNode('f2', 1040, 1040);
    addTextInputNode('f3', 1080, 1080);

    await useCanvasStore.getState().autoLayout({
      measuredSizeByNodeId: undefined,
      derivedSizeByNodeId: undefined,
      columns: 2,
    });

    expect(freeBlockTopLeft(['f1', 'f2', 'f3'])).toEqual({ x: 1000, y: 1000 });
  });

  // @spec: AL-GC-002
  it('工具栏路径（autoLayoutWithPreMeasure）与 CLI 路径行为一致（同一锚点口径）', async () => {
    addTextInputNode('f1', 1000, 1000);
    addTextInputNode('f2', 1040, 1040);

    await useCanvasStore.getState().autoLayoutWithPreMeasure({
      measuredSizeByNodeId: undefined,
      derivedSizeByNodeId: undefined,
    });

    expect(freeBlockTopLeft(['f1', 'f2'])).toEqual({ x: 1000, y: 1000 });
  });
});
