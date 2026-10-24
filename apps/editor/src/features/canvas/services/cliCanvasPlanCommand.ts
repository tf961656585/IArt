/**
 * CLI 代理执行通道 · `canvas layout --plan` 计划执行器（批次 1b，spec §5.3 / CLI-030/055/058）。
 *
 * 职责边界（从 `cliProxyReceiver.ts` 拆出，接收端只保留分派）：
 * - `plan` 缺省时把命令原样交给既有 `executeCanvasLayout`（三个 scope 的整理不变）；
 * - `plan` 存在时按「groups 数组序 → containers → positions」一次算完全部目标位置，
 *   校验通过后**一次** `updateNodePositionsBatch` 写入 = 一条历史、一条按操作撤销记录。
 *
 * 三条不变式：
 * 1. **计划是纯读阶段**：groups 走 `store.planAutoLayoutContainer`（零写入）、containers 走纯函数
 *    `planContainerPack`、positions 是直接给定坐标；任何校验失败都在写入之前返回，画布零改动。
 * 2. **合成图**：每段结果套到 `currentGraph`（仅改 node.position 的新图）上，下一段在合成图上计算，
 *    因此「组内先排、再整组被看板平移」与最终写入保持一致；groups 与 containers 覆盖同一节点
 *    是预期行为（先组内排、再整组平移），不算冲突。
 * 3. **冲突判定只针对显式坐标**：positions 段不得命中容器，也不得命中已被 groups/containers
 *    覆盖的节点（同一节点两个来源会互相撕裂）。
 *
 * 条件跳过（空组 / 折叠组 / 容器无派生框）不阻断其他段，进 `summary.skipped` 并留 debug 痕。
 */

import type {
  CliCanvasLayoutPlan,
  CliCanvasOperationSkip,
  CliCanvasOperationSummary,
  CliProxyCommand,
  CliProxyCommandResponse,
} from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { NodeGraph, NodePosition } from '@/features/canvas/types';
import { NODE_GAP } from '@/features/canvas/layout/layoutPrimitives';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { getGroupMembers, isContainerNode } from './groupMembership';
import { buildErrorResponse, projectNotOpenResponse } from './cliProxyErrorResponses';
import { registerPositionOperation } from './cliOperationRegistry';
import {
  buildInversePositions,
  collectMovedIds,
  readRenderPositionsOf,
  snapshotPositions,
  withPlannedPositions,
  type PositionMap,
} from './cliCanvasPositionOps';
import { buildLayoutOptions, planContainerPack } from './cliCanvasPackCommand';
import { executeCanvasLayout } from './cliCanvasWriteCommands';

type LayoutCommand = Extract<CliProxyCommand, { command: 'canvas.layout' }>;
type PlanCommand = LayoutCommand & { plan: CliCanvasLayoutPlan };

type PlanOrderReport = {
  contentReordered: boolean;
  orderChanges: ReadonlyArray<{ nodeId: string; fromSlot: number; toSlot: number }>;
};

/**
 * 计划执行的 summary 口径（spec 批次 1b）：
 * - inspected = 被 groups / containers / positions 覆盖的节点集合大小；
 * - moved = 写前快照与最终（或写入后）快照的实际位移集合大小；
 * - cascaded = moved 中不属于 inspected 的伴随/级联节点数；
 * - unchanged = inspected 中最终未位移的数量；
 * - skipped 原样输出（条件跳过的机器可读对照面）。
 */
const buildPlanSummary = (
  inspected: ReadonlySet<string>,
  movedIds: readonly string[],
  skipped: readonly CliCanvasOperationSkip[],
): CliCanvasOperationSummary => {
  const movedSet = new Set(movedIds);
  let cascaded = 0;
  for (const nodeId of movedIds) {
    if (!inspected.has(nodeId)) cascaded += 1;
  }
  let unchanged = 0;
  for (const nodeId of inspected) {
    if (!movedSet.has(nodeId)) unchanged += 1;
  }
  return {
    inspected: inspected.size,
    moved: movedIds.length,
    cascaded,
    unchanged,
    skipped: [...skipped],
  };
};

/** 组条目 order 前置校验：不存在 → node_not_found；存在但不是该组直接成员 → command_rejected。 */
const validateGroupOrder = (
  requestId: string,
  nodeGraph: NodeGraph,
  groupId: string,
  orderIds: readonly string[],
  memberIds: ReadonlySet<string>,
): CliProxyCommandResponse | null => {
  if (orderIds.length === 0) return null;
  const existingIds = new Set(nodeGraph.nodes.map((node) => node.id));
  const missing = orderIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    console.debug('[cliCanvasPlan] group order rejected: nodes not found', {
      request_id: requestId,
      group: groupId,
      missing,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'node_not_found',
      `顺序清单里有画布上不存在的节点：${missing.join('、')}。请确认节点标识后重试。`,
    );
  }
  const outOfScope = orderIds.filter((id) => !memberIds.has(id));
  if (outOfScope.length > 0) {
    console.debug('[cliCanvasPlan] group order rejected: nodes outside group', {
      request_id: requestId,
      group: groupId,
      outOfScope,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      `这些节点不是组 ${groupId} 的直接成员，不能指定摆放顺序：${outOfScope.join('、')}。`,
    );
  }
  return null;
};

/** 计划顺序报告聚合：任一段重排即 true；明细按段序拼接并映射为契约 snake_case。 */
const aggregateOrderReports = (
  reports: readonly PlanOrderReport[],
): {
  content_reordered: boolean;
  order_changes: Array<{ node_id: string; from_slot: number; to_slot: number }>;
} => ({
  content_reordered: reports.some((report) => report.contentReordered),
  order_changes: reports.flatMap((report) =>
    report.orderChanges.map((change) => ({
      node_id: change.nodeId,
      from_slot: change.fromSlot,
      to_slot: change.toSlot,
    })),
  ),
});

/** 构造 positions 段的目标表：只改 node.position 的等价合成图由 withPlannedPositions 承载。 */
const positionMapFromRecord = (
  positions: Readonly<Record<string, NodePosition>>,
): PositionMap => new Map(Object.entries(positions));

/**
 * `canvas.layout` 分派：`plan` 优先；既无 plan 也无 scope → command_rejected。
 *
 * scope 收窄在 wrapper 完成（下游 `executeCanvasLayout` 需要必填 scope 的类型口径）。
 */
export const executeCanvasLayoutCommand = async (
  command: LayoutCommand,
): Promise<CliProxyCommandResponse> => {
  if (command.plan !== undefined) {
    return executeCanvasPlanLayout({ ...command, plan: command.plan });
  }
  if (command.scope === undefined) {
    console.debug('[cliCanvasPlan] layout rejected: neither scope nor plan given', {
      request_id: command.request_id,
    });
    return buildErrorResponse(
      'canvas.layout',
      command.request_id,
      'command_rejected',
      '请给出 --scope 或 --plan。',
    );
  }
  return executeCanvasLayout({ ...command, scope: command.scope });
};

/**
 * 计划执行入口：groups → containers → positions 一次算完、一次写入、一条撤销。
 *
 * dry-run 只返回计划值（零写入、零撤销记录、operation_id 为 null）；真实执行后按
 * 「写前快照 × 写后快照」diff 生成逆操作并登记一次按操作撤销。
 */
export const executeCanvasPlanLayout = async (
  command: PlanCommand,
): Promise<CliProxyCommandResponse> => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const originalGraph = store.nodeGraph;
  if (originalGraph === null) return projectNotOpenResponse('canvas.layout', requestId);

  const plan = command.plan;
  const planned: PositionMap = snapshotPositions(originalGraph);
  const assigned = new Set<string>();
  const inspected = new Set<string>();
  const skipped: CliCanvasOperationSkip[] = [];
  const orderReports: PlanOrderReport[] = [];
  // 合成图：每段结果套上后供下一段计算（不写 store）。
  let currentGraph = originalGraph;

  // --- 1) groups：按数组序组内整理（零写入计划入口） -----------------------------
  const seenGroupIds = new Set<string>();
  for (const section of plan.groups ?? []) {
    const groupId = section.group_id;
    if (seenGroupIds.has(groupId)) {
      console.debug('[cliCanvasPlan] groups rejected: duplicate group id', {
        request_id: requestId,
        group: groupId,
      });
      return buildErrorResponse(
        'canvas.layout',
        requestId,
        'command_rejected',
        `计划文件的 groups 里重复出现了同一个组：${groupId}。一个组只能出现一次。`,
      );
    }
    seenGroupIds.add(groupId);

    const container = originalGraph.nodes.find((node) => node.id === groupId);
    if (container === undefined) {
      console.debug('[cliCanvasPlan] groups rejected: group not found', {
        request_id: requestId,
        group: groupId,
      });
      return buildErrorResponse(
        'canvas.layout',
        requestId,
        'group_not_found',
        `画布上找不到这个组：${groupId}。请确认组标识后重试。`,
      );
    }
    if (!isContainerNode(container)) {
      console.debug('[cliCanvasPlan] groups rejected: not a container', {
        request_id: requestId,
        group: groupId,
        nodeType: container.type,
      });
      return buildErrorResponse(
        'canvas.layout',
        requestId,
        'command_rejected',
        `这个节点不是容器节点，不能按组整理：${groupId}。`,
      );
    }
    if (typeof container.groupId === 'string' && container.groupId.length > 0) {
      console.debug('[cliCanvasPlan] groups rejected: nested container', {
        request_id: requestId,
        group: groupId,
        containerGroup: container.groupId,
      });
      return buildErrorResponse(
        'canvas.layout',
        requestId,
        'command_rejected',
        `组 ${groupId} 是嵌套在另一个容器里的容器，计划文件的 groups 目前只支持顶层容器。`,
      );
    }

    const members = getGroupMembers(currentGraph, groupId);
    if (members.length === 0) {
      console.debug('[cliCanvasPlan] group skipped: no members', {
        request_id: requestId,
        group: groupId,
      });
      skipped.push({ node_id: groupId, reason: 'no_layout_output' });
      continue;
    }

    const memberIds = new Set(members.map((member) => member.id));
    const orderIds = section.order ?? [];
    const orderRejection = validateGroupOrder(requestId, originalGraph, groupId, orderIds, memberIds);
    if (orderRejection !== null) return orderRejection;

    const result = await store.planAutoLayoutContainer(
      groupId,
      buildLayoutOptions(
        section.columns,
        section.gap ?? NODE_GAP,
        section.order_mode ?? 'position',
        orderIds,
      ),
    );
    if (result === null) {
      // 折叠容器 / 无成员 / 图缺失：整理引擎无可执行输出，按条件跳过（不阻断其他段）。
      console.debug('[cliCanvasPlan] group skipped: no layout output', {
        request_id: requestId,
        group: groupId,
        members: members.length,
      });
      skipped.push({ node_id: groupId, reason: 'no_layout_output' });
      continue;
    }

    const resultPositions = positionMapFromRecord(result.positions);
    for (const [nodeId, position] of resultPositions) {
      planned.set(nodeId, position);
      assigned.add(nodeId);
      inspected.add(nodeId);
    }
    currentGraph = withPlannedPositions(currentGraph, resultPositions);
    orderReports.push({
      contentReordered: result.contentReordered,
      orderChanges: result.orderChanges,
    });
  }

  // --- 2) containers：在合成图上整版看板排布（覆盖组内结果 = 整组平移） -----------
  if (plan.containers !== undefined) {
    const section = plan.containers;
    const packResult = planContainerPack({
      nodeGraph: currentGraph,
      store,
      columns: section.columns,
      gap: section.gap ?? NODE_GAP,
      order: section.order ?? [],
      orderMode: section.order_mode ?? 'position',
    });
    if (!packResult.ok) {
      console.debug('[cliCanvasPlan] containers rejected', {
        request_id: requestId,
        code: packResult.code,
      });
      return buildErrorResponse('canvas.layout', requestId, packResult.code, packResult.message);
    }

    const pack = packResult.plan;
    for (const nodeId of pack.affectedNodeIds) {
      const position = pack.plannedPositions.get(nodeId);
      if (position === undefined) {
        console.debug('[cliCanvasPlan] container affected node without planned position, skipped', {
          request_id: requestId,
          nodeId,
        });
        continue;
      }
      planned.set(nodeId, position);
      assigned.add(nodeId);
      inspected.add(nodeId);
    }
    currentGraph = withPlannedPositions(currentGraph, pack.plannedPositions);
    skipped.push(...pack.skipped);
    orderReports.push({
      contentReordered: pack.contentReordered,
      orderChanges: pack.orderChanges,
    });
  }

  // --- 3) positions：显式绝对坐标（不得与容器 / 已覆盖节点冲突） ------------------
  if (plan.positions !== undefined) {
    const nodeById = new Map(originalGraph.nodes.map((node) => [node.id, node] as const));
    for (const [nodeId, position] of Object.entries(plan.positions)) {
      const node = nodeById.get(nodeId);
      if (node === undefined) {
        console.debug('[cliCanvasPlan] positions rejected: node not found', {
          request_id: requestId,
          nodeId,
        });
        return buildErrorResponse(
          'canvas.layout',
          requestId,
          'node_not_found',
          `画布上找不到这个节点：${nodeId}。请确认节点标识后重试。`,
        );
      }
      if (isContainerNode(node)) {
        console.debug('[cliCanvasPlan] positions rejected: container target', {
          request_id: requestId,
          nodeId,
        });
        return buildErrorResponse(
          'canvas.layout',
          requestId,
          'command_rejected',
          `这个节点是容器节点，位置由其成员派生、不能按绝对坐标放置：${nodeId}。请用 groups 或 containers 段整理容器。`,
        );
      }
      if (assigned.has(nodeId)) {
        console.debug('[cliCanvasPlan] positions rejected: node already covered by plan', {
          request_id: requestId,
          nodeId,
        });
        return buildErrorResponse(
          'canvas.layout',
          requestId,
          'command_rejected',
          `节点 ${nodeId} 已被 groups/containers 覆盖，不能再给显式坐标。`,
        );
      }
      planned.set(nodeId, position);
      assigned.add(nodeId);
      inspected.add(nodeId);
    }
  }

  // --- 4) 计划合成：写前快照 × 计划位置 -----------------------------------------
  const before = snapshotPositions(originalGraph);
  const finalPositions: PositionMap = new Map(before);
  for (const [nodeId, position] of planned) finalPositions.set(nodeId, position);
  const movedIds = collectMovedIds(before, finalPositions);
  const orderReport = aggregateOrderReports(orderReports);

  // --- 5) 零位移：不写、不登记（不得伪造撤销标识） -------------------------------
  if (movedIds.length === 0) {
    console.debug('[cliCanvasPlan] plan produced no movement; nothing written', {
      request_id: requestId,
      inspected: inspected.size,
      skipped: skipped.length,
    });
    return {
      command: 'canvas.layout',
      request_id: requestId,
      positions: {},
      columns: null,
      gap: null,
      plan_applied: true,
      content_reordered: orderReport.content_reordered,
      order_changes: orderReport.order_changes,
      summary: buildPlanSummary(inspected, [], skipped),
      operation_id: null,
      dry_run: command.dry_run === true,
    };
  }

  // --- 6) dry-run：只读合成图求渲染口径位置 -------------------------------------
  if (command.dry_run === true) {
    console.debug('[cliCanvasPlan] plan dry-run computed; canvas untouched', {
      request_id: requestId,
      inspected: inspected.size,
      moved: movedIds.length,
      skipped: skipped.length,
    });
    return {
      command: 'canvas.layout',
      request_id: requestId,
      positions: readRenderPositionsOf({
        nodeGraph: withPlannedPositions(originalGraph, finalPositions),
        sizeSources: buildCanvasSizeSources(store),
        nodeIds: movedIds,
      }),
      columns: null,
      gap: null,
      plan_applied: true,
      content_reordered: orderReport.content_reordered,
      order_changes: orderReport.order_changes,
      summary: buildPlanSummary(inspected, movedIds, skipped),
      operation_id: null,
      dry_run: true,
    };
  }

  // --- 7) 真实执行：一次批量写入 = 一条历史 + 一条按操作撤销 ---------------------
  const payload = movedIds.flatMap((nodeId) => {
    const position = finalPositions.get(nodeId);
    return position === undefined ? [] : [{ id: nodeId, position }];
  });
  store.updateNodePositionsBatch(payload);

  const afterState = useCanvasStore.getState();
  const afterGraph = afterState.nodeGraph;
  const afterPositions = snapshotPositions(afterGraph);
  const movedAfter = collectMovedIds(before, afterPositions);
  const operationId = registerPositionOperation(buildInversePositions(before, afterPositions));
  console.debug('[cliCanvasPlan] plan executed in one batch', {
    request_id: requestId,
    inspected: inspected.size,
    moved: movedAfter.length,
    skipped: skipped.length,
  });
  return {
    command: 'canvas.layout',
    request_id: requestId,
    positions: readRenderPositionsOf({
      nodeGraph: afterGraph,
      sizeSources: buildCanvasSizeSources(afterState),
      nodeIds: movedAfter,
    }),
    columns: null,
    gap: null,
    plan_applied: true,
    content_reordered: orderReport.content_reordered,
    order_changes: orderReport.order_changes,
    summary: buildPlanSummary(inspected, movedAfter, skipped),
    operation_id: operationId,
    dry_run: false,
  };
};
