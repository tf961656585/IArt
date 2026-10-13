/**
 * 画布容器（组与 Agent 容器）成员关系机制。
 *
 * 本模块是容器成员关系的纯函数 owner，与伴生节点（companion）机制并列独立。
 *
 * 语义口径（`docs/runtime/画布节点组.md` 为主，`docs/agent/02-Agent节点与画布投影.md`
 * 承载 Agent 容器特有语义）：
 * - 容器节点（container node）= 组（type 'group'）| Agent 容器（type 'agent'），两类容器
 *   服从同一套成员关系与空间机制。
 * - companion：类型绑定的静态附属关系，由 NodeDefinition 声明（如 model↔resultArea）。
 * - 成员关系：实例绑定的动态归属指针，绑定字段在成员节点的顶层 `groupId`，指向容器节点 id。
 *   单一归属：一个节点至多持有 groupId；写入另一容器 id 即一次原子迁移。
 *
 * 成员资格与嵌套规则（AG-CN-001，容器嵌套至多两层：组 > Agent 容器 > 叶节点）：
 * - 组：可持有成员；不得成为任何容器的成员（组不得入组，也不得成为 Agent 容器的成员）。
 * - Agent 容器：可持有成员；可成为组的成员；不得成为 Agent 容器的成员（防递归）。
 * - 非容器节点（资产/素材、任务）：可成为任何容器的成员。
 * - 任何容器不得持有指向自身的 `groupId`。
 *
 * 两者互不共享实现，也互不排斥：一个节点可以同时是某 resultArea 的 owner（companion 关系）
 * 和某容器的成员（成员关系）。
 *
 * 本模块所有函数都是纯函数，只基于 `groupId` 字段与节点类型过滤，不依赖 NodeDefinition，
 * 不读写运行时状态。
 */

import type { GraphNode, GraphNodeType, NodePosition } from '../types/node';
import type { NodeGraph } from '../types/nodeGraph';

/** 位置更新项（结构等价于 companion 的 PositionUpdate，保持模块独立） */
export type GroupPositionUpdate = { id: string; position: NodePosition };

/**
 * 位移传播层数上限（spec：画布节点组.md「空间边界与移动」——位移传播至多两层）。
 * 层 1：被拖容器的显式成员；层 2：成员中 Agent 容器的成员（组 > Agent 容器 > 叶节点）。
 */
const MAX_POSITION_PROPAGATION_DEPTH = 2;

/** 判定节点是否为组成员（groupId 非空即成员） */
export const isGroupMember = (node: GraphNode): boolean =>
  typeof node.groupId === 'string' && node.groupId.length > 0;

/** 判定节点是否为组节点 */
export const isGroupNode = (node: GraphNode): boolean => node.type === 'group';

/**
 * 判定节点是否为容器节点（可持有成员）：组 | Agent 容器（AG-CN-001）。
 *
 * 容器机制的统一判据：成员资格、拖拽落点、位移传播、解散、折叠与派生尺寸都按本判据
 * 泛化，不为 Agent 容器写特例分支。
 */
export const isContainerNode = (node: GraphNode): boolean =>
  node.type === 'group' || node.type === 'agent';

/** 判定容器节点当前是否处于折叠态（组与 Agent 容器共用 data.collapsed，缺省为展开）。 */
export const isContainerCollapsed = (node: GraphNode): boolean => {
  if (!isContainerNode(node)) return false;
  const data = node.data as { collapsed?: boolean | undefined };
  return data.collapsed === true;
};

/**
 * 成员资格矩阵（类型级，AG-CN-001）：`memberType` 类型的节点能否成为 `containerType` 容器的成员。
 *
 * - 目标必须是容器节点（group | agent）。
 * - 组不得成为任何容器的成员（组不得入组、不得入 Agent 容器）。
 * - Agent 容器不得成为 Agent 容器的成员（容器嵌套至多两层：组 > Agent 容器 > 叶节点）。
 * - 其余（非容器节点 → 任一容器；Agent 容器 → 组）均可。
 */
export const canBeMemberOfType = (
  memberType: GraphNodeType,
  containerType: GraphNodeType,
): boolean => {
  if (containerType !== 'group' && containerType !== 'agent') return false;
  if (memberType === 'group') return false;
  if (containerType === 'agent' && memberType === 'agent') return false;
  return true;
};

/**
 * 成员资格判定（实例级，AG-CN-002）：`member` 节点能否成为 `container` 容器的成员。
 * 在类型级矩阵之上追加自身引用检查（容器节点自身不属于自身）。
 */
export const canBeMemberOf = (member: GraphNode, container: GraphNode): boolean => {
  if (member.id === container.id) return false;
  return canBeMemberOfType(member.type, container.type);
};

/** 获取节点所属容器 id；非成员返回 undefined */
export const getGroupIdOfNode = (node: GraphNode): string | undefined =>
  isGroupMember(node) ? node.groupId : undefined;

/** 获取全图所有组节点 id 集合 */
export const getGroupNodeIds = (nodeGraph: NodeGraph): Set<string> => {
  const ids = new Set<string>();
  for (const node of nodeGraph.nodes) {
    if (node.type === 'group') {
      ids.add(node.id);
    }
  }
  return ids;
};

/** 获取全图所有组节点 */
export const getGroupNodes = (nodeGraph: NodeGraph): GraphNode[] =>
  nodeGraph.nodes.filter(isGroupNode);

/**
 * 获取指定容器的全部成员节点 id 集合。
 * 容器 id 不存在或容器无成员时返回空集合。
 * 成员集合含 Agent 容器（组 > Agent 容器两层嵌套合法），不含组节点（组不得成为成员）。
 */
export const getGroupMemberIds = (nodeGraph: NodeGraph, groupId: string): Set<string> => {
  const memberIds = new Set<string>();
  for (const node of nodeGraph.nodes) {
    if (node.type !== 'group' && node.groupId === groupId) {
      memberIds.add(node.id);
    }
  }
  return memberIds;
};

/**
 * 获取指定容器的全部成员节点（含 Agent 容器成员，排除组节点）。
 */
export const getGroupMembers = (nodeGraph: NodeGraph, groupId: string): GraphNode[] =>
  nodeGraph.nodes.filter((n) => n.type !== 'group' && n.groupId === groupId);

/**
 * 拖动跟随扩展（两层位移传播，AG-CN-003 / AG-CT-002）。
 *
 * 给定一批位置更新，若其中含容器节点（组 | Agent 容器）的位移，将该容器全部成员追加相同位移；
 * 成员中含 Agent 容器时，该 Agent 容器的成员再整体跟随一层（组 > Agent 容器 > 叶节点，
 * 传播至多两层）。
 *
 * 规则：
 * - 只扩展容器节点（type==='group' || type==='agent'）的位移到其成员；成员自身的位移不反向扩展到容器。
 * - 若同一成员既在 payload 中（被直接拖动）又是某被拖动容器的成员，以 payload 中显式位置为准，
 *   不被容器位移覆盖（直接拖动优先于跟随）；被显式拖动的 Agent 容器照常向自己的成员扩展。
 * - 位移计算基于 payload 中容器节点的目标位置与该容器节点在图中的当前位置之差。
 * - 边界内非成员不跟随、不被自动收编（只按 groupId 显式成员关系扩展）。
 */
export const expandPositionUpdatesWithGroup = (
  nodeGraph: NodeGraph,
  payload: GroupPositionUpdate[],
): GroupPositionUpdate[] => {
  if (payload.length === 0) return payload;

  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeGraph.nodes) {
    nodeById.set(node.id, node);
  }

  // payload 中已显式包含的节点 id（直接拖动优先，不被容器跟随覆盖）
  const explicitIds = new Set(payload.map((p) => p.id));
  // 跟随扩展已追加的节点 id（避免被多个被拖容器重复扩展）
  const followedIds = new Set<string>();
  const additional: GroupPositionUpdate[] = [];

  const followMembers = (
    container: GraphNode,
    dx: number,
    dy: number,
    depth: number,
  ): void => {
    // 传播层数上限：层1 = 被拖容器的显式成员；层2 = 成员中 Agent 容器的成员（不再向下）
    if (depth > MAX_POSITION_PROPAGATION_DEPTH) return;
    for (const node of nodeGraph.nodes) {
      if (node.type === 'group') continue; // 组不得成为成员
      if (node.groupId !== container.id) continue;
      if (explicitIds.has(node.id)) continue; // 直接拖动优先
      if (followedIds.has(node.id)) continue;
      followedIds.add(node.id);
      additional.push({
        id: node.id,
        position: { x: node.position.x + dx, y: node.position.y + dy },
      });
      // 成员自身是容器（Agent 容器）：再向其成员传播一层
      if (isContainerNode(node)) {
        followMembers(node, dx, dy, depth + 1);
      }
    }
  };

  for (const update of payload) {
    const movedNode = nodeById.get(update.id);
    if (!movedNode || !isContainerNode(movedNode)) continue;

    const dx = update.position.x - movedNode.position.x;
    const dy = update.position.y - movedNode.position.y;
    // 位移为零无需扩展
    if (dx === 0 && dy === 0) continue;

    followMembers(movedNode, dx, dy, 1);
  }

  if (additional.length === 0) return payload;
  return [...payload, ...additional];
};

/** 删除级联扩展选项 */
export type ExpandRemovalOptions = {
  /**
   * 是否连删组成员（连删仅对「组」提供，Agent 容器恒不适用——AG-CN-007）。
   * - `false`（默认，dissolve 语义）：不把容器成员追加进删除集，成员保留。
   *   容器节点（组 | Agent 容器）的删除由调用方在删除集扩展后按删除咽喉统一清理成员 `groupId`
   *   （解散：成员关系解除，成员保留为自由节点）。
   * - `true`（显式连删，仅组）：把被删组节点的全部成员追加进删除集，一并删除；
   *   成员中的 Agent 容器被删时照常先在途终止，其自身的成员仍按解散语义保留、
   *   不被连删扩大删除。
   */
  deleteGroupMembers: boolean;
};

/**
 * 删除级联扩展。
 *
 * 给定一批待删节点 id，按 `options.deleteGroupMembers` 决定是否把**组节点**的全部成员追加进删除集。
 * 单独删除成员不反向扩展到容器节点（成员从容器移除，容器保留）。
 *
 * dissolve 语义（`deleteGroupMembers=false`，默认）：返回集只含输入节点 id，容器成员不进删除集。
 *   调用方在删除容器节点后必须在同一存储写入路径内把指向该容器的成员 `groupId` 置 `undefined`
 *   （解散清成员逻辑，删除咽喉范式），否则成员会持有指向已删容器的悬空 `groupId`。
 * 连删语义（`deleteGroupMembers=true`）：返回集含输入节点 id + 被删**组**节点的成员 id。
 *   Agent 容器不参与连删扩展（AG-CN-007：Agent 容器删除恒为解散，不存在「连删成员」选项）。
 */
export const expandRemovalWithGroup = (
  nodeGraph: NodeGraph,
  nodeIds: string[],
  options: ExpandRemovalOptions,
): string[] => {
  if (nodeIds.length === 0) return nodeIds;

  // dissolve 语义：不连删成员，直接返回输入
  if (!options.deleteGroupMembers) return nodeIds;

  const inputSet = new Set(nodeIds);
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeGraph.nodes) {
    nodeById.set(node.id, node);
  }

  const result = new Set<string>(nodeIds);
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    // 连删仅对组节点展开：Agent 容器恒不参与连删（deleteGroupMembers 对其恒不适用）
    if (!node || node.type !== 'group') continue;
    for (const candidate of nodeGraph.nodes) {
      if (candidate.type === 'group') continue; // 组不得成为成员
      if (candidate.groupId === id) {
        result.add(candidate.id);
      }
    }
  }

  if (result.size === inputSet.size) return nodeIds;
  return [...result];
};

/**
 * 加入候选校验。
 *
 * 给定一批节点 id 与目标容器 id，过滤出可加入目标容器的候选成员 id。
 *
 * 可加入条件（AG-CN-001 成员资格矩阵）：节点存在、目标是现存容器节点、节点符合资格矩阵
 * （组不可入任何容器、Agent 容器不可入 Agent 容器）、节点当前 `groupId` 不等于目标容器 id。
 * 已属于目标容器的节点视为无操作，从候选中排除但不报错。
 */
export const filterAddCandidates = (
  nodeGraph: NodeGraph,
  nodeIds: readonly string[],
  targetGroupId: string,
): string[] => {
  const target = nodeGraph.nodes.find((n) => n.id === targetGroupId);
  if (!target || !isContainerNode(target)) return [];

  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeGraph.nodes) {
    nodeById.set(node.id, node);
  }

  const candidates: string[] = [];
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (!canBeMemberOf(node, target)) continue;
    if (node.groupId === targetGroupId) continue;
    candidates.push(id);
  }
  return candidates;
};

/**
 * 移出候选校验。
 *
 * 给定一批节点 id，过滤出可移出容器的候选成员 id。
 *
 * 可移出条件：节点存在、节点当前是容器成员（`groupId !== undefined`）。
 * 非成员视为无操作，从候选中排除但不报错。
 * 组节点本身永远不是候选（组不得成为成员）。
 */
export const filterRemoveCandidates = (nodeGraph: NodeGraph, nodeIds: readonly string[]): string[] => {
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeGraph.nodes) {
    nodeById.set(node.id, node);
  }

  const candidates: string[] = [];
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (node.type === 'group') continue;
    if (!isGroupMember(node)) continue;
    candidates.push(id);
  }
  return candidates;
};

/** 非法成员关系违规原因（AG-CN-013 旧输入拒绝的定位材料，只进日志与错误码，不上界面）。 */
export type MembershipViolationReason =
  | 'group-cannot-be-member'
  | 'self-reference'
  | 'dangling-target'
  | 'target-not-container'
  | 'agent-in-agent'
  | 'ineligible-member';

export type MembershipViolation = {
  /** 持有非法 groupId 的成员节点 id */
  nodeId: string;
  /** 非法的 groupId 取值 */
  groupId: string;
  reason: MembershipViolationReason;
};

export type FindIllegalMembershipsOptions = {
  /**
   * 跳过「目标节点不存在」（悬空）违规。
   * 仅粘贴/导入片段场景使用：容器未随片段一起复制时，悬空目标会在 groupId 重映射中
   * 合法置空（合法粘贴重映射），不构成拒绝理由；其余违规（组持有 groupId、自指、
   * 容器套容器、目标非容器）仍照报。
   */
  ignoreDanglingTarget?: boolean;
};

/**
 * 扫描一批节点中的非法成员关系（读取边界校验，AG-CN-012 / AG-CN-013）。
 *
 * 检查持有 `groupId` 的节点：
 * - 组节点持有 groupId（组不得成为任何容器的成员）；
 * - 指向自身（容器节点自身不属于自身）；
 * - 目标节点不存在（悬空引用；按 options.ignoreDanglingTarget 可跳过）;
 * - 目标节点不是容器（groupId 必须指向容器节点 id）;
 * - Agent 容器指向 Agent 容器（容器嵌套至多两层）。
 *
 * 纯函数：不读写运行时状态；命中即返回违规清单，由调用方决定拒绝口径。
 */
export const findIllegalMemberships = (
  nodes: readonly GraphNode[],
  options?: FindIllegalMembershipsOptions,
): MembershipViolation[] => {
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  const violations: MembershipViolation[] = [];
  for (const node of nodes) {
    if (typeof node.groupId !== 'string' || node.groupId.length === 0) continue;
    const groupId = node.groupId;

    // 组不得持有 groupId：与目标是否存在无关，恒为违规
    if (node.type === 'group') {
      violations.push({ nodeId: node.id, groupId, reason: 'group-cannot-be-member' });
      continue;
    }
    if (node.id === groupId) {
      violations.push({ nodeId: node.id, groupId, reason: 'self-reference' });
      continue;
    }
    const target = nodeById.get(groupId);
    if (target === undefined) {
      if (options !== undefined && options.ignoreDanglingTarget === true) continue;
      violations.push({ nodeId: node.id, groupId, reason: 'dangling-target' });
      continue;
    }
    if (!isContainerNode(target)) {
      violations.push({ nodeId: node.id, groupId, reason: 'target-not-container' });
      continue;
    }
    if (!canBeMemberOfType(node.type, target.type)) {
      violations.push({
        nodeId: node.id,
        groupId,
        reason: target.type === 'agent' ? 'agent-in-agent' : 'ineligible-member',
      });
    }
  }
  return violations;
};

/** 容器边界框（拖拽落点判定用的快照条目）。组与 Agent 容器同一形状，无特例。 */
export type GroupBoundsEntry = {
  groupId: string;
  /** 边界框左上角画布坐标 */
  minX: number;
  minY: number;
  /** 边界框宽高 */
  width: number;
  height: number;
  /**
   * 渲染顺序（z-index 近似，值越大越在上）；用于多容器边界重叠时取最高绘制层。
   * 调用方应保证 Agent 容器背板（-1）高于组背板（-2）的相对次序。
   */
  zIndex: number;
};

/**
 * 拖拽落点命中检测。
 *
 * 给定落点中心坐标（画布坐标）与一组容器的拖拽前快照边界框，返回命中的容器节点 id 或 `undefined`（无命中）。
 *
 * 命中规则：
 * - 落点中心落在某容器边界框内（含边界）即命中。
 * - 多个容器快照边界框重叠时，取 `zIndex` 最大的（渲染最上层）。
 * - 边界框列表为空返回 `undefined`。
 *
 * 注意：
 * - 调用方必须传入拖拽**开始时刻**的快照边界框，不得传入拖拽过程中或结束时的实时派生边界，
 *   以规避派生边界反馈循环（AG-CN-004）。
 * - 调用方须先按被拖节点的成员资格过滤快照（组不得入任何容器、Agent 容器不得入 Agent 容器），
 *   本函数只做几何命中，不承载资格判定。
 */
export const hitTestGroupAt = (
  dropPoint: NodePosition,
  groupBounds: readonly GroupBoundsEntry[],
): string | undefined => {
  if (groupBounds.length === 0) return undefined;

  let hitGroupId: string | undefined;
  let hitZIndex = -Infinity;

  for (const entry of groupBounds) {
    const insideX = dropPoint.x >= entry.minX && dropPoint.x <= entry.minX + entry.width;
    const insideY = dropPoint.y >= entry.minY && dropPoint.y <= entry.minY + entry.height;
    if (!insideX || !insideY) continue;
    if (entry.zIndex > hitZIndex) {
      hitGroupId = entry.groupId;
      hitZIndex = entry.zIndex;
    }
  }
  return hitGroupId;
};
