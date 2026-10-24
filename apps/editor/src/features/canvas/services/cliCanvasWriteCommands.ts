/**
 * CLI 代理执行通道 · 画布写原语（spec docs/integrations/CLI与本地Agent集成.md §5.3 / §6.3）。
 *
 * 职责边界（从 cliProxyReceiver.ts 拆出，接收端只做分派）：
 * - `canvas.node.move` / `canvas.nodes.move` / `canvas.group.move`：位置写原语；
 * - `canvas.layout`：三个作用域的整理（含 dry-run 与执行报告）；
 * - `canvas.undo`：按操作撤销。
 *
 * 三条不变式（本批核心）：
 * 1. **一次写命令 = 一条撤销记录**：任何位置写入都只调用一次
 *    `updateNodePositionsBatch`（或既有 layout action 内部的单次批量写入），不循环调用单节点
 *    命令；该 action 内部产出 patches/inversePatches 并落一条历史。
 * 2. **dry-run 零副作用**：dry-run 分支只读 store 现值并调用纯计划入口
 *    （`planAutoLayout` / `planAutoLayoutContainer` / `planLayoutContainers`）或就地做算术，
 *    绝不调用任何写 action、不落历史、不登记撤销条目；响应的 operation_id 为 null。
 * 3. **执行报告可区分空转**：summary.inspected 按各命令作用域口径统计候选，moved 按写入后
 *    实际位移集合统计，unchanged 排除 skipped 后统计，使「检查了 N 个容器、无相交」与
 *    「什么也没做」在数据上可见。
 *
 * 容器位置是成员包围盒的派生量：容器寻址移动一律换算为成员位移，展开态容器的存储 position
 * 由 `updateNodePositionsBatch` 的既有重派生逻辑写回；折叠态/空容器没有可派生的成员，直接
 * 写容器自身 position（与界面拖拽同一语义）。
 */

import type {
  CliCanvasOperationSummary,
  CliProxyCommand,
  CliProxyCommandResponse,
} from '@iart/contracts';
import { NODE_GAP } from '@/features/canvas/layout/layoutPrimitives';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { CanvasStore } from '@/features/canvas/store/canvasStore';
import type { NodeGraph, NodePosition } from '@/features/canvas/types';
import { buildGroupDerivedSize } from '@/features/canvas/components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { expandPositionUpdatesWithCompanions } from '@/features/canvas/services/nodeCompanion/nodeCompanionManager';
import {
  expandPositionUpdatesWithGroup,
  getGroupMembers,
  isContainerCollapsed,
  isContainerNode,
  isGroupMember,
  type GroupPositionUpdate,
} from './groupMembership';
import { buildErrorResponse, projectNotOpenResponse } from './cliProxyErrorResponses';
import {
  readCliOperation,
  registerPositionOperation,
  registerUnsupportedOperation,
  removeCliOperation,
} from './cliOperationRegistry';
import {
  buildInversePositions,
  collectMovedIds,
  readPositionsOf,
  readRenderPositionsOf,
  snapshotPositions,
  withPlannedPositions,
  type PositionMap,
} from './cliCanvasPositionOps';
import {
  buildLayoutOptions,
  executeContainerPackLayout,
  readLayoutOrderReport,
  resolveLayoutOrderMode,
} from './cliCanvasPackCommand';

// ---------------------------------------------------------------------------
// 位置快照与执行报告
// ---------------------------------------------------------------------------

// 位置快照 / 值比较 / 逆位移构造统一由 cliCanvasPositionOps 承载（与容器看板排布同一口径）。

/**
 * 执行报告构造（统一口径）：
 * - inspected：本命令纳入考虑的候选（按命令作用域，见各命令注释）；
 * - moved：实际（或计划）发生位移的节点数（含伴随/级联节点，可大于 inspected）；
 * - cascaded：moved 中不属于 inspected 的伴随/级联节点数（如容器展开带出的成员）——
 *   与 moved 并列输出，使「一次移动带出了多少非请求节点」可机器判读；
 * - unchanged：候选里既未位移也未被跳过的数量；
 * - skipped：被跳过的对象与稳定原因短句。
 */
const buildSummary = (
  inspectedIds: readonly string[],
  movedIds: ReadonlySet<string>,
  skipped: ReadonlyArray<{ node_id: string; reason: string }>,
): CliCanvasOperationSummary => {
  const inspectedSet = new Set(inspectedIds);
  const skippedIds = new Set(skipped.map((entry) => entry.node_id));
  const unchanged = inspectedIds.filter(
    (nodeId) => !movedIds.has(nodeId) && !skippedIds.has(nodeId),
  ).length;
  let cascaded = 0;
  for (const nodeId of movedIds) {
    if (!inspectedSet.has(nodeId)) cascaded += 1;
  }
  return {
    inspected: inspectedIds.length,
    moved: movedIds.size,
    cascaded,
    unchanged,
    skipped: [...skipped],
  };
};

/**
 * 单次批量位置写入 + 逆操作登记（一次调用 = 一条历史）。
 *
 * 逆操作按「写入前后全图 diff」生成：包含伴随节点与容器派生位移，撤销时应用同一批逆位移，
 * 因此用户其间的其他手工编辑（未被本次操作触碰的节点）不受影响。
 */
const writePositions = (
  store: CanvasStore,
  moves: Array<{ id: string; position: NodePosition }>,
): { movedIds: string[]; operationId: string } => {
  const before = snapshotPositions(store.nodeGraph);
  store.updateNodePositionsBatch(moves);
  const afterGraph = useCanvasStore.getState().nodeGraph;
  const after = snapshotPositions(afterGraph);
  const movedIds = collectMovedIds(before, after);
  const operationId = registerPositionOperation(buildInversePositions(before, after));
  return { movedIds, operationId };
};

/** 纯计划展开：与 updateNodePositionsBatch 相同的两层展开（companion → 容器跟随），不写 store。 */
const planExpandedPositions = (
  nodeGraph: NodeGraph,
  payload: GroupPositionUpdate[],
): PositionMap => {
  const expanded = expandPositionUpdatesWithGroup(
    nodeGraph,
    expandPositionUpdatesWithCompanions(nodeGraph, payload),
  );
  const map = snapshotPositions(nodeGraph);
  for (const update of expanded) {
    map.set(update.id, { x: update.position.x, y: update.position.y });
  }
  return map;
};

const asMovedSet = (ids: readonly string[]): Set<string> => new Set(ids);

// ---------------------------------------------------------------------------
// canvas.node.move
// ---------------------------------------------------------------------------

/**
 * `canvas.node.move`：单节点绝对落点（spec CLI-028）。
 *
 * inspected 口径 = 目标节点（1）。响应 moved_node_ids 保持既有语义：排除容器派生位移
 * （容器 position 是成员包围盒的派生量，不属移动面）。
 */
export const executeNodeMove = (
  command: Extract<CliProxyCommand, { command: 'canvas.node.move' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) return projectNotOpenResponse('canvas.node.move', requestId);

  const target = nodeGraph.nodes.find((node) => node.id === command.node);
  if (!target) {
    console.debug('[cliProxyReceiver] node move rejected: node not found', {
      request_id: requestId,
      node: command.node,
    });
    return buildErrorResponse(
      'canvas.node.move',
      requestId,
      'node_not_found',
      `画布上找不到这个节点：${command.node}。请确认节点标识后重试。`,
    );
  }
  if (isContainerNode(target)) {
    console.debug('[cliProxyReceiver] node move rejected: target is a container node', {
      request_id: requestId,
      node: command.node,
      nodeType: target.type,
    });
    return buildErrorResponse(
      'canvas.node.move',
      requestId,
      'command_rejected',
      `这个节点是容器节点，位置由其成员派生、不能直接移动：${command.node}。请移动组内的成员节点。`,
    );
  }

  const dryRun = command.dry_run === true;
  if (dryRun) {
    const before = snapshotPositions(nodeGraph);
    const planned = planExpandedPositions(nodeGraph, [
      { id: command.node, position: { x: command.x, y: command.y } },
    ]);
    const containerIds = new Set(
      nodeGraph.nodes.filter(isContainerNode).map((node) => node.id),
    );
    const movedIds = collectMovedIds(before, planned).filter((id) => !containerIds.has(id));
    console.debug('[cliCanvasWrite] node.move dry-run planned', {
      request_id: requestId,
      moved: movedIds.length,
    });
    return {
      command: 'canvas.node.move',
      request_id: requestId,
      node_id: command.node,
      position: planned.get(command.node) ?? { x: command.x, y: command.y },
      moved_node_ids: movedIds,
      summary: buildSummary([command.node], asMovedSet(movedIds), []),
      operation_id: null,
      dry_run: true,
    };
  }

  const { movedIds, operationId } = writePositions(store, [
    { id: command.node, position: { x: command.x, y: command.y } },
  ]);
  const afterGraph = useCanvasStore.getState().nodeGraph;
  const containerIds = new Set(
    (afterGraph?.nodes ?? []).filter(isContainerNode).map((node) => node.id),
  );
  const movedNodeIds = movedIds.filter((id) => !containerIds.has(id));
  const finalPosition =
    afterGraph?.nodes.find((node) => node.id === command.node)?.position ?? {
      x: command.x,
      y: command.y,
    };
  return {
    command: 'canvas.node.move',
    request_id: requestId,
    node_id: command.node,
    position: { x: finalPosition.x, y: finalPosition.y },
    moved_node_ids: movedNodeIds,
    summary: buildSummary([command.node], asMovedSet(movedNodeIds), []),
    operation_id: operationId,
    dry_run: false,
  };
};

// ---------------------------------------------------------------------------
// canvas.nodes.move
// ---------------------------------------------------------------------------

/**
 * `canvas.nodes.move`：批量移动（spec §5.3 / CLI-053 / CLI-059），两族互斥。
 *
 * - 相对族（`nodes` + `dx` + `dy`）：整体平移，允许包含容器 id（展开语义连成员一起移动）；
 * - 绝对族（`positions`）：逐节点绝对落点；node 必须存在、容器节点拒绝（改用 group move）、
 *   重复 node_id 拒绝（同一节点两个目标自相矛盾）；
 * - 两族同时出现 / 都没给 → `command_rejected`；任一节点不存在 → 整批 `node_not_found`；
 * - inspected = 去重后的请求节点数；positions 用渲染口径（容器 = 派生渲染框左上角）。
 */
export const executeNodesMove = (
  command: Extract<CliProxyCommand, { command: 'canvas.nodes.move' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) return projectNotOpenResponse('canvas.nodes.move', requestId);

  const absoluteEntries = command.positions;
  const hasAbsolute = absoluteEntries !== undefined;
  const hasRelativeArgs =
    command.nodes !== undefined || command.dx !== undefined || command.dy !== undefined;
  if (hasAbsolute && hasRelativeArgs) {
    console.debug('[cliCanvasWrite] nodes.move rejected: absolute and relative args mixed', {
      request_id: requestId,
    });
    return buildErrorResponse(
      'canvas.nodes.move',
      requestId,
      'command_rejected',
      '绝对坐标（--positions）与相对位移（--nodes/--dx/--dy）不能同时使用，请只选一种。',
    );
  }
  if (!hasAbsolute && !hasRelativeArgs) {
    console.debug('[cliCanvasWrite] nodes.move rejected: no target given', {
      request_id: requestId,
    });
    return buildErrorResponse(
      'canvas.nodes.move',
      requestId,
      'command_rejected',
      '请给出相对位移（--nodes 配 --dx/--dy）或绝对坐标（--positions）中的一种。',
    );
  }

  const nodeIds: string[] = [];
  const payload: Array<{ id: string; position: NodePosition }> = [];
  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));

  if (absoluteEntries !== undefined) {
    // 绝对族：重复 node_id 拒绝（先于存在性判定，避免同一节点被两个目标撕裂）
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of absoluteEntries) {
      if (seen.has(entry.node_id)) {
        if (!duplicates.includes(entry.node_id)) duplicates.push(entry.node_id);
        continue;
      }
      seen.add(entry.node_id);
      nodeIds.push(entry.node_id);
    }
    if (duplicates.length > 0) {
      console.debug('[cliCanvasWrite] nodes.move rejected: duplicate node ids', { request_id: requestId, duplicates });
      return buildErrorResponse(
        'canvas.nodes.move',
        requestId,
        'command_rejected',
        `同一节点在 --positions 里出现了多次：${duplicates.join('、')}。一个节点只能指定一个目标坐标。`,
      );
    }
  } else {
    if (command.nodes === undefined || command.dx === undefined || command.dy === undefined) {
      console.debug('[cliCanvasWrite] nodes.move rejected: incomplete relative args', { request_id: requestId });
      return buildErrorResponse(
        'canvas.nodes.move',
        requestId,
        'command_rejected',
        '相对位移需要同时给出 --nodes 与 --dx/--dy。',
      );
    }
    nodeIds.push(...new Set(command.nodes));
  }

  const missing = nodeIds.filter((id) => !nodeById.has(id));
  if (missing.length > 0) {
    console.debug('[cliCanvasWrite] nodes.move rejected: nodes not found', {
      request_id: requestId,
      missing,
    });
    return buildErrorResponse(
      'canvas.nodes.move',
      requestId,
      'node_not_found',
      `画布上找不到这些节点：${missing.join('、')}。请确认节点标识后重试。`,
    );
  }

  if (absoluteEntries !== undefined) {
    // 绝对落点只接受叶子节点：容器渲染框由成员派生，绝对落点与成员位移没有唯一换算。
    const containerTargets = nodeIds.filter((id) => {
      const node = nodeById.get(id);
      return node !== undefined && isContainerNode(node);
    });
    if (containerTargets.length > 0) {
      console.debug('[cliCanvasWrite] nodes.move rejected: container targets', { request_id: requestId, containerTargets });
      return buildErrorResponse(
        'canvas.nodes.move',
        requestId,
        'command_rejected',
        `这些是容器节点，位置由其成员派生、不能按绝对坐标放置：${containerTargets.join('、')}。请改用 canvas group move --x/--y 移动整个容器。`,
      );
    }
    for (const entry of absoluteEntries) {
      payload.push({ id: entry.node_id, position: { x: entry.x, y: entry.y } });
    }
  } else {
    const dx = command.dx ?? 0;
    const dy = command.dy ?? 0;
    for (const id of nodeIds) {
      const node = nodeById.get(id);
      if (node === undefined) continue;
      payload.push({
        id,
        position: { x: node.position.x + dx, y: node.position.y + dy },
      });
    }
  }

  if (command.dry_run === true) {
    const before = snapshotPositions(nodeGraph);
    const planned = planExpandedPositions(nodeGraph, payload);
    const movedIds = collectMovedIds(before, planned);
    const plannedGraph = withPlannedPositions(nodeGraph, planned);
    console.debug('[cliCanvasWrite] nodes.move dry-run planned', {
      request_id: requestId,
      inspected: nodeIds.length,
      moved: movedIds.length,
      absolute: absoluteEntries !== undefined,
    });
    return {
      command: 'canvas.nodes.move',
      request_id: requestId,
      // 计划值（渲染口径）：请求节点 + 级联展开出的节点的最终（计划）位置。
      positions: readRenderPositionsOf({
        nodeGraph: plannedGraph,
        sizeSources: buildCanvasSizeSources(store),
        nodeIds: new Set([...nodeIds, ...movedIds]),
      }),
      moved_node_ids: movedIds,
      summary: buildSummary(nodeIds, asMovedSet(movedIds), []),
      operation_id: null,
      dry_run: true,
    };
  }

  const { movedIds, operationId } = writePositions(store, payload);
  const afterState = useCanvasStore.getState();
  return {
    command: 'canvas.nodes.move',
    request_id: requestId,
    positions: readRenderPositionsOf({
      nodeGraph: afterState.nodeGraph,
      sizeSources: buildCanvasSizeSources(afterState),
      nodeIds: new Set([...nodeIds, ...movedIds]),
    }),
    moved_node_ids: movedIds,
    summary: buildSummary(nodeIds, asMovedSet(movedIds), []),
    operation_id: operationId,
    dry_run: false,
  };
};

// ---------------------------------------------------------------------------
// canvas.group.move
// ---------------------------------------------------------------------------

/**
 * `canvas.group.move`：容器寻址移动（spec §5.3 / CLI-052）。
 *
 * - 容器不存在 → `group_not_found`；目标是普通节点 → `command_rejected`；
 * - 相对位移族（dx/dy 至少一个）与绝对落点族（x/y 至少一个）互斥，同时出现 →
 *   `command_rejected`（解析器侧同一判定按用法错误先拒一次）；两族都没给同样拒绝；
 * - 容器渲染框左上角 = 派生框左上角（与投影层同一 owner `buildGroupDerivedSize`）；
 *   绝对落点未给的轴保持当前；
 * - 空容器（无成员）：直接写容器自身 position（按同一 delta），不展开成员；
 * - inspected 口径 = 容器 + 直接成员数。
 */
export const executeGroupMove = (
  command: Extract<CliProxyCommand, { command: 'canvas.group.move' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) return projectNotOpenResponse('canvas.group.move', requestId);

  const container = nodeGraph.nodes.find(
    (node) => node.id === command.group && isContainerNode(node),
  );
  if (container === undefined) {
    const exists = nodeGraph.nodes.some((node) => node.id === command.group);
    console.debug('[cliCanvasWrite] group.move rejected', {
      request_id: requestId,
      group: command.group,
      reason: exists ? 'not_a_container' : 'group_not_found',
    });
    if (exists) {
      return buildErrorResponse(
        'canvas.group.move',
        requestId,
        'command_rejected',
        `这个节点不是容器节点，不能按容器移动：${command.group}。`,
      );
    }
    return buildErrorResponse(
      'canvas.group.move',
      requestId,
      'group_not_found',
      `画布上找不到这个容器：${command.group}。请确认容器标识后重试。`,
    );
  }

  const hasRelative = command.dx !== undefined || command.dy !== undefined;
  const hasAbsolute = command.x !== undefined || command.y !== undefined;
  if (hasRelative && hasAbsolute) {
    console.debug('[cliCanvasWrite] group.move rejected: relative and absolute args mixed', {
      request_id: requestId,
      group: command.group,
    });
    return buildErrorResponse(
      'canvas.group.move',
      requestId,
      'command_rejected',
      '相对位移（--dx/--dy）与绝对落点（--x/--y）不能同时使用，请只选一种。',
    );
  }
  if (!hasRelative && !hasAbsolute) {
    console.debug('[cliCanvasWrite] group.move rejected: no target given', {
      request_id: requestId,
      group: command.group,
    });
    return buildErrorResponse(
      'canvas.group.move',
      requestId,
      'command_rejected',
      '请给出相对位移（--dx/--dy）或绝对落点（--x/--y）中的至少一项。',
    );
  }

  // 渲染框左上角：派生框优先（与 canvas.geometry.get 同一 owner），缺失回落存储 position
  //（空容器 / 折叠容器没有展开态派生框）。
  const derived = buildGroupDerivedSize({
    nodes: nodeGraph.nodes,
    sizeSources: buildCanvasSizeSources(store),
  }).byGroupId[command.group];
  const frame = derived?.position ?? container.position;

  const delta: NodePosition = hasRelative
    ? { x: command.dx ?? 0, y: command.dy ?? 0 }
    : {
        x: command.x === undefined ? 0 : command.x - frame.x,
        y: command.y === undefined ? 0 : command.y - frame.y,
      };

  const members = getGroupMembers(nodeGraph, command.group);
  // 容器自身按其存储 position 平移，成员按各自 position 平移同一 delta：
  // 显式给出两者可保证展开态（成员先显式位移、容器随后由成员重派生）与
  // 折叠态/空容器（容器 position 不被重派生覆盖）两条路径都精确移动 delta。
  const payload: Array<{ id: string; position: NodePosition }> = [
    {
      id: container.id,
      position: {
        x: container.position.x + delta.x,
        y: container.position.y + delta.y,
      },
    },
    ...members.map((member) => ({
      id: member.id,
      position: { x: member.position.x + delta.x, y: member.position.y + delta.y },
    })),
  ];

  const inspectedIds = [container.id, ...members.map((member) => member.id)];

  if (command.dry_run === true) {
    const before = snapshotPositions(nodeGraph);
    const planned = planExpandedPositions(nodeGraph, payload);
    const movedIds = collectMovedIds(before, planned);
    console.debug('[cliCanvasWrite] group.move dry-run planned', {
      request_id: requestId,
      group: command.group,
      members: members.length,
      moved: movedIds.length,
    });
    return {
      command: 'canvas.group.move',
      request_id: requestId,
      group_node_id: command.group,
      // 计划值（渲染口径）：容器 = 派生渲染框计划值，成员 = 各自计划坐标。
      positions: readRenderPositionsOf({
        nodeGraph: withPlannedPositions(nodeGraph, planned),
        sizeSources: buildCanvasSizeSources(store),
        nodeIds: new Set([...inspectedIds, ...movedIds]),
      }),
      moved_node_ids: movedIds,
      summary: buildSummary(inspectedIds, asMovedSet(movedIds), []),
      operation_id: null,
      dry_run: true,
    };
  }

  const { movedIds, operationId } = writePositions(store, payload);
  const afterState = useCanvasStore.getState();
  return {
    command: 'canvas.group.move',
    request_id: requestId,
    group_node_id: command.group,
    positions: readRenderPositionsOf({
      nodeGraph: afterState.nodeGraph,
      sizeSources: buildCanvasSizeSources(afterState),
      nodeIds: new Set([...inspectedIds, ...movedIds]),
    }),
    moved_node_ids: movedIds,
    summary: buildSummary(inspectedIds, asMovedSet(movedIds), []),
    operation_id: operationId,
    dry_run: false,
  };
};

// ---------------------------------------------------------------------------
// canvas.layout
// ---------------------------------------------------------------------------

/**
 * `canvas.layout` 的 `order` 显式顺序前置校验（spec CLI-030）：order 节点必须存在且属于
 * 本次整理作用域。缺失 → node_not_found；存在但越界 → command_rejected。
 */
const validateLayoutOrder = (
  requestId: string,
  nodeGraph: NodeGraph,
  orderIds: readonly string[],
  eligibleIds: ReadonlySet<string>,
): CliProxyCommandResponse | null => {
  if (orderIds.length === 0) return null;
  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));
  const missing = orderIds.filter((id) => !nodeById.has(id));
  if (missing.length > 0) {
    console.debug('[cliProxyReceiver] layout rejected: order nodes not found', {
      request_id: requestId,
      missing,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'node_not_found',
      `顺序清单里有画布上不存在的节点：${missing.join('、')}。请确认节点标识后重试。`,
    );
  }
  const outOfScope = orderIds.filter((id) => !eligibleIds.has(id));
  if (outOfScope.length > 0) {
    console.debug('[cliProxyReceiver] layout rejected: order nodes outside layout scope', {
      request_id: requestId,
      outOfScope,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      `这些节点不在本次整理范围内，不能指定摆放顺序：${outOfScope.join('、')}。scope=all 只能指定未分组节点，scope=group 只能指定该组成员。`,
    );
  }
  return null;
};

/**
 * `canvas.layout`：三个作用域的整理写命令（spec §5.3 / CLI-030/032/048）。
 *
 * summary 口径：
 * - scope=all：inspected = 自由合法节点数（非容器、非成员）；
 * - scope=group:<id>：inspected = 成员数；
 * - scope=containers：inspected = 最外层容器数（区分「检查了 N 个容器、无相交」与空转）。
 * dry-run 跳过测量收敛等待（本入口本就不走 preMeasure 编排），零写入、零撤销记录。
 */
type CanvasLayoutCommand = Extract<CliProxyCommand, { command: 'canvas.layout' }>;
export const executeCanvasLayout = async (
  command: CanvasLayoutCommand & { scope: NonNullable<CanvasLayoutCommand['scope']> },
): Promise<CliProxyCommandResponse> => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) return projectNotOpenResponse('canvas.layout', requestId);

  const orderIds = [...new Set(command.order ?? [])];
  const dryRun = command.dry_run === true;
  const packRequested = command.pack === true;

  // `--pack` 只对 scope=containers 合法（spec CLI-055）：其他作用域携带按业务拒绝处理，
  // 画布零改动（不降级为参数解析失败，与 group.move 两族互斥的拒绝口径一致）。
  if (packRequested && command.scope !== 'containers') {
    console.debug('[cliCanvasWrite] layout rejected: --pack outside containers scope', {
      request_id: requestId,
      scope: command.scope,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '--pack 只适用于 --scope containers：其他作用域不支持按看板排列容器。',
    );
  }
  // 实际使用值（spec CLI-058）：all/group 缺省 1 列、间距 NODE_GAP（120）；pack 用自己的实际值。
  const actualColumns = command.columns ?? 1;
  const actualGap = command.gap ?? NODE_GAP;
  const orderMode = resolveLayoutOrderMode(requestId, command.order_mode);

  if (command.scope === 'containers') {
    // 容器看板排布（spec CLI-055）：独立执行入口，旧 containers 路径（只消除相交）不变。
    if (packRequested) return executeContainerPackLayout(command, orderMode);
    // 非 pack 的旧路径只做整组让位：列数 / 顺序 / 排序模式 / 间距都不适用，携带即业务拒绝
    //（静默忽略会让调用方误以为生效；画布零改动）。
    if (
      command.columns !== undefined ||
      orderIds.length > 0 ||
      command.order_mode !== undefined ||
      command.gap !== undefined
    ) {
      console.debug('[cliCanvasWrite] layout rejected: grid args on legacy containers scope', { request_id: requestId });
      return buildErrorResponse(
        'canvas.layout',
        requestId,
        'command_rejected',
        'scope=containers 不支持 --columns/--order/--order-mode/--gap：容器按整组平移，不重排成员。',
      );
    }
    const before = snapshotPositions(nodeGraph);
    const result = dryRun ? await store.planLayoutContainers() : await store.layoutContainers();
    if (result === null) {
      return buildErrorResponse('canvas.layout', requestId, 'command_rejected', '无法整理组间布局，请稍后重试。');
    }
    // 计划值：把计划位置套到写前快照上再 diff（零写入，绝不读「写入后」状态）。
    const planMap = new Map(before);
    if (dryRun) {
      for (const [nodeId, position] of Object.entries(result.positions)) {
        planMap.set(nodeId, position);
      }
    }
    const positionNodeIds = Object.keys(result.positions);
    const afterSnapshot = dryRun
      ? planMap
      : snapshotPositions(useCanvasStore.getState().nodeGraph);
    const movedIds = collectMovedIds(before, afterSnapshot);
    const containerMoved = new Set(
      result.inspectedContainerIds.filter((id) => movedIds.includes(id)),
    );
    console.debug('[cliCanvasWrite] containers layout summary', {
      request_id: requestId,
      dryRun,
      inspected: result.inspectedContainerIds.length,
      containersMoved: containerMoved.size,
      skipped: result.skipped.length,
    });
    const containersState = dryRun ? store : useCanvasStore.getState();
    return {
      command: 'canvas.layout',
      request_id: requestId,
      // 容器坐标统一为派生渲染框左上角（CLI-061），成员为各自 position。
      positions: readRenderPositionsOf({
        nodeGraph: dryRun
          ? withPlannedPositions(nodeGraph, afterSnapshot)
          : containersState.nodeGraph,
        sizeSources: buildCanvasSizeSources(containersState),
        nodeIds: positionNodeIds,
      }),
      summary: buildSummary(result.inspectedContainerIds, asMovedSet(movedIds), result.skipped),
      operation_id: dryRun ? null : registerLayoutOperation(before),
      dry_run: dryRun,
      // 非 pack 路径：列数/间距不适用，如实输出 null（不伪造 pack 参数）；
      // 该路径不重排成员顺序，顺序报告恒为「无变化」。
      columns: null,
      gap: null,
      content_reordered: false,
      order_changes: [],
    };
  }

  if (command.scope === 'all') {
    const affectedNodeIds = nodeGraph.nodes
      .filter((node) => !isContainerNode(node) && !isGroupMember(node))
      .map((node) => node.id);
    const orderRejection = validateLayoutOrder(
      requestId,
      nodeGraph,
      orderIds,
      new Set(affectedNodeIds),
    );
    if (orderRejection !== null) return orderRejection;
    const layoutOptions = buildLayoutOptions(command.columns, actualGap, orderMode, orderIds);
    const before = snapshotPositions(nodeGraph);

    if (dryRun) {
      const plan = await store.planAutoLayout(layoutOptions);
      const planMap = new Map(before);
      if (plan !== null) {
        for (const [nodeId, position] of Object.entries(plan.positions)) {
          planMap.set(nodeId, position);
        }
      }
      const movedIds = collectMovedIds(before, planMap);
      const skipped = affectedNodeIds
        .filter((id) => plan === null || plan.positions[id] === undefined)
        .map((nodeId) => ({ node_id: nodeId, reason: 'no_layout_output' }));
      return {
        command: 'canvas.layout',
        request_id: requestId,
        // 计划值（不读写入后状态，dry-run 根本没有写入后状态）。
        positions: (() => {
          const positions: Record<string, NodePosition> = {};
          for (const nodeId of affectedNodeIds) {
            const planned = planMap.get(nodeId);
            if (planned !== undefined) positions[nodeId] = planned;
          }
          return positions;
        })(),
        summary: buildSummary(affectedNodeIds, asMovedSet(movedIds), skipped),
        operation_id: null,
        dry_run: true,
        columns: actualColumns,
        gap: actualGap,
        ...readLayoutOrderReport(plan),
      };
    }

    const result = await store.autoLayout(layoutOptions);
    const afterGraph = useCanvasStore.getState().nodeGraph;
    const movedIds = collectMovedIds(before, snapshotPositions(afterGraph));
    return {
      command: 'canvas.layout',
      request_id: requestId,
      positions: readPositionsOf(afterGraph, affectedNodeIds),
      summary: buildSummary(affectedNodeIds, asMovedSet(movedIds), []),
      operation_id: registerLayoutOperation(before),
      dry_run: false,
      columns: actualColumns,
      gap: actualGap,
      ...readLayoutOrderReport(result),
    };
  }

  const groupId = command.scope.group;
  const container = nodeGraph.nodes.find((node) => node.id === groupId && isContainerNode(node));
  if (!container) {
    console.debug('[cliProxyReceiver] layout rejected: group not found', {
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
  if (isContainerCollapsed(container)) {
    console.debug('[cliProxyReceiver] layout rejected: container collapsed', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '这个组当前处于折叠状态，展开后才能整理布局。',
    );
  }
  const members = getGroupMembers(nodeGraph, groupId);
  if (members.length === 0) {
    console.debug('[cliProxyReceiver] layout rejected: no layout-able members', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '这个组还没有成员，无法整理布局。',
    );
  }
  const orderRejection = validateLayoutOrder(
    requestId,
    nodeGraph,
    orderIds,
    new Set(members.map((member) => member.id)),
  );
  if (orderRejection !== null) return orderRejection;

  const memberIds = members.map((member) => member.id);
  const before = snapshotPositions(nodeGraph);
  const options = buildLayoutOptions(command.columns, actualGap, orderMode, orderIds);

  if (dryRun) {
    const plan = await store.planAutoLayoutContainer(groupId, options);
    if (plan === null) {
      console.debug('[cliCanvasWrite] container layout plan returned null', {
        request_id: requestId,
        group: groupId,
      });
      return buildErrorResponse(
        'canvas.layout',
        requestId,
        'command_rejected',
        '无法整理这个组的布局，请稍后重试。',
      );
    }
    const planMap = new Map(before);
    for (const [nodeId, position] of Object.entries(plan.positions)) {
      planMap.set(nodeId, position);
    }
    const movedIds = collectMovedIds(before, planMap);
    const skipped = memberIds
      .filter((id) => plan.positions[id] === undefined)
      .map((nodeId) => ({ node_id: nodeId, reason: 'no_layout_output' }));
    return {
      command: 'canvas.layout',
      request_id: requestId,
      // 计划值（渲染口径）：成员里的 Agent 容器按派生渲染框输出。
      positions: readRenderPositionsOf({
        nodeGraph: withPlannedPositions(nodeGraph, planMap),
        sizeSources: buildCanvasSizeSources(store),
        nodeIds: memberIds,
      }),
      summary: buildSummary(memberIds, asMovedSet(movedIds), skipped),
      operation_id: null,
      dry_run: true,
      columns: actualColumns,
      gap: actualGap,
      ...readLayoutOrderReport(plan),
    };
  }

  const result = await store.autoLayoutContainer(groupId, options);
  if (result === null) {
    console.debug('[cliProxyReceiver] container layout returned null', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '无法整理这个组的布局，请稍后重试。',
    );
  }
  const afterState = useCanvasStore.getState();
  const movedIds = collectMovedIds(before, snapshotPositions(afterState.nodeGraph));
  return {
    command: 'canvas.layout',
    request_id: requestId,
    positions: readRenderPositionsOf({
      nodeGraph: afterState.nodeGraph,
      sizeSources: buildCanvasSizeSources(afterState),
      nodeIds: memberIds,
    }),
    summary: buildSummary(memberIds, asMovedSet(movedIds), []),
    operation_id: registerLayoutOperation(before),
    dry_run: false,
    columns: actualColumns,
    gap: actualGap,
    ...readLayoutOrderReport(result),
  };
};

/**
 * layout 的逆操作登记：按写入后 store 与写入前快照 diff 生成（与位置写原语同一口径）。
 * 调用点位于写 action 完成之后，before 由调用方在写前捕获。
 */
const registerLayoutOperation = (before: PositionMap): string => {
  const after = snapshotPositions(useCanvasStore.getState().nodeGraph);
  return registerPositionOperation(buildInversePositions(before, after));
};

// ---------------------------------------------------------------------------
// canvas.undo
// ---------------------------------------------------------------------------

/**
 * `canvas.undo --operation <id>`：按操作撤销（spec §5.3 / CLI-054）。
 *
 * - 只回退该次操作登记的逆位移，不影响其间的用户手工编辑（未被该操作触碰的节点不动）；
 * - 逆位移经一次 `updateNodePositionsBatch` 应用 = 一条新的历史记录（这次撤销本身可 Cmd+Z 反悔）；
 * - 未知 / 已撤销 / 窗口重建后丢失 → `operation_not_found`；
 * - 建组/解散/成员增删/删除/导入产生的标识 → `command_rejected`（该操作类型不支持按操作撤销）。
 */
export const executeCanvasUndo = (
  command: Extract<CliProxyCommand, { command: 'canvas.undo' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  if (store.nodeGraph === null) return projectNotOpenResponse('canvas.undo', requestId);

  const record = readCliOperation(command.operation);
  if (record === undefined) {
    console.debug('[cliCanvasWrite] undo rejected: operation record missing', {
      request_id: requestId,
      operation: command.operation,
    });
    return buildErrorResponse(
      'canvas.undo',
      requestId,
      'operation_not_found',
      `操作记录已失效或不存在：${command.operation}。画布窗口重新加载后，此前的操作记录会失效。`,
    );
  }
  if (record.kind === 'unsupported') {
    console.debug('[cliCanvasWrite] undo rejected: operation type not undoable', {
      request_id: requestId,
      operation: command.operation,
    });
    return buildErrorResponse(
      'canvas.undo',
      requestId,
      'command_rejected',
      '该操作类型不支持按操作撤销。按操作撤销只支持位置类操作（整理、移动）。',
    );
  }

  if (record.inverse.length > 0) {
    // 一次批量位置写入 = 一条新历史（撤销本身可被 Cmd+Z 反悔）。
    store.updateNodePositionsBatch(record.inverse);
  } else {
    // 该次操作实际零位移（如重复移动同一落点）：无需写入、也不该伪造历史。
    console.debug('[cliCanvasWrite] undo applied with empty inverse', {
      request_id: requestId,
      operation: command.operation,
    });
  }
  removeCliOperation(command.operation);
  const afterGraph = useCanvasStore.getState().nodeGraph;
  return {
    command: 'canvas.undo',
    request_id: requestId,
    undone: true,
    operation_id: command.operation,
    positions: readPositionsOf(
      afterGraph,
      record.inverse.map((entry) => entry.id),
    ),
  };
};

// ---------------------------------------------------------------------------
// 非位置类写命令的操作标识（存在但按操作撤销不支持）
// ---------------------------------------------------------------------------

/**
 * 为非位置类画布写命令（建组 / 解散 / 成员增删 / 删除 / 导入）生成 operation_id：
 * 登记为 `unsupported`，使后续 `canvas.undo` 能返回 `command_rejected`（而不是
 * operation_not_found）。这些命令的撤销走界面既有 Cmd+Z，不提供按操作撤销。
 */
export const issueUnsupportedOperationId = (): string => registerUnsupportedOperation();
