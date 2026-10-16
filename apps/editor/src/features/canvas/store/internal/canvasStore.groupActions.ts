/**
 * 节点组 CRUD store actions。
 *
 * 承载创建组、解组、重命名、折叠切换与容器内整理（组与 Agent 容器同一动作）。
 * 所有写操作遵循画布 store 的历史原子性模式（historyBatchActive + 末尾单次 saveToHistory）。
 *
 * 语义口径以 `docs/runtime/画布节点组.md` 为准。
 */

import { applyLayoutInputOrder } from '../../layout/layoutPrimitives';
import { computeContainerArrangedPositions } from '../../layout/containerArrangement';
import { normalizeNodeGraphSettings } from '../../types/nodeGraph';
import type { GraphNode, GroupNodeData, NodePosition } from '../../types/node';
import {
  getGroupMembers,
  filterAddCandidates,
  filterRemoveCandidates,
  isContainerNode,
  isContainerCollapsed,
  expandPositionUpdatesWithGroup,
  type GroupPositionUpdate,
} from '../../services/groupMembership';
import { pickGroupColorById } from '../../services/groupPalette';
import { markNodeDirty, markNodeRemoved, markNodesDirty, markGraphDirty } from './canvasStore.persistence';
import { projectDesiredSizeMapForLayout } from './canvasStore.layoutActions';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import type { CanvasStoreGet, CanvasStoreSet, NodeGraphActions } from './canvasStore.core';
import type { AgentNodeData } from '../../types/agentNode';

/** 计算节点集合的包围盒左上角位置（用于组节点初始定位） */
const computeMembersBBoxTopLeft = (
  nodes: GraphNode[],
  fallback: NodePosition,
): NodePosition => {
  if (nodes.length === 0) return fallback;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.position.x < minX) minX = node.position.x;
    if (node.position.y < minY) minY = node.position.y;
  }
  return { x: minX, y: minY };
};

const createDefaultGroupNodeData = (
  name: string | undefined,
  groupId: string | undefined,
): GroupNodeData => ({
  label: '节点组',
  description: undefined,
  runtimeRef: undefined,
  name: name ?? '',
  collapsed: false,
  // 创建组时按 id 取稳定色，保证新组从创建起就有可识别的视觉锚点
  color: pickGroupColorById(groupId),
});


/** 读取外层是否已开启历史合批（true = 编排层负责收口，本 action 不关批、不落历史）。 */
const isHistoryBatchPreActive = (get: CanvasStoreGet): boolean =>
  get().historyBatchActive;

export const createCanvasGroupActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet,
): Pick<
  NodeGraphActions,
  | 'createGroup'
  | 'ungroupNode'
  | 'renameGroup'
  | 'setGroupColor'
  | 'toggleGroupCollapse'
  | 'addNodesToGroup'
  | 'removeNodesFromGroup'
  | 'moveNodesBetweenGroups'
  | 'autoLayoutContainer'
> => ({
  createGroup: (nodeIds, position, options) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return null;
    // 空成员清单默认拒绝；仅 options.allowEmpty（CLI 空组建组，spec CLI-044）放行——
    // 位置必须由调用方给出（无成员无法派生包围盒），缺省兜底零坐标。
    const allowEmpty = options?.allowEmpty === true;
    if (nodeIds.length === 0 && !allowEmpty) return null;

    // 校验：候选成员不能是组节点（组不得成为任何容器的成员），且排除已是容器成员的节点
    //（单一归属）；Agent 容器可成为组的成员（AG-CN-001），候选过滤由 filterAddCandidates 同口径把关。
    const candidateNodes: GraphNode[] = [];
    for (const id of nodeIds) {
      const node = nodeGraph.nodes.find((n) => n.id === id);
      if (!node) continue;
      if (node.type === 'group') continue;
      if (typeof node.groupId === 'string' && node.groupId.length > 0) continue;
      candidateNodes.push(node);
    }
    if (candidateNodes.length === 0 && !allowEmpty) return null;

    const groupPosition = position ?? computeMembersBBoxTopLeft(candidateNodes, { x: 0, y: 0 });
    const groupId = `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const groupNode: GraphNode<GroupNodeData> = {
      id: groupId,
      type: 'group',
      position: groupPosition,
      data: createDefaultGroupNodeData(undefined, groupId),
      draggable: true,
      size: undefined,
      style: undefined,
      groupId: undefined,
    };

    const memberIds = candidateNodes.map((n) => n.id);

    // 原子历史（AG-CN-011）：外层已开批则并入外层（不关批不落历史）；
    // 否则自开自关，写入后落一条历史。
    const preActive = isHistoryBatchPreActive(get);
    set((state) => {
      if (!state.nodeGraph) return;
      state.historyBatchActive = true;
    });

    set((state) => {
      if (!state.nodeGraph) return;
      state.nodeGraph.nodes.push(groupNode);
      for (const node of state.nodeGraph.nodes) {
        if (memberIds.includes(node.id)) {
          node.groupId = groupId;
        }
      }
      markNodeDirty(state, groupId);
      markNodesDirty(state, memberIds);
      markGraphDirty(state);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });

    if (!preActive) {
      set((state) => {
        state.historyBatchActive = false;
      });
      get().saveToHistory();
    }

    return groupId;
  },

  ungroupNode: (groupId) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;

    const groupNode = nodeGraph.nodes.find((n) => n.id === groupId && n.type === 'group');
    if (!groupNode) return;

    const members = getGroupMembers(nodeGraph, groupId);
    const memberIds = members.map((m) => m.id);

    const preActive = isHistoryBatchPreActive(get);
    set((state) => {
      if (!state.nodeGraph) return;
      state.historyBatchActive = true;
    });

    set((state) => {
      if (!state.nodeGraph) return;
      for (const node of state.nodeGraph.nodes) {
        if (memberIds.includes(node.id)) {
          node.groupId = undefined;
        }
      }
      // 删除组节点本身（其成员已被解除 groupId，不会被 group 删除扩展级联）
      state.nodeGraph.nodes = state.nodeGraph.nodes.filter((n) => n.id !== groupId);
      markNodesDirty(state, memberIds);
      markNodeRemoved(state, groupId);
      markGraphDirty(state);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });

    if (!preActive) {
      set((state) => {
        state.historyBatchActive = false;
      });
      get().saveToHistory();
    }
  },

  addNodesToGroup: (nodeIds, targetGroupId) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;

    // 校验目标存在且是容器节点（组 | Agent 容器），再按成员资格矩阵过滤候选
    const targetGroup = nodeGraph.nodes.find((n) => n.id === targetGroupId && isContainerNode(n));
    if (!targetGroup) return;

    const candidateIds = filterAddCandidates(nodeGraph, nodeIds, targetGroupId);
    if (candidateIds.length === 0) return;

    const preActive = isHistoryBatchPreActive(get);
    set((state) => {
      if (!state.nodeGraph) return;
      state.historyBatchActive = true;
    });

    set((state) => {
      if (!state.nodeGraph) return;
      for (const node of state.nodeGraph.nodes) {
        if (candidateIds.includes(node.id)) {
          node.groupId = targetGroupId;
        }
      }
      markNodesDirty(state, candidateIds);
      markGraphDirty(state);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });

    if (!preActive) {
      set((state) => {
        state.historyBatchActive = false;
      });
      get().saveToHistory();
    }
  },

  removeNodesFromGroup: (nodeIds) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;

    const candidateIds = filterRemoveCandidates(nodeGraph, nodeIds);
    if (candidateIds.length === 0) return;

    const preActive = isHistoryBatchPreActive(get);
    set((state) => {
      if (!state.nodeGraph) return;
      state.historyBatchActive = true;
    });

    set((state) => {
      if (!state.nodeGraph) return;
      for (const node of state.nodeGraph.nodes) {
        if (candidateIds.includes(node.id)) {
          node.groupId = undefined;
        }
      }
      markNodesDirty(state, candidateIds);
      markGraphDirty(state);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });

    if (!preActive) {
      set((state) => {
        state.historyBatchActive = false;
      });
      get().saveToHistory();
    }
  },

  moveNodesBetweenGroups: (nodeIds, targetGroupId) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;

    // 校验目标存在且是容器节点（组 | Agent 容器），再按成员资格矩阵过滤候选
    const targetGroup = nodeGraph.nodes.find((n) => n.id === targetGroupId && isContainerNode(n));
    if (!targetGroup) return;

    const candidateIds = filterAddCandidates(nodeGraph, nodeIds, targetGroupId);
    if (candidateIds.length === 0) return;

    const preActive = isHistoryBatchPreActive(get);
    set((state) => {
      if (!state.nodeGraph) return;
      state.historyBatchActive = true;
    });

    set((state) => {
      if (!state.nodeGraph) return;
      for (const node of state.nodeGraph.nodes) {
        if (candidateIds.includes(node.id)) {
          // 跨组迁移：直接覆盖原 groupId（原组关系自然解除）
          node.groupId = targetGroupId;
        }
      }
      markNodesDirty(state, candidateIds);
      markGraphDirty(state);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });

    if (!preActive) {
      set((state) => {
        state.historyBatchActive = false;
      });
      get().saveToHistory();
    }
  },

  renameGroup: (groupId, name) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;
    const groupNode = nodeGraph.nodes.find((n) => n.id === groupId && n.type === 'group');
    if (!groupNode) return;

    set((state) => {
      if (!state.nodeGraph) return;
      const node = state.nodeGraph.nodes.find((n) => n.id === groupId);
      if (!node || node.type !== 'group') return;
      const data = node.data as GroupNodeData;
      node.data = { ...data, name };
      markNodeDirty(state, groupId);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });
    get().saveToHistory();
  },

  setGroupColor: (groupId, color) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;
    const groupNode = nodeGraph.nodes.find((n) => n.id === groupId && n.type === 'group');
    if (!groupNode) return;

    set((state) => {
      if (!state.nodeGraph) return;
      const node = state.nodeGraph.nodes.find((n) => n.id === groupId);
      if (!node || node.type !== 'group') return;
      const data = node.data as GroupNodeData;
      node.data = { ...data, color };
      markNodeDirty(state, groupId);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });
    get().saveToHistory();
  },

  toggleGroupCollapse: (groupId) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return;
    // 折叠泛化（AG-CN-008）：组与 Agent 容器同一折叠机制，复用 data.collapsed 字段
    const target = nodeGraph.nodes.find((n) => n.id === groupId && isContainerNode(n));
    if (!target) return;

    set((state) => {
      if (!state.nodeGraph) return;
      const node = state.nodeGraph.nodes.find((n) => n.id === groupId);
      if (!node || !isContainerNode(node)) return;
      if (node.type === 'group') {
        const data = node.data as GroupNodeData;
        node.data = { ...data, collapsed: !data.collapsed };
      } else {
        const data = node.data as AgentNodeData;
        node.data = { ...data, collapsed: data.collapsed !== true };
      }
      markNodeDirty(state, groupId);
      state.nodeGraph.meta.updatedAt = new Date().toISOString();
      state.structureRevision += 1;
    });
    // 折叠/展开各自一条历史（AG-CN-011）；外层开批时并入外层
    if (!get().historyBatchActive) {
      get().saveToHistory();
    }
  },

  // 容器内整理：组与 Agent 容器同一动作同一语义
  //（spec：画布节点组.md「自动布局协作」）。
  autoLayoutContainer: async (containerId, options) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return null;
    // 容器判据统一：门走 isContainerNode，不为 Agent 容器留特例
    const containerNode = nodeGraph.nodes.find((n) => n.id === containerId && isContainerNode(n));
    if (!containerNode) return null;
    // 折叠态容器内整理不可执行；需先展开（spec：画布节点组.md「自动布局协作」）
    if (isContainerCollapsed(containerNode)) return null;

    // 成员集合先经 order 显式顺序重排（CLI --order 承载，spec CLI-030）：布局引擎按传入
    // 数组序占格；缺省不传时保持 getGroupMembers 的现状数组序，默认排序行为不变。
    // 重排不影响锚点计算（包围盒与序无关），仅改变占格顺序。
    const members = applyLayoutInputOrder(
      getGroupMembers(nodeGraph, containerId),
      options ? options.order : undefined,
    );
    if (members.length === 0) return null;

    const memberIds = new Set(members.map((m) => m.id));

    const normalizedSettings = normalizeNodeGraphSettings(nodeGraph.settings);
    // 容器内整理：参与节点多在视口内，options 入参的实时 measured 优先；缺失时用 store 会话态缓存兜底。
    const measuredFromOptions = options ? options.measuredSizeByNodeId : undefined;
    const measured = measuredFromOptions !== undefined
      ? measuredFromOptions
      : get().ui.lastMeasuredSizeByNodeId;
    const desiredByNodeId = get().ui.desiredSizeByNodeId;
    const layoutModelByNodeId = get().ui.layoutModelByNodeId;
    const sizeSources: EffectiveSizeSources = {
      measuredByNodeId: measured,
      desiredByNodeId: projectDesiredSizeMapForLayout(desiredByNodeId),
      derivedByNodeId: options ? options.derivedSizeByNodeId : undefined,
      defaultByNodeId: undefined,
      layoutModelByNodeId,
    };
    // Layout-Model-Driven：Layout Model 主导主优先级链（layoutModel > measured > default），
    // desired 收窄为 runtime 期漂移校准，不再作为 measured 不可信时的强兜底（spec：
    // 画布启动性能与Layout-Model架构.md「与画布自动布局算法.md 的关系」节明确
    // 「Layout Model 始终可得，不存在 desired 缺失场景」）。applyDesiredFallback 已下线。
    const layoutOptions = {
      defaultNodeSize: undefined,
      snapGrid: normalizedSettings.snapGrid,
      sizeSources,
      // 网格列数由本次操作给出（右键菜单「整理为网格」的 m×n 快速选择）；
      // 缺省时为单列垂直摆放，与全局整理口径一致（spec：画布自动布局算法.md「网格摆放」）。
      columns: options ? options.columns : undefined,
    };

    // 整理前成员包围盒左上角作为锚点（spec：容器内整理保持容器位置不变）；
    // 布局计算与锚点补偿走共享实现（与批次收口重排同源，layout/containerArrangement.ts）。
    const arrangedPositions = await computeContainerArrangedPositions({
      members,
      sizeSources,
      columns: layoutOptions.columns,
      snapGrid: layoutOptions.snapGrid,
    });
    if (arrangedPositions === null) {
      return { positions: {}, changedCount: 0 };
    }
    const positions = arrangedPositions;

    let touched = 0;
    const touchedNodeIds: string[] = [];
    set((state) => {
      if (!state.nodeGraph) return;
      // 先组装显式成员的目标位置（锚点补偿后）
      const memberUpdates: GroupPositionUpdate[] = [];
      for (const node of state.nodeGraph.nodes) {
        if (!memberIds.has(node.id)) continue;
        const nextPos = positions[node.id];
        if (nextPos) {
          memberUpdates.push({ id: node.id, position: nextPos });
        }
      }
      if (memberUpdates.length === 0) return;
      // 派生成员（Agent 容器）的 position 是派生量（由其成员包围盒推出，投影层覆盖渲染），
      // 直接写回会被派生投影覆盖、整理对它无效。按「整理作用于容器本体，其成员随容器位移
      // 传播跟随」的等价实现，把容器成员的目标位移展开为「其全体成员的位移」后统一写回，
      // 容器新位置由派生投影自然推出（spec：画布节点组.md「自动布局协作」）。
      const expandedUpdates = expandPositionUpdatesWithGroup(state.nodeGraph, memberUpdates);
      const nodeById = new Map(state.nodeGraph.nodes.map((n) => [n.id, n] as const));
      for (const update of expandedUpdates) {
        const node = nodeById.get(update.id);
        if (!node) continue;
        node.position = update.position;
        touched += 1;
        touchedNodeIds.push(update.id);
      }
      if (touched > 0) {
        markNodesDirty(state, touchedNodeIds);
        state.positionRevision += 1;
        state.layoutRevision += 1;
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
      }
    });

    if (touched > 0) {
      get().saveToHistory();
    }

    return { positions, changedCount: touched };
  },
});
