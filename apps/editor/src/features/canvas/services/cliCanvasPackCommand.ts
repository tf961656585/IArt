/**
 * `canvas layout --scope containers --pack`：把顶层容器排成行列看板（spec §5.3 / CLI-055）。
 *
 * 职责边界（从 `cliCanvasWriteCommands.ts` 拆出，保持热点文件 < 1000 行）：
 * - 收集顶层容器（组 + 无宿主 groupId 的 Agent 容器，与旧 `scope=containers` 同一集合）；
 * - 读容器**渲染框**（派生框优先，无派生 entry 的无成员 Agent 容器回落静态有效尺寸），
 *   交给纯函数 `computeContainerPack` 求目标；
 * - 换算为「容器存储 position + 全部后代同 delta」的批量写入载荷，成员与嵌套 Agent 容器
 *   随宿主整体平移（展开由 `expandPositionUpdatesWithGroup` 既有语义完成，不重写传播）；
 * - 一次批量写入 = 一条撤销记录；dry-run 零写入、零撤销记录、operation_id 为 null。
 *
 * 与旧 `scope=containers`（只消除相交）完全独立：本模块只在新 pack 路径被调用，
 * 旧路径的算法、统计口径与网格取整（Math.round）不受影响。
 */

import type {
  CliCanvasLayoutOrderMode,
  CliCanvasOperationSummary,
  CliProxyCommand,
  CliProxyCommandResponse,
} from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { CanvasStore } from '@/features/canvas/store/canvasStore';
import type { GraphNode, NodeGraph, NodePosition } from '@/features/canvas/types';
import { normalizeNodeGraphSettings } from '@/features/canvas/types/nodeGraph';
import { buildGroupDerivedSize } from '@/features/canvas/components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { resolveEffectiveSize, type EffectiveSizeSources } from '@/features/canvas/utils/effectiveSize';
import {
  computeContainerPack,
  orderContainersForPack,
  type ContainerPackInput,
} from '@/features/canvas/layout/containerPack';
import { applyLayoutInputOrder, NODE_GAP } from '@/features/canvas/layout/layoutPrimitives';
import { computeOrderChanges, orderByReadingPosition } from '@/features/canvas/layout/readingOrder';
import { expandPositionUpdatesWithCompanions } from './nodeCompanion/nodeCompanionManager';
import {
  expandPositionUpdatesWithGroup,
  isContainerNode,
} from './groupMembership';
import { buildErrorResponse, projectNotOpenResponse } from './cliProxyErrorResponses';
import { registerPositionOperation } from './cliOperationRegistry';
import {
  buildInversePositions,
  collectMovedIds,
  readRenderPositionsOf,
  snapshotPositions,
  withPlannedPositions,
  type PositionMap,
  type PositionUpdateList,
} from './cliCanvasPositionOps';

type LayoutCommand = Extract<CliProxyCommand, { command: 'canvas.layout' }>;

type PackPlanSkip = { node_id: string; reason: string };

type ContainerPackPlan = {
  columns: number;
  gap: number;
  /** 实际参与排布的顶层容器（已过滤掉拿不到渲染框的异常容器）。 */
  inspectedContainerIds: string[];
  /** 目标坐标与当前渲染框不同的容器数（summary.moved 口径）。 */
  movedContainerIds: string[];
  skipped: PackPlanSkip[];
  /** 单次批量写入载荷：容器存储 position（后代由既有展开语义跟随）。 */
  payload: PositionUpdateList;
  /** 计划（或执行）后的全图位置（含后代），用于 dry-run 与受影响集合。 */
  plannedPositions: PositionMap;
  /**
   * 计划（或执行）后的**渲染口径**位置（CLI-061）：容器 = 看板 placement 目标框左上角，
   * 成员 = 随宿主平移后的 position（嵌套容器再由派生投影算）。
   */
  plannedRenderPositions: Record<string, NodePosition>;
  /** 计划位置与写前不同的节点（容器 + 后代）。 */
  affectedNodeIds: string[];
  /** 最终容器占格序与原始渲染框视觉序的比较（共享 readingOrder 函数）。 */
  contentReordered: boolean;
  orderChanges: ReadonlyArray<{ nodeId: string; fromSlot: number; toSlot: number }>;
};

type ContainerPackPlanResult =
  | { ok: true; plan: ContainerPackPlan }
  | { ok: false; code: 'node_not_found' | 'command_rejected'; message: string };

const NO_DERIVED_BOX_REASON = 'no_derived_box';

/**
 * 容器渲染框查找：派生 entry 优先（与画布投影同一 owner），缺失时回落
 * 「存储 position + 静态有效尺寸」——只发生在无成员 Agent 容器（单节点形态，
 * 无派生 entry）上，与容器让位（containerOverlap）的兜底同口径。
 */
const resolveContainerFrame = (
  node: GraphNode,
  sizeSources: EffectiveSizeSources,
  projection: ReturnType<typeof buildGroupDerivedSize>,
): { position: NodePosition; size: { width: number; height: number } } | null => {
  const entry = projection.byGroupId[node.id];
  if (entry !== undefined) return { position: entry.position, size: entry.size };
  const size = resolveEffectiveSize(node, sizeSources);
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  return { position: node.position, size };
};

/**
 * snapGrid 是 (x, y) 二元组，纯函数只收标量：取较大的有效步距。
 * 取 max 而非某一轴，保证两个轴上的落点同时是该步距的整数倍（较大步距的倍数
 * 必然也是较小步距的倍数），不会为了一个轴牺牲另一个轴的对齐。
 */
const resolveScalarSnapGrid = (snapGrid: readonly number[] | undefined): number => {
  const values = [snapGrid?.[0], snapGrid?.[1]].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  if (values.length === 0) return 1;
  return Math.max(...values);
};

const collectTopLevelContainers = (nodeGraph: NodeGraph): GraphNode[] =>
  nodeGraph.nodes.filter(
    (node) =>
      isContainerNode(node) &&
      !(typeof node.groupId === 'string' && node.groupId.length > 0),
  );

/** order 前置校验（pack 口）：缺失 → node_not_found；存在但不是顶层容器 → command_rejected。 */
const validatePackOrder = (
  nodeGraph: NodeGraph,
  orderIds: readonly string[],
  topLevelIds: ReadonlySet<string>,
): ContainerPackPlanResult | null => {
  if (orderIds.length === 0) return null;
  const existingIds = new Set(nodeGraph.nodes.map((node) => node.id));
  const missing = orderIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'node_not_found',
      message: `顺序清单里有画布上不存在的节点：${missing.join('、')}。请确认节点标识后重试。`,
    };
  }
  const outOfScope = orderIds.filter((id) => !topLevelIds.has(id));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      code: 'command_rejected',
      message: `这些节点不是本次排布的顶层容器，不能指定摆放顺序：${outOfScope.join('、')}。--pack 只能指定顶层容器（组，或不归属任何组的 Agent 容器）。`,
    };
  }
  return null;
};

/**
 * 计算 pack 计划（纯读 store 快照，不写画布）。
 *
 * 展开语义与 `updateNodePositionsBatch` 完全同源：先伴随节点展开、再容器跟随展开
 * （组 > Agent 容器 > 叶两层），因此计划位置与真实写入后的位置一致。
 */
export const planContainerPack = (params: {
  nodeGraph: NodeGraph;
  store: CanvasStore;
  columns: number | undefined;
  gap: number;
  order: readonly string[];
  orderMode: CliCanvasLayoutOrderMode;
}): ContainerPackPlanResult => {
  const { nodeGraph, store, gap } = params;
  const topLevel = collectTopLevelContainers(nodeGraph);
  const topLevelIds = new Set(topLevel.map((node) => node.id));

  const orderRejection = validatePackOrder(nodeGraph, params.order, topLevelIds);
  if (orderRejection !== null) return orderRejection;

  const sizeSources = buildCanvasSizeSources(store);
  const projection = buildGroupDerivedSize({ nodes: nodeGraph.nodes, sizeSources });
  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));

  const skipped: PackPlanSkip[] = [];
  const inputs: ContainerPackInput[] = [];
  for (const node of topLevel) {
    const frame = resolveContainerFrame(node, sizeSources, projection);
    if (frame === null) {
      console.debug('[cliCanvasPack] container has no derivable frame, skipped', {
        nodeId: node.id,
      });
      skipped.push({ node_id: node.id, reason: NO_DERIVED_BOX_REASON });
      continue;
    }
    inputs.push({ id: node.id, box: frame });
  }

  // order_mode：position（缺省）= 当前渲染框视觉阅读序；insertion = 现状数组序（显式 order 优先）。
  const orderedInputs =
    params.orderMode === 'insertion'
      ? applyLayoutInputOrder(inputs, params.order)
      : orderContainersForPack(inputs, params.order);
  const pack = computeContainerPack({
    containers: orderedInputs,
    columns: params.columns ?? null,
    gap,
    snapGrid: resolveScalarSnapGrid(normalizeNodeGraphSettings(nodeGraph.settings).snapGrid),
  });

  const frameById = new Map(orderedInputs.map((input) => [input.id, input.box] as const));
  const payload: PositionUpdateList = [];
  const movedContainerIds: string[] = [];
  for (const placement of pack.placements) {
    const frame = frameById.get(placement.id);
    const node = nodeById.get(placement.id);
    if (frame === undefined || node === undefined) {
      // 防御：placements 与 orderedInputs 同源，理论上不可达；条件跳过必须留痕。
      console.debug('[cliCanvasPack] placement without source frame, skipped', {
        nodeId: placement.id,
      });
      skipped.push({ node_id: placement.id, reason: NO_DERIVED_BOX_REASON });
      continue;
    }
    const delta: NodePosition = {
      x: placement.position.x - frame.position.x,
      y: placement.position.y - frame.position.y,
    };
    if (delta.x !== 0 || delta.y !== 0) movedContainerIds.push(placement.id);
    payload.push({
      id: placement.id,
      position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
    });
  }

  const plannedPositions = snapshotPositions(nodeGraph);
  if (payload.length > 0) {
    const expanded = expandPositionUpdatesWithGroup(
      nodeGraph,
      expandPositionUpdatesWithCompanions(nodeGraph, payload),
    );
    for (const update of expanded) {
      plannedPositions.set(update.id, {
        x: update.position.x,
        y: update.position.y,
      });
    }
  }
  const affectedNodeIds = collectMovedIds(snapshotPositions(nodeGraph), plannedPositions);

  // 渲染口径计划位置：成员按合成图派生，顶层容器以 placement 目标框为准（无成员 Agent
  // 容器没有派生 entry，派生路径会回落存储值，必须用 placement 覆盖）。
  const plannedRenderPositions = readRenderPositionsOf({
    nodeGraph: withPlannedPositions(nodeGraph, plannedPositions),
    sizeSources,
    nodeIds: new Set([...affectedNodeIds, ...orderedInputs.map((input) => input.id)]),
  });
  for (const placement of pack.placements) {
    plannedRenderPositions[placement.id] = {
      x: placement.position.x,
      y: placement.position.y,
    };
  }

  // 顺序变化：原始渲染框视觉序 × 最终容器占格序（共享原语）。
  const visualOrder = orderByReadingPosition(
    inputs.map((input) => ({ id: input.id, position: input.box.position })),
  );
  const orderReport = computeOrderChanges(
    visualOrder,
    pack.placements.map((placement) => ({ id: placement.id })),
  );

  return {
    ok: true,
    plan: {
      columns: pack.columns,
      gap,
      inspectedContainerIds: orderedInputs.map((input) => input.id),
      movedContainerIds,
      skipped,
      payload,
      plannedPositions,
      plannedRenderPositions,
      affectedNodeIds,
      contentReordered: orderReport.contentReordered,
      orderChanges: orderReport.orderChanges,
    },
  };
};

/** pack 的执行报告：inspected/moved 以容器为单位（moved 含计划位移），skipped 单列。 */
const buildPackSummary = (plan: ContainerPackPlan): CliCanvasOperationSummary => {
  const inspected = plan.inspectedContainerIds.length;
  const moved = plan.movedContainerIds.length;
  return {
    inspected,
    moved,
    // pack 的 moved 以容器为单位，moved 容器全部来自 inspected；成员跟随不计入该口径。
    cascaded: 0,
    unchanged: Math.max(0, inspected - moved),
    skipped: [...plan.skipped],
  };
};

const pickPositions = (
  positions: Readonly<Record<string, NodePosition>>,
  nodeIds: readonly string[],
): Record<string, NodePosition> => {
  const picked: Record<string, NodePosition> = {};
  for (const nodeId of nodeIds) {
    const position = positions[nodeId];
    if (position !== undefined) picked[nodeId] = position;
  }
  return picked;
};

/**
 * `canvas layout --scope containers --pack` 执行入口。
 *
 * 前置条件（scope 判定、`--pack` 与 `--gap` 的组合合法性）由调用方
 * `executeCanvasLayout` 处理；本入口只处理「pack 是合法组合」之后的语义。
 */
export const executeContainerPackLayout = (
  command: LayoutCommand,
  orderMode: CliCanvasLayoutOrderMode,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) return projectNotOpenResponse('canvas.layout', requestId);

  const gap = command.gap ?? NODE_GAP;
  const order = [...new Set(command.order ?? [])];
  const planResult = planContainerPack({
    nodeGraph,
    store,
    columns: command.columns,
    gap,
    order,
    orderMode,
  });
  if (!planResult.ok) {
    console.debug('[cliCanvasPack] pack layout rejected', {
      request_id: requestId,
      code: planResult.code,
    });
    return buildErrorResponse('canvas.layout', requestId, planResult.code, planResult.message);
  }
  const plan = planResult.plan;
  const dryRun = command.dry_run === true;

  if (dryRun) {
    console.debug('[cliCanvasPack] pack layout dry-run planned; canvas untouched', {
      request_id: requestId,
      columns: plan.columns,
      gap: plan.gap,
      inspected: plan.inspectedContainerIds.length,
      moved: plan.movedContainerIds.length,
    });
    return {
      command: 'canvas.layout',
      request_id: requestId,
      // 计划值（渲染口径）：容器 = placement 目标框，成员 = 成员计划位置。
      positions: pickPositions(plan.plannedRenderPositions, plan.affectedNodeIds),
      summary: buildPackSummary(plan),
      operation_id: null,
      dry_run: true,
      columns: plan.columns,
      gap: plan.gap,
      content_reordered: plan.contentReordered,
      order_changes: plan.orderChanges.map((change) => ({
        node_id: change.nodeId,
        from_slot: change.fromSlot,
        to_slot: change.toSlot,
      })),
    };
  }

  const before = snapshotPositions(nodeGraph);
  if (plan.payload.length > 0) {
    // 一次批量位置写入 = 一条撤销记录（展开态容器 position 由成员派生重算）。
    store.updateNodePositionsBatch(plan.payload);
  }
  const afterState = useCanvasStore.getState();
  const afterGraph = afterState.nodeGraph;
  const operationId = registerPositionOperation(
    buildInversePositions(before, snapshotPositions(afterGraph)),
  );
  return {
    command: 'canvas.layout',
    request_id: requestId,
    // 真实执行后从 store 读派生渲染框（容器 = 派生框左上角），不复用计划值。
    positions: readRenderPositionsOf({
      nodeGraph: afterGraph,
      sizeSources: buildCanvasSizeSources(afterState),
      nodeIds: plan.affectedNodeIds,
    }),
    summary: buildPackSummary(plan),
    operation_id: operationId,
    dry_run: false,
    columns: plan.columns,
    gap: plan.gap,
    content_reordered: plan.contentReordered,
    order_changes: plan.orderChanges.map((change) => ({
      node_id: change.nodeId,
      from_slot: change.fromSlot,
      to_slot: change.toSlot,
    })),
  };
};

// ---------------------------------------------------------------------------
// canvas.layout 公共选项与顺序报告（pack 与写命令共用）
// ---------------------------------------------------------------------------

/**
 * 排序模式归一（spec CLI-058）：`created` 由主进程按任务/资产创建时间解析成显式 order，
 * 画布侧不读创建时间；万一收到 `created`，按 `insertion`（现状数组序）处理并 debug 留痕。
 */
export const resolveLayoutOrderMode = (
  requestId: string,
  mode: CliCanvasLayoutOrderMode | undefined,
): CliCanvasLayoutOrderMode => {
  if (mode === 'created') {
    console.debug('[cliCanvasWrite] layout order-mode created treated as insertion', {
      request_id: requestId,
    });
    return 'insertion';
  }
  return mode ?? 'position';
};

/**
 * store 侧整理选项（画布侧只透传本批语义）：`gap` / `orderMode` 由布局批次承载；
 * `columns` 缺省不传时保持引擎既有单列口径。
 */
export type LayoutStoreOptions = {
  measuredSizeByNodeId: undefined;
  derivedSizeByNodeId: undefined;
  columns: number | undefined;
  gap: number;
  orderMode: CliCanvasLayoutOrderMode;
  order?: readonly string[];
};

export const buildLayoutOptions = (
  columns: number | undefined,
  gap: number,
  orderMode: CliCanvasLayoutOrderMode,
  orderIds: readonly string[],
): LayoutStoreOptions => ({
  measuredSizeByNodeId: undefined,
  derivedSizeByNodeId: undefined,
  columns,
  gap,
  orderMode,
  ...(orderIds.length > 0 ? { order: orderIds } : {}),
});

/**
 * 读取整理引擎返回的顺序变化报告（snake_case 映射）。旧返回值缺这两键时按「无变化」兜底
 * （与契约 schema 的 .default 同口径）；`changedCount` 是整理结果的公共必填字段，用作
 * 结构对齐锚点。
 */
type LayoutOrderReportSource = {
  changedCount: number;
  contentReordered?: boolean | undefined;
  orderChanges?: ReadonlyArray<{ nodeId: string; fromSlot: number; toSlot: number }> | undefined;
};

export const readLayoutOrderReport = (
  value: LayoutOrderReportSource | null | undefined,
): {
  content_reordered: boolean;
  order_changes: Array<{ node_id: string; from_slot: number; to_slot: number }>;
} => {
  const orderChanges = value?.orderChanges ?? [];
  return {
    content_reordered: value?.contentReordered ?? orderChanges.length > 0,
    order_changes: orderChanges.map((change) => ({
      node_id: change.nodeId,
      from_slot: change.fromSlot,
      to_slot: change.toSlot,
    })),
  };
};
