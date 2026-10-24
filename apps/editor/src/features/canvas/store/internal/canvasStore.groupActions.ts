/**
 * 节点组 CRUD store actions。
 *
 * 承载创建组、解组、重命名、折叠切换与容器内整理（组与 Agent 容器同一动作）。
 * 所有写操作遵循画布 store 的历史原子性模式（historyBatchActive + 末尾单次 saveToHistory）。
 *
 * 语义口径以 `docs/runtime/画布节点组.md` 为准。
 */

import { applyLayoutInputOrder } from '../../layout/layoutPrimitives';
import {
  computeContainerArrangedPositions,
  orderNodesForLayoutMode,
} from '../../layout/containerArrangement';
import { resolveContainerOverlaps } from '../../layout/containerOverlap';
import {
  normalizeLayoutOrderMode,
  type LayoutApplyResult,
} from '../../layout/autoLayoutTypes';
import { computeOrderChanges, orderByReadingPosition } from '../../layout/readingOrder';
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
import { computeGroupExpandedPosition } from '../../services/groupGeometry';
import { pickGroupColorById } from '../../services/groupPalette';
import { markNodeDirty, markNodeRemoved, markNodesDirty, markGraphDirty } from './canvasStore.persistence';
import { projectDesiredSizeMapForLayout } from './canvasStore.layoutActions';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import type {
  CanvasGroupAutoLayoutStoreOptions,
  CanvasStoreGet,
  CanvasStoreSet,
  NodeGraphActions,
} from './canvasStore.core';
import type { AgentNodeData } from '../../types/agentNode';

/**
 * 容器内整理 options 的扩展字段（本批新增，store core 的类型收敛由主 agent 统一）。
 *
 * `gap`：本次格子间距（非负整数，缺省 NODE_GAP=120），调用入参、不持久化。
 * `orderMode` / `order_mode`：本次排序口径（camelCase 与 CLI 原样 snake_case 均接受）；
 * 缺省 `position`（视觉阅读序），`created` 在画布侧落 debug 日志后按 `insertion` 处理。
 */
type ContainerLayoutExtendedOptions = CanvasGroupAutoLayoutStoreOptions & {
  gap?: number | undefined;
  orderMode?: unknown;
  order_mode?: unknown;
};

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
  | 'planAutoLayoutContainer'
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

    // 组存储 position 与派生渲染框左上角口径统一（batch 1a）：
    // - 非空成员：直接存派生渲染框左上角（computeGroupExpandedPosition = 成员包围盒左上角
    //   − (GROUP_PADDING.left, GROUP_PADDING.top + GROUP_HEADER_HEIGHT)），与投影层派生口径一致，
    //   读写两侧不差 (12,40)，消除「新建组存储值与渲染框错位」；
    // - 空组：无成员可派生，保持调用方给的位置（缺省零坐标）。
    // 派生函数返回 null（成员坐标非法）时回落到调用方 position / 成员包围盒左上角。
    const derivedPosition =
      candidateNodes.length > 0
        ? computeGroupExpandedPosition(
            candidateNodes.map((node) => ({
              position: node.position,
              size: node.size ?? null,
            })),
          )
        : null;
    const groupPosition =
      derivedPosition ??
      position ??
      computeMembersBBoxTopLeft(candidateNodes, { x: 0, y: 0 });
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
  autoLayoutContainer: async (
    containerId: string,
    options: ContainerLayoutExtendedOptions | undefined,
    dryRun?: boolean,
  ) => {
    const { nodeGraph } = get();
    if (!nodeGraph) return null;
    // 容器判据统一：门走 isContainerNode，不为 Agent 容器留特例
    const containerNode = nodeGraph.nodes.find((n) => n.id === containerId && isContainerNode(n));
    if (!containerNode) return null;
    // 折叠态容器内整理不可执行；需先展开（spec：画布节点组.md「自动布局协作」）
    if (isContainerCollapsed(containerNode)) return null;

    // 排序口径（spec：画布自动布局算法.md「排序口径」）：缺省 position = 视觉阅读序；
    // created 由主进程解析为显式 order 后传入，画布侧收到时落 debug 并按 insertion 处理。
    const orderMode = normalizeLayoutOrderMode(options?.orderMode)
      ?? normalizeLayoutOrderMode(options?.order_mode);

    // 成员集合：先按排序口径产出基准序（视觉阅读序 / 插入序），再让显式 order 覆盖在基准序
    // 之上（CLI --order 承载，spec CLI-030）：order 中节点按给定序排最前，其余按基准序跟排。
    const allMembers = getGroupMembers(nodeGraph, containerId);
    const baseOrder = orderNodesForLayoutMode(allMembers, orderMode);
    const members = applyLayoutInputOrder(baseOrder, options?.order);
    if (members.length === 0) return null;

    // 重排差异：原视觉阅读序 vs 本次实际占格序（CLI content_reordered / order_changes 的
    // 机器可读信号，spec：画布自动布局算法.md AL-GC-005）。
    const visualOrder = orderByReadingPosition(allMembers);
    const orderSummary = computeOrderChanges(visualOrder, members);

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
    const resolvedColumns = options ? options.columns : undefined;

    // 整理前成员包围盒左上角作为锚点（吸附到最近网格点；无网格时精确保持；冲突时按 spec
    // AL-GC-003 整组让位）；布局计算与锚点补偿走共享实现（与批次收口重排同源，
    // layout/containerArrangement.ts）。
    const arrangedPositions = await computeContainerArrangedPositions({
      members,
      sizeSources,
      columns: resolvedColumns,
      snapGrid: normalizedSettings.snapGrid,
      gap: options?.gap,
    });
    if (arrangedPositions === null) {
      return {
        positions: {},
        changedCount: 0,
        contentReordered: orderSummary.contentReordered,
        orderChanges: [...orderSummary.orderChanges],
      } satisfies LayoutApplyResult;
    }

    // 容器级防重叠（长大容器整体让位）：整理让容器派生矩形可能长大并与相邻容器相交。
    // 合成图先套用整理目标位置，并把 Agent 容器的位移跟随铺到其成员（与下方写回同一机制），
    // 让 resolver 看到的派生几何就是整理后的真实结果。
    const arrangedUpdates: GroupPositionUpdate[] = Object.entries(arrangedPositions).map(
      ([id, position]) => ({ id, position }),
    );
    const followedPositions = new Map<string, NodePosition>();
    for (const update of expandPositionUpdatesWithGroup(nodeGraph, arrangedUpdates)) {
      followedPositions.set(update.id, update.position);
    }
    const syntheticNodes = nodeGraph.nodes.map((node) => {
      const nextPosition = followedPositions.get(node.id);
      return nextPosition === undefined ? node : { ...node, position: nextPosition };
    });
    const relocations = resolveContainerOverlaps({
      nodes: syntheticNodes,
      sizeSources,
      snapGrid: normalizedSettings.snapGrid,
      containerIds: [containerId],
    });

    // 最终位置表：整理目标位置 + 让位位移（整组统一 delta，含宿主组其他成员与嵌套成员）。
    // 未被整理覆盖的后代以「跟随整理后的位置」或当前存储位置为基底，保证相对布局不变。
    const finalPositions: Record<string, NodePosition> = { ...arrangedPositions };
    for (const relocation of relocations) {
      for (const id of relocation.memberIds) {
        const base =
          finalPositions[id] ??
          followedPositions.get(id) ??
          nodeGraph.nodes.find((node) => node.id === id)?.position;
        if (base === undefined) continue;
        finalPositions[id] = {
          x: base.x + relocation.delta.x,
          y: base.y + relocation.delta.y,
        };
      }
    }

    // 计划模式（CLI canvas.layout --scope group --dry-run）：零写入、零撤销记录。
    if (dryRun === true) {
      let planned = 0;
      for (const node of nodeGraph.nodes) {
        const nextPos = finalPositions[node.id];
        if (!nextPos) continue;
        if (node.position.x === nextPos.x && node.position.y === nextPos.y) continue;
        planned += 1;
      }
      console.debug('[autoLayoutContainer] dry-run plan computed; canvas untouched', {
        containerId,
        planned,
        gap: options?.gap,
        orderMode,
      });
      return {
        positions: finalPositions,
        changedCount: planned,
        contentReordered: orderSummary.contentReordered,
        orderChanges: [...orderSummary.orderChanges],
      } satisfies LayoutApplyResult;
    }

    let touched = 0;
    const touchedNodeIds: string[] = [];
    set((state) => {
      if (!state.nodeGraph) return;
      // 遍历图中所有命中最终位置表的节点（不止显式成员）：容器让位会移动宿主组其他成员与
      // 嵌套 Agent 容器成员，遗漏会让组框派生与实际位置脱节。
      const memberUpdates: GroupPositionUpdate[] = [];
      for (const node of state.nodeGraph.nodes) {
        const nextPos = finalPositions[node.id];
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

    return {
      positions: finalPositions,
      changedCount: touched,
      contentReordered: orderSummary.contentReordered,
      orderChanges: [...orderSummary.orderChanges],
    } satisfies LayoutApplyResult;
  },

  /** 容器内整理计划模式：与 autoLayoutContainer 同一实现，只是不落写入与历史。 */
  planAutoLayoutContainer: (containerId, options) =>
    get().autoLayoutContainer(containerId, options, true),
});
