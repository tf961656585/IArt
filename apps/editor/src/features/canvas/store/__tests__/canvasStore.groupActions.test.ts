// @spec: AG-CN-018, AL-GC-003, AL-GC-004, AL-GC-005, AL-GC-006
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GraphNode, GroupNodeData, TextInputNodeData } from '../../types';
import type { AgentNodeData } from '../../types/agentNode';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '../../utils/nodeOccupancy';
import { rectsIntersect } from '../../utils/taskNodePlacement';
import type { CanvasGroupAutoLayoutStoreOptions } from '../internal/canvasStore.core';

const createTestGraph = () =>
  createNodeGraph({
    name: 'group-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
  });
};

const addTextInputNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): GraphNode<TextInputNodeData> => {
  const store = useCanvasStore.getState();
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
  if (store.nodeGraph) {
    useCanvasStore.setState((s) => {
      if (s.nodeGraph) {
        s.nodeGraph.nodes.push(node);
        s.structureRevision += 1;
      }
    });
  }
  return node;
};

/** Agent 容器节点（AgentNodeData 持 agentSessionId 与可选 collapsed） */
const addAgentNode = (
  id: string,
  x = 0,
  y = 0,
  collapsed = false,
): GraphNode<AgentNodeData> => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x, y },
    data: { label: 'Agent 节点', agentSessionId: `session-${id}`, collapsed },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
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

const getGroupNodeData = (id: string): GroupNodeData => {
  const node = findNode(id);
  if (!node || node.type !== 'group') throw new Error(`group node ${id} not found`);
  return node.data as GroupNodeData;
};

describe('canvasStore group actions', () => {
  beforeEach(() => {
    resetStore();
    void useCanvasStore.getState().loadNodeGraph(createTestGraph());
  });

  describe('createGroup', () => {
    it('多选节点创建组：成员 groupId 指向新组', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      expect(groupId).not.toBeNull();
      const n1 = findNode('n1');
      const n2 = findNode('n2');
      expect(n1?.groupId).toBe(groupId);
      expect(n2?.groupId).toBe(groupId);
      const groupNode = findNode(groupId as string);
      expect(groupNode?.type).toBe('group');
      expect(groupNode?.groupId).toBeUndefined();
    });

    it('组节点位置取成员派生渲染框左上角（成员包围盒 − (12, 40)）', () => {
      addTextInputNode('n1', 150, 120);
      addTextInputNode('n2', 100, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      expect(groupId).not.toBeNull();
      const groupNode = findNode(groupId as string);
      // 成员最小 x=100, 最小 y=120；派生渲染框左上角 = (100-12, 120-8-32) = (88, 80)
      expect(groupNode?.position).toEqual({ x: 88, y: 80 });
    });

    it('空组保持调用方给的位置（无成员可派生）', () => {
      const groupId = useCanvasStore
        .getState()
        .createGroup([], { x: 400, y: 300 }, { allowEmpty: true });
      expect(groupId).not.toBeNull();
      expect(findNode(groupId as string)?.position).toEqual({ x: 400, y: 300 });
    });

    it('已是组成员的节点不被纳入新组', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      addTextInputNode('n3', 300, 300);
      const g1 = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      // n1、n2 已在 g1，尝试把它们和 n3 再建组：只有 n3 被纳入
      const g2 = useCanvasStore.getState().createGroup(['n1', 'n2', 'n3'], undefined);
      expect(g2).not.toBeNull();
      expect(findNode('n3')?.groupId).toBe(g2);
      expect(findNode('n1')?.groupId).toBe(g1); // 仍属 g1
    });

    it('选中含组节点时跳过组节点（组不可嵌套）', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const g1 = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      // 尝试把 g1 和 n1 再建组：g1 被跳过，n1 已是成员也被跳过 → 无可纳入节点
      const result = useCanvasStore.getState().createGroup([g1 as string, 'n1'], undefined);
      expect(result).toBeNull();
    });

    it('空节点列表返回 null', () => {
      expect(useCanvasStore.getState().createGroup([], undefined)).toBeNull();
    });
  });

  describe('ungroupNode', () => {
    it('解组：成员 groupId 清空，组节点删除', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      expect(groupId).not.toBeNull();

      useCanvasStore.getState().ungroupNode(groupId as string);

      expect(findNode(groupId as string)).toBeUndefined();
      expect(findNode('n1')?.groupId).toBeUndefined();
      expect(findNode('n2')?.groupId).toBeUndefined();
      // 成员节点仍在
      expect(findNode('n1')).toBeDefined();
      expect(findNode('n2')).toBeDefined();
    });
  });

  describe('renameGroup', () => {
    it('更新组名', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      useCanvasStore.getState().renameGroup(groupId as string, '我的组');
      expect(getGroupNodeData(groupId as string).name).toBe('我的组');
    });
  });

  describe('setGroupColor', () => {
    it('更新组颜色', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      useCanvasStore.getState().setGroupColor(groupId as string, '#22C55E');
      expect(getGroupNodeData(groupId as string).color).toBe('#22C55E');
    });

    it('对不存在或非组 id 无操作', () => {
      addTextInputNode('n1', 100, 100);
      useCanvasStore.getState().setGroupColor('missing-id', '#22C55E');
      // 无节点图异常、无隐式写入
      expect(useCanvasStore.getState().nodeGraph?.nodes.find((n) => n.id === 'missing-id')).toBeUndefined();
    });
  });

  describe('toggleGroupCollapse', () => {
    it('切换折叠态', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);
      expect(getGroupNodeData(groupId as string).collapsed).toBe(false);

      useCanvasStore.getState().toggleGroupCollapse(groupId as string);
      expect(getGroupNodeData(groupId as string).collapsed).toBe(true);

      useCanvasStore.getState().toggleGroupCollapse(groupId as string);
      expect(getGroupNodeData(groupId as string).collapsed).toBe(false);
    });
  });

  describe('删除语义（dissolve 默认 + 显式连删）', () => {
    it('默认删除组（dissolve）保留成员为自由节点', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      addTextInputNode('n3', 300, 300); // 自由节点
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);

      useCanvasStore.getState().removeNodes([groupId as string], undefined);

      // 组节点被删除
      expect(findNode(groupId as string)).toBeUndefined();
      // 成员保留，groupId 置 undefined（成为自由节点）
      expect(findNode('n1')).toBeDefined();
      expect(findNode('n1')?.groupId).toBeUndefined();
      expect(findNode('n2')).toBeDefined();
      expect(findNode('n2')?.groupId).toBeUndefined();
      // 自由节点不受影响
      expect(findNode('n3')).toBeDefined();
    });

    it('显式连删（deleteGroupMembers=true）删除组节点 + 全部成员', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      addTextInputNode('n3', 300, 300);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);

      useCanvasStore.getState().removeNodes([groupId as string], { deleteGroupMembers: true });

      expect(findNode(groupId as string)).toBeUndefined();
      expect(findNode('n1')).toBeUndefined();
      expect(findNode('n2')).toBeUndefined();
      // 自由节点不受影响
      expect(findNode('n3')).toBeDefined();
    });

    it('删除单个成员不影响组与其他成员', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);

      useCanvasStore.getState().removeNodes(['n1'], undefined);

      expect(findNode('n1')).toBeUndefined();
      expect(findNode('n2')).toBeDefined();
      expect(findNode('n2')?.groupId).toBe(groupId);
      expect(findNode(groupId as string)).toBeDefined();
    });
  });

  describe('动态成员关系变更', () => {
    it('addNodesToGroup 把自由节点加入目标组', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1'], undefined);
      expect(groupId).not.toBeNull();

      useCanvasStore.getState().addNodesToGroup(['n2'], groupId as string);

      expect(findNode('n2')?.groupId).toBe(groupId);
      // 原成员不受影响
      expect(findNode('n1')?.groupId).toBe(groupId);
    });

    it('addNodesToGroup 排除已是目标组成员的节点', () => {
      addTextInputNode('n1', 100, 100);
      const groupId = useCanvasStore.getState().createGroup(['n1'], undefined);

      // n1 已是 g1 成员，再调 addNodesToGroup 应无操作（不报错）
      useCanvasStore.getState().addNodesToGroup(['n1'], groupId as string);

      expect(findNode('n1')?.groupId).toBe(groupId);
    });

    it('addNodesToGroup 排除组节点本身（组不可嵌套）', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId1 = useCanvasStore.getState().createGroup(['n1'], undefined);
      const groupId2 = useCanvasStore.getState().createGroup(['n2'], undefined);
      expect(groupId1).not.toBeNull();
      expect(groupId2).not.toBeNull();

      // 尝试把 g2 加入 g1，应被排除（组不可嵌套）
      useCanvasStore.getState().addNodesToGroup([groupId2 as string], groupId1 as string);

      expect(findNode(groupId2 as string)?.groupId).toBeUndefined();
    });

    it('addNodesToGroup 目标组不存在时无操作', () => {
      addTextInputNode('n1', 100, 100);

      useCanvasStore.getState().addNodesToGroup(['n1'], 'nonexistent-group');

      expect(findNode('n1')?.groupId).toBeUndefined();
    });

    it('removeNodesFromGroup 把成员移出组', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1', 'n2'], undefined);

      useCanvasStore.getState().removeNodesFromGroup(['n1']);

      expect(findNode('n1')?.groupId).toBeUndefined();
      // 其他成员不受影响
      expect(findNode('n2')?.groupId).toBe(groupId);
      expect(findNode(groupId as string)).toBeDefined();
    });

    it('removeNodesFromGroup 排除非组成员', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['n1'], undefined);

      // n2 不是任何组成员，应被排除（不报错）
      useCanvasStore.getState().removeNodesFromGroup(['n2']);

      expect(findNode('n2')?.groupId).toBeUndefined();
      expect(findNode('n1')?.groupId).toBe(groupId);
    });

    it('moveNodesBetweenGroups 跨组迁移覆盖原 groupId', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId1 = useCanvasStore.getState().createGroup(['n1'], undefined);
      const groupId2 = useCanvasStore.getState().createGroup(['n2'], undefined);
      expect(groupId1).not.toBeNull();
      expect(groupId2).not.toBeNull();

      useCanvasStore.getState().moveNodesBetweenGroups(['n1'], groupId2 as string);

      expect(findNode('n1')?.groupId).toBe(groupId2);
    });

    it('动态成员关系变更作为单次 undo/redo 历史条目', () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const groupId1 = useCanvasStore.getState().createGroup(['n1'], undefined);
      const groupId2 = useCanvasStore.getState().createGroup(['n2'], undefined);

      useCanvasStore.getState().saveToHistory();
      const historyBaseline = useCanvasStore.getState().history.length;

      // addNodesToGroup 应产生 1 条历史（把 n2 加入 g1，但 n2 已是 g2 成员→跨组迁移语义）
      useCanvasStore.getState().addNodesToGroup(['n2'], groupId1 as string);
      expect(useCanvasStore.getState().history).toHaveLength(historyBaseline + 1);

      // removeNodesFromGroup 应产生 1 条历史
      useCanvasStore.getState().removeNodesFromGroup(['n2']);
      expect(useCanvasStore.getState().history).toHaveLength(historyBaseline + 2);

      // moveNodesBetweenGroups 应产生 1 条历史（把 n1 从 g1 迁到 g2）
      useCanvasStore.getState().moveNodesBetweenGroups(['n1'], groupId2 as string);
      expect(useCanvasStore.getState().history).toHaveLength(historyBaseline + 3);
    });
  });

  describe('autoLayout 全局整理作用域', () => {
    it('全局整理跳过组内成员，只重排自由节点', async () => {
      addTextInputNode('free1', 100, 100);
      addTextInputNode('free2', 300, 300);
      addTextInputNode('member1', 500, 500);
      addTextInputNode('member2', 600, 600);
      const groupId = useCanvasStore.getState().createGroup(['member1', 'member2'], undefined);
      expect(groupId).not.toBeNull();

      const member1Before = findNode('member1')?.position;
      const member2Before = findNode('member2')?.position;

      const result = await useCanvasStore.getState().autoLayout(undefined);
      expect(result).not.toBeNull();

      // 组内成员位置不应被全局整理改写
      expect(findNode('member1')?.position).toEqual(member1Before);
      expect(findNode('member2')?.position).toEqual(member2Before);
    });

    it('全局整理不改写组节点 position（派生量，由成员派生）', async () => {
      addTextInputNode('free1', 100, 100);
      addTextInputNode('member1', 500, 500);
      addTextInputNode('member2', 600, 600);
      const groupId = useCanvasStore.getState().createGroup(['member1', 'member2'], undefined);
      expect(groupId).not.toBeNull();

      const groupBefore = findNode(groupId as string)?.position;

      await useCanvasStore.getState().autoLayout(undefined);

      // 组节点 position 不被算法输出回写
      expect(findNode(groupId as string)?.position).toEqual(groupBefore);
    });

    it('全局整理：含大组节点的画布，自由节点 y 跨度不受组节点派生高度污染', async () => {
      // 验证修复「整理后一堆在很上方、一堆在很下方」的核心保护（spec：画布自动布局算法.md
      // 「组节点在布局中的地位」）。组节点不参与位置布局计算，自由节点 y 跨度应紧凑。
      addTextInputNode('free1', 100, 100);
      addTextInputNode('free2', 200, 200);
      addTextInputNode('free3', 300, 300);
      // 创建一个含成员的组（成员被排除在全局整理作用域外，组节点本身也不参与）
      addTextInputNode('member1', 5000, 5000);
      addTextInputNode('member2', 5200, 5200);
      const groupId = useCanvasStore.getState().createGroup(['member1', 'member2'], undefined);
      expect(groupId).not.toBeNull();

      await useCanvasStore.getState().autoLayout(undefined);

      // 自由节点（free1/2/3）整理后位置应紧凑（算法以原点为基准，三节点垂直栈或紧凑排布）。
      // 若组节点污染了布局，自由节点会被推到 y≈数千处（成员远在 5000+ 不影响，因成员不参与）。
      const freeYs = ['free1', 'free2', 'free3'].map((id) => findNode(id)?.position.y ?? 0);
      const ySpan = Math.max(...freeYs) - Math.min(...freeYs);
      // 三节点 y 跨度应紧凑（< 1000），不受组节点/成员位置污染
      expect(ySpan).toBeLessThan(1000);
    });
  });

  describe('autoLayoutContainer 容器内整理锚点吸附（组）', () => {
    it('容器内整理后成员包围盒左上角吸附到最近网格点（默认 snapGrid 15）', async () => {
      addTextInputNode('m1', 800, 700);
      addTextInputNode('m2', 900, 850);
      addTextInputNode('m3', 1100, 780);
      const groupId = useCanvasStore.getState().createGroup(['m1', 'm2', 'm3'], undefined);
      expect(groupId).not.toBeNull();

      // 整理前成员包围盒左上角吸附到最近网格点：800→795、700→705
      const alignedMinX = 795;
      const alignedMinY = 705;

      const result = await useCanvasStore.getState().autoLayoutContainer(groupId as string, undefined);
      expect(result).not.toBeNull();

      // 整理后成员包围盒左上角必须保持不变
      const afterM1 = findNode('m1')?.position;
      const afterM2 = findNode('m2')?.position;
      const afterM3 = findNode('m3')?.position;
      expect(afterM1).toBeDefined();
      expect(afterM2).toBeDefined();
      expect(afterM3).toBeDefined();
      const afterMinX = Math.min(
        (afterM1 ?? { x: Infinity }).x,
        (afterM2 ?? { x: Infinity }).x,
        (afterM3 ?? { x: Infinity }).x,
      );
      const afterMinY = Math.min(
        (afterM1 ?? { y: Infinity }).y,
        (afterM2 ?? { y: Infinity }).y,
        (afterM3 ?? { y: Infinity }).y,
      );
      expect(afterMinX).toBe(alignedMinX);
      expect(afterMinY).toBe(alignedMinY);
    });

    it('容器内整理不改动组外节点 position', async () => {
      addTextInputNode('outside', 2000, 2000);
      addTextInputNode('m1', 800, 700);
      addTextInputNode('m2', 900, 850);
      const groupId = useCanvasStore.getState().createGroup(['m1', 'm2'], undefined);

      const outsideBefore = findNode('outside')?.position;

      await useCanvasStore.getState().autoLayoutContainer(groupId as string, undefined);

      expect(findNode('outside')?.position).toEqual(outsideBefore);
    });

    it('给出列数时按网格分行摆放，并保持锚点吸附口径', async () => {
      addTextInputNode('m1', 800, 700);
      addTextInputNode('m2', 900, 850);
      addTextInputNode('m3', 1100, 780);
      addTextInputNode('m4', 1200, 900);
      const groupId = useCanvasStore.getState().createGroup(
        ['m1', 'm2', 'm3', 'm4'],
        undefined,
      );
      expect(groupId).not.toBeNull();

      const result = await useCanvasStore
        .getState()
        .autoLayoutContainer(groupId as string, {
          measuredSizeByNodeId: undefined,
          derivedSizeByNodeId: undefined,
          columns: 2,
          // 显式 order 固定占格序（缺省视觉序见「排序口径与重排差异」用例）
          order: ['m1', 'm2', 'm3', 'm4'],
        });
      expect(result).not.toBeNull();

      const [p1, p2, p3, p4] = ['m1', 'm2', 'm3', 'm4'].map(
        (id) => findNode(id)?.position,
      );
      if (!p1 || !p2 || !p3 || !p4) throw new Error('expected member positions');
      // 两列：第一行 m1/m2 同 y、x 递增；第二行 m3/m4 同 y 且 y 大于第一行
      expect(p1.y).toBe(p2.y);
      expect(p1.x).toBeLessThan(p2.x);
      expect(p3.y).toBe(p4.y);
      expect(p3.y).toBeGreaterThan(p1.y);
      expect(p3.x).toBe(p1.x);

      // 锚点吸附：整理后成员包围盒左上角 = 整理前锚点吸附到最近网格点
      expect(Math.min(p1.x, p2.x, p3.x, p4.x)).toBe(795);
      expect(Math.min(p1.y, p2.y, p3.y, p4.y)).toBe(705);
    });
  });

  describe('autoLayoutContainer 排序口径与重排差异（batch 1a）', () => {
    type OrderSummary = {
      contentReordered: boolean;
      orderChanges: Array<{ nodeId: string; fromSlot: number; toSlot: number }>;
    };
    // store core 的 options / 返回类型尚未包含本批新增字段（契约收敛由主 agent 统一），
    // 测试侧用更宽的本地类型转接：扩展字段可选，可赋值给核心 options 类型，无需断言。
    type ExtendedContainerOptions = CanvasGroupAutoLayoutStoreOptions & {
      gap?: number | undefined;
      orderMode?: 'position' | 'insertion' | 'created' | undefined;
      order_mode?: 'position' | 'insertion' | 'created' | undefined;
    };
    const layoutContainer = (containerId: string, options: ExtendedContainerOptions) =>
      useCanvasStore.getState().autoLayoutContainer(containerId, options);
    // 返回形状新增字段：单次断言读取（不改变运行时行为）。
    const withOrderSummary = <T,>(result: T): T & OrderSummary => result as T & OrderSummary;

    /** 插入序与视觉序相反的两成员组：先加入下方的 bottom，再加入上方的 top。 */
    const setupInvertedGroup = (): string => {
      addTextInputNode('bottom', 800, 900);
      addTextInputNode('top', 800, 700);
      const groupId = useCanvasStore.getState().createGroup(['bottom', 'top'], undefined);
      if (groupId === null) throw new Error('建组失败');
      return groupId;
    };

    const yOf = (id: string): number => findNode(id)?.position.y ?? Number.NaN;

    it('缺省按视觉阅读序占格（README 阅读方向），并报告 content_reordered=false', async () => {
      const groupId = setupInvertedGroup();
      const result = await layoutContainer(groupId, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
      });
      if (result === null) throw new Error('整理未执行');
      // 视觉序：top(y=700) 在 bottom(y=900) 之前
      expect(yOf('top')).toBeLessThan(yOf('bottom'));
      const summary = withOrderSummary(result);
      expect(summary.contentReordered).toBe(false);
      expect(summary.orderChanges).toEqual([]);
    });

    it('orderMode=insertion 按插入序占格，并报告重排差异', async () => {
      const groupId = setupInvertedGroup();
      const result = await layoutContainer(groupId, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
        orderMode: 'insertion',
      });
      if (result === null) throw new Error('整理未执行');
      expect(yOf('bottom')).toBeLessThan(yOf('top'));
      const summary = withOrderSummary(result);
      expect(summary.contentReordered).toBe(true);
      expect(summary.orderChanges).toEqual([
        { nodeId: 'bottom', fromSlot: 1, toSlot: 0 },
        { nodeId: 'top', fromSlot: 0, toSlot: 1 },
      ]);
    });

    it('显式 order 优先于排序口径（缺省视觉序时仍按 order 占格）', async () => {
      const groupId = setupInvertedGroup();
      const result = await layoutContainer(groupId, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
        order: ['bottom', 'top'],
      });
      if (result === null) throw new Error('整理未执行');
      expect(yOf('bottom')).toBeLessThan(yOf('top'));
      expect(withOrderSummary(result).contentReordered).toBe(true);
    });

    it('order_mode=created 在画布侧按插入序处理（落 debug 后等价 insertion）', async () => {
      const groupId = setupInvertedGroup();
      const result = await layoutContainer(groupId, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
        order_mode: 'created',
      });
      if (result === null) throw new Error('整理未执行');
      expect(yOf('bottom')).toBeLessThan(yOf('top'));
    });

    it('组内 gap 透传：格子间距精确等于本次 gap（与缺省 120 相差 80）', async () => {
      // 两个互不相交的组，成员尺寸与相对位置相同，只有 gap 不同。
      addTextInputNode('a1', 800, 700);
      addTextInputNode('a2', 900, 850);
      const wideGroup = useCanvasStore.getState().createGroup(['a1', 'a2'], undefined);
      addTextInputNode('b1', 3000, 700);
      addTextInputNode('b2', 3100, 850);
      const narrowGroup = useCanvasStore.getState().createGroup(['b1', 'b2'], undefined);
      if (wideGroup === null || narrowGroup === null) throw new Error('建组失败');

      await layoutContainer(wideGroup, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
        gap: 120,
      });
      await layoutContainer(narrowGroup, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
        gap: 40,
      });

      const widePitch = yOf('a2') - yOf('a1');
      const narrowPitch = yOf('b2') - yOf('b1');
      expect(widePitch - narrowPitch).toBe(80);
      // 精确间距：同一成员尺寸下 pitch = 成员高 + gap，二者都不含网格取整残差
      expect(narrowPitch).toBeGreaterThan(40);
    });
  });

  describe('整理后视口信号', () => {
    it('容器内整理自增 layoutRevision（驱动尺寸缓存失效），不触发视口跳转', async () => {
      addTextInputNode('m1', 800, 700);
      addTextInputNode('m2', 900, 850);
      const groupId = useCanvasStore.getState().createGroup(['m1', 'm2'], undefined);

      const beforeLayout = useCanvasStore.getState().layoutRevision;

      await useCanvasStore.getState().autoLayoutContainer(groupId as string, undefined);

      // layoutRevision 自增（驱动尺寸缓存失效）
      expect(useCanvasStore.getState().layoutRevision).toBe(beforeLayout + 1);
    });

    it('全局整理自增 layoutRevision（驱动尺寸缓存失效），不触发视口跳转', async () => {
      addTextInputNode('free1', 100, 100);
      addTextInputNode('free2', 300, 300);

      const beforeLayout = useCanvasStore.getState().layoutRevision;

      await useCanvasStore.getState().autoLayout(undefined);

      expect(useCanvasStore.getState().layoutRevision).toBe(beforeLayout + 1);
    });
  });

  describe('容器内整理上浮（Agent 容器同语义 + 折叠门）', () => {
    it('Agent 容器内整理：成员单列排布、锚点保持、undo 整体恢复', async () => {
      addAgentNode('agent-1', 0, 0);
      addTextInputNode('a1', 800, 700, 'agent-1');
      addTextInputNode('a2', 900, 850, 'agent-1');
      addTextInputNode('a3', 1100, 780, 'agent-1');
      // 建立整理前历史基线（undo 恢复到它）
      useCanvasStore.getState().saveToHistory();

      const result = await useCanvasStore.getState().autoLayoutContainer('agent-1', undefined);
      // Agent 容器是容器节点：整理门按 isContainerNode 判定，不得被 type==='group' 拒绝
      expect(result).not.toBeNull();

      // 锚点吸附：整理后成员包围盒左上角 = 整理前锚点吸附到最近网格点（800→795, 700→705）
      const afterA1 = findNode('a1')?.position;
      const afterA2 = findNode('a2')?.position;
      const afterA3 = findNode('a3')?.position;
      expect(afterA1).toBeDefined();
      expect(afterA2).toBeDefined();
      expect(afterA3).toBeDefined();
      expect(
        Math.min((afterA1 ?? { x: Infinity }).x, (afterA2 ?? { x: Infinity }).x, (afterA3 ?? { x: Infinity }).x),
      ).toBe(795);
      expect(
        Math.min((afterA1 ?? { y: Infinity }).y, (afterA2 ?? { y: Infinity }).y, (afterA3 ?? { y: Infinity }).y),
      ).toBe(705);

      // undo 整体恢复成员位置与折叠态
      useCanvasStore.getState().undo();
      expect(findNode('a1')?.position).toEqual({ x: 800, y: 700 });
      expect(findNode('a2')?.position).toEqual({ x: 900, y: 850 });
      expect(findNode('a3')?.position).toEqual({ x: 1100, y: 780 });
    });

    it('折叠态容器内整理被拒绝（组与 Agent 容器一致）', async () => {
      // 组：折叠后不可整理（spec：画布节点组.md「折叠态容器内整理不可执行；需先展开」）
      addTextInputNode('m1', 100, 100);
      addTextInputNode('m2', 200, 200);
      const groupId = useCanvasStore.getState().createGroup(['m1', 'm2'], undefined);
      useCanvasStore.getState().toggleGroupCollapse(groupId as string);

      const groupResult = await useCanvasStore.getState().autoLayoutContainer(groupId as string, undefined);
      expect(groupResult).toBeNull();

      // Agent 容器：同一折叠门
      addAgentNode('agent-1', 0, 0);
      addTextInputNode('a1', 100, 100, 'agent-1');
      addTextInputNode('a2', 200, 200, 'agent-1');
      useCanvasStore.getState().toggleGroupCollapse('agent-1');

      const agentResult = await useCanvasStore.getState().autoLayoutContainer('agent-1', undefined);
      expect(agentResult).toBeNull();
    });

    it('容器内整理（组）含 Agent 容器成员：容器以包围盒为占位单元排布，其成员随位移传播跟随', async () => {
      addTextInputNode('m1', 800, 700);
      addAgentNode('agent-1', 2000, 2000);
      addTextInputNode('a1', 2000, 2000, 'agent-1');
      addTextInputNode('a2', 2100, 2200, 'agent-1');
      const groupId = useCanvasStore.getState().createGroup(['m1', 'agent-1'], undefined);
      expect(groupId).not.toBeNull();

      const agentBefore = findNode('agent-1')?.position;
      const a1Before = findNode('a1')?.position;
      const a2Before = findNode('a2')?.position;

      const result = await useCanvasStore.getState().autoLayoutContainer(groupId as string, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 2,
      });
      expect(result).not.toBeNull();

      const agentAfter = findNode('agent-1')?.position;
      expect(agentAfter).toBeDefined();
      if (!agentAfter || !agentBefore || !a1Before || !a2Before) throw new Error('missing positions');

      // Agent 容器按占位单元进入网格行：与 m1 同行同 y
      expect(agentAfter.y).toBe(findNode('m1')?.position?.y);

      // Agent 容器 position 是派生量：整理给它的目标位移必须展开为成员位移，
      // 否则写回值被派生投影覆盖，成员不动、容器视觉上不生效（断链）
      const dx = agentAfter.x - agentBefore.x;
      const dy = agentAfter.y - agentBefore.y;
      expect(dx !== 0 || dy !== 0).toBe(true);
      expect(findNode('a1')?.position).toEqual({ x: a1Before.x + dx, y: a1Before.y + dy });
      expect(findNode('a2')?.position).toEqual({ x: a2Before.x + dx, y: a2Before.y + dy });
    });

    it('空容器（成员数 0）整理返回 null（组与 Agent 容器一致）', async () => {
      addAgentNode('agent-empty', 0, 0);
      const agentResult = await useCanvasStore.getState().autoLayoutContainer('agent-empty', undefined);
      expect(agentResult).toBeNull();

      addTextInputNode('free-1', 100, 100);
      const emptyGroupId = useCanvasStore.getState().createGroup([], undefined);
      expect(emptyGroupId).toBeNull();
    });
  });

  describe('容器级防重叠（双组整理）', () => {
    /** 用 store 派生几何取容器矩形（与渲染/收口同一派生实现）。 */
    const derivedRect = (id: string) => {
      const graph = useCanvasStore.getState().nodeGraph;
      if (!graph) throw new Error('graph missing');
      const sizeSources = buildCanvasSizeSources(useCanvasStore.getState());
      const entry = buildGroupDerivedSize({ nodes: graph.nodes, sizeSources }).byGroupId[id];
      if (!entry) throw new Error(`容器派生 entry 缺失：${id}`);
      return {
        x: entry.position.x,
        y: entry.position.y,
        width: entry.size.width,
        height: entry.size.height,
      };
    };

    it('组 A 整理后不得与组 B 相交（整组让位），组 B 节点不动', async () => {
      // 组 A：成员纵向散布；组 B：紧邻 A 右侧（横向上与 A 整理后的派生矩形相交）
      addTextInputNode('a1', 0, 0);
      addTextInputNode('a2', 0, 400);
      const groupA = useCanvasStore.getState().createGroup(['a1', 'a2'], undefined);
      addTextInputNode('b1', 150, 0);
      addTextInputNode('b2', 150, 300);
      const groupB = useCanvasStore.getState().createGroup(['b1', 'b2'], undefined);
      if (groupA === null || groupB === null) throw new Error('建组失败');

      // 整理前 A/B 已相交（构造场景），整理后必须消解
      expect(rectsIntersect(derivedRect(groupA), derivedRect(groupB))).toBe(true);
      const b1Before = findNode('b1')?.position;
      const b2Before = findNode('b2')?.position;

      const result = await useCanvasStore.getState().autoLayoutContainer(groupA, {
        measuredSizeByNodeId: undefined,
        derivedSizeByNodeId: undefined,
        columns: 1,
      });
      expect(result).not.toBeNull();
      if (!result) throw new Error('整理未执行');

      expect(rectsIntersect(derivedRect(groupA), derivedRect(groupB))).toBe(false);
      // 组 B 是完全独立的最外层容器，不随 A 让位移动
      expect(findNode('b1')?.position).toEqual(b1Before);
      expect(findNode('b2')?.position).toEqual(b2Before);
      // 返回值位置 = 实际落位（成员同 delta 平移，相对布局保持）
      const a1 = findNode('a1')?.position;
      const a2 = findNode('a2')?.position;
      if (!a1 || !a2) throw new Error('成员位置缺失');
      const resultA1 = result.positions.a1;
      const resultA2 = result.positions.a2;
      if (!resultA1 || !resultA2) throw new Error('返回值缺少成员最终位置');
      expect(a1).toEqual(resultA1);
      expect(a2).toEqual(resultA2);
      expect(a2.y - a1.y).toBe(240);
    });

    it('单组无邻居时锚点吸附到最近网格点（让位逻辑不介入）', async () => {
      addTextInputNode('m1', 800, 700);
      addTextInputNode('m2', 900, 850);
      const groupId = useCanvasStore.getState().createGroup(['m1', 'm2'], undefined);
      if (groupId === null) throw new Error('建组失败');

      const before = derivedRect(groupId);
      const result = await useCanvasStore
        .getState()
        .autoLayoutContainer(groupId, {
          measuredSizeByNodeId: undefined,
          derivedSizeByNodeId: undefined,
          columns: 1,
        });
      expect(result).not.toBeNull();

      const after = derivedRect(groupId);
      // 无邻居可让位：容器锚点吸附到最近网格点（成员左上角 800/700 → 795/705），
      // 派生框 = 吸附后成员包围盒左上角 − (12, 40)。相对漂移只有吸附量 (5, 5)。
      expect(after.x).toBe(before.x - 5);
      expect(after.y).toBe(before.y + 5);
    });
  });
});
