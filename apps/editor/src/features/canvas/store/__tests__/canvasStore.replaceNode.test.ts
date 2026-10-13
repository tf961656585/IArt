import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type {
  AssetNodeData,
  CanvasAnnotation,
  GraphNode,
  TaskNodeData,
} from '../../types';

/**
 * 画布替换原语 replaceNode（spec docs/runtime/画布节点组.md AG-CN-017、
 * docs/editor/画布注释.md「替换继任」）。
 *
 * 构造性保证：
 * - 预检（不改图）：source 存在、非容器节点（含 agent）；creations 非空且 key 可创建；
 *   任一失败整体拒绝、画布零改动、debug 留痕；
 * - membership：override 优先，否则继承 source.groupId；新节点一律走 addNode 的
 *   membership 通道（canBeMemberOf 校验 + 降级留痕），不裸写 groupId；
 * - 历史原子：自开自关 historyBatchActive，一次替换 = 单条全图快照，undo/redo 一步到位；
 * - 绑定注释改绑首个继任节点（不级联删除），与替换合入同一条历史。
 */

const createTestGraph = () =>
  createNodeGraph({
    name: 'replace-node-test',
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

const store = () => useCanvasStore.getState();

const addTaskNode = (taskId: string, x = 100, y = 100): GraphNode<TaskNodeData> => {
  const node = store().addNode('task', { x, y }, {
    label: 'gpt-image-2',
    modelId: 'gpt-image-2',
    taskId,
    taskIndex: 0,
    batchId: 'batch-1',
    status: 'generating',
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
  } satisfies TaskNodeData);
  if (!node) throw new Error('任务节点创建失败');
  return node as GraphNode<TaskNodeData>;
};

const assetData = (assetId: string) => ({
  label: '素材',
  sourceBatchId: '',
  sourceTaskId: '',
  sourceModelId: '',
  mediaType: 'image',
  assetId,
});

const requireGraph = () => {
  const graph = store().nodeGraph;
  if (!graph) throw new Error('nodeGraph 为空');
  return graph;
};

const graphNodeIds = (): string[] => requireGraph().nodes.map((n) => n.id).sort();

const findTaskNode = (taskId: string): GraphNode<TaskNodeData> | undefined =>
  requireGraph().nodes.find(
    (n): n is GraphNode<TaskNodeData> =>
      n.type === 'task' && (n.data as TaskNodeData).taskId === taskId,
  );

const findAssetNode = (assetId: string): GraphNode<AssetNodeData> | undefined =>
  requireGraph().nodes.find(
    (n): n is GraphNode<AssetNodeData> =>
      n.type === 'asset' && (n.data as AssetNodeData).assetId === assetId,
  );

beforeEach(async () => {
  await resetStore();
});

describe('replaceNode 预检（整体拒绝、画布零改动）', () => {
  it('source 不存在：整体拒绝，返回空数组，画布零改动', () => {
    const before = graphNodeIds();
    const created = store().replaceNode(
      'missing-source',
      [{ key: 'asset', position: { x: 0, y: 0 }, data: assetData('a1') }],
    );
    expect(created).toEqual([]);
    expect(graphNodeIds()).toEqual(before);
  });

  it('source 是组容器：整体拒绝，画布零改动', () => {
    const task = addTaskNode('t0');
    const groupId = store().createGroup([task.id], undefined);
    if (groupId === null) throw new Error('建组失败');
    const before = graphNodeIds();

    const created = store().replaceNode(
      groupId,
      [{ key: 'asset', position: { x: 0, y: 0 }, data: assetData('a1') }],
    );
    expect(created).toEqual([]);
    expect(graphNodeIds()).toEqual(before);
  });

  it('source 是 Agent 容器：整体拒绝，画布零改动', () => {
    const agent = store().addNode('agent', { x: 0, y: 0 }, { agentSessionId: 's1' });
    if (!agent) throw new Error('Agent 节点创建失败');
    const before = graphNodeIds();

    const created = store().replaceNode(
      agent.id,
      [{ key: 'asset', position: { x: 0, y: 0 }, data: assetData('a1') }],
    );
    expect(created).toEqual([]);
    expect(graphNodeIds()).toEqual(before);
  });

  it('未知 key：整体拒绝，source 保留，画布零改动', () => {
    addTaskNode('t0');
    const before = graphNodeIds();

    const created = store().replaceNode(
      findTaskNode('t0')?.id ?? '',
      [{ key: 'definitely-not-a-node-key', position: { x: 0, y: 0 }, data: assetData('a1') }],
    );
    expect(created).toEqual([]);
    expect(graphNodeIds()).toEqual(before);
    expect(findTaskNode('t0')).toBeDefined();
  });

  it('creations 为空：整体拒绝，画布零改动', () => {
    addTaskNode('t0');
    const before = graphNodeIds();
    expect(store().replaceNode(findTaskNode('t0')?.id ?? '', [])).toEqual([]);
    expect(graphNodeIds()).toEqual(before);
  });
});

describe('replaceNode membership 判定', () => {
  // @spec: AG-CN-017
  it('默认继承 source.groupId：组内任务节点替换后继任资产入同组，任务节点移除', () => {
    const task = addTaskNode('t1');
    const groupId = store().createGroup([task.id], undefined);
    if (groupId === null) throw new Error('建组失败');

    const created = store().replaceNode(
      task.id,
      [{ key: 'asset', position: task.position, data: assetData('a1') }],
    );

    expect(created).toHaveLength(1);
    const asset = findAssetNode('a1');
    expect(asset).toBeDefined();
    expect(asset?.id).toBe(created[0]?.id);
    expect(asset?.groupId).toBe(groupId);
    expect(findTaskNode('t1')).toBeUndefined();
    // 组节点仍在
    expect(requireGraph().nodes.some((n) => n.id === groupId)).toBe(true);
  });

  it('membershipOverride 优先于继承', () => {
    const task = addTaskNode('t1');
    const groupA = store().createGroup([task.id], undefined);
    if (groupA === null) throw new Error('建组失败');
    const agent = store().addNode('agent', { x: 500, y: 500 }, { agentSessionId: 's1' });
    if (!agent) throw new Error('Agent 节点创建失败');

    const created = store().replaceNode(
      task.id,
      [{ key: 'asset', position: task.position, data: assetData('a1') }],
      { groupId: agent.id },
    );

    expect(created).toHaveLength(1);
    expect(findAssetNode('a1')?.groupId).toBe(agent.id);
    expect(findAssetNode('a1')?.groupId).not.toBe(groupA);
  });

  it('无组 source：继任节点为自由节点（groupId undefined）', () => {
    const task = addTaskNode('t1');

    const created = store().replaceNode(
      task.id,
      [{ key: 'asset', position: task.position, data: assetData('a1') }],
    );

    expect(created).toHaveLength(1);
    expect(findAssetNode('a1')?.groupId).toBeUndefined();
  });
});

describe('replaceNode 历史原子（单条全图快照）', () => {
  // @spec: FTB-006
  it('一次替换 = 一条历史：undo 一步回到替换前，redo 一步恢复', () => {
    const task = addTaskNode('t1');
    const groupId = store().createGroup([task.id], undefined);
    if (groupId === null) throw new Error('建组失败');
    store().saveToHistory();
    const baseline = store().history.length;

    const created = store().replaceNode(
      task.id,
      [
        { key: 'asset', position: task.position, data: assetData('a1') },
        { key: 'asset', position: { x: 380, y: 100 }, data: assetData('a2') },
      ],
    );
    expect(created).toHaveLength(2);
    expect(store().history.length).toBe(baseline + 1);

    // undo 一步：任务节点回来（成员关系在）、资产消失
    store().undo();
    expect(findTaskNode('t1')).toBeDefined();
    expect(findTaskNode('t1')?.groupId).toBe(groupId);
    expect(findAssetNode('a1')).toBeUndefined();
    expect(findAssetNode('a2')).toBeUndefined();

    // redo 一步：替换结果恢复（资产在且保持组员身份、任务节点移除）
    store().redo();
    expect(findTaskNode('t1')).toBeUndefined();
    expect(findAssetNode('a1')?.groupId).toBe(groupId);
    expect(findAssetNode('a2')?.groupId).toBe(groupId);
  });
});

describe('replaceNode 绑定注释改绑（替换继任，不级联删除）', () => {
  // @spec: AG-CN-017
  it('绑定 source 的注释改绑首个继任节点，undo 恢复原绑定', () => {
    const task = addTaskNode('t1');
    const annotation = store().addAnnotationForNode(task.id);
    expect(annotation).toBeTruthy();

    const created = store().replaceNode(
      task.id,
      [
        { key: 'asset', position: task.position, data: assetData('a1') },
        { key: 'asset', position: { x: 380, y: 100 }, data: assetData('a2') },
      ],
    );
    const firstId = created[0]?.id;
    if (firstId === undefined) throw new Error('继任节点创建失败');

    const annotations = requireGraph().annotations ?? [];
    const rebound = annotations.find((ann) => ann.id === annotation?.id);
    expect(rebound).toBeTruthy();
    expect(rebound?.binding).toEqual({ type: 'node', nodeId: firstId });
    // 注释不被级联删除
    expect(annotations.some((ann) => ann.id === annotation?.id)).toBe(true);

    // undo：注释绑定恢复指向任务节点
    store().undo();
    const restored = (requireGraph().annotations ?? []).find(
      (ann: CanvasAnnotation) => ann.id === annotation?.id,
    );
    expect(restored?.binding).toEqual({ type: 'node', nodeId: task.id });
  });
});
