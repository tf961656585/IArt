/**
 * CLI 出生组与任务画布投影身份（spec docs/integrations/CLI与本地Agent集成.md §5.4 / CLI-043、
 * CLI-044、CLI-046）——从 taskProjectionService.ts 拆出的职责边界：
 * - resolveBirthGroupIdByName：--group 组名解析（唯一同名入组 / 零个自动建组 / 歧义拦截的数据源）；
 * - createBirthGroup：视口安全区防重叠定位的空组建组（自动建组与 CLI 空组建组命令共享实现）；
 * - resolveTaskCanvasIdentities：受理回执 / 终态输出的 node_id/group_id 数据源。
 *
 * 归属 projection 域：读的是画布投影现值（canvasStore），写走 store 既有 action
 * （createGroup / renameGroup，历史语义由 action 层承载），本模块不自建第二套写入。
 */
import type { CliTaskCanvasIdentity } from '@iart/contracts';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { normalizeViewport } from '@/features/canvas/components/canvas/nodeCanvasConstants';
import type { GraphNode, GroupNodeData, TaskNodeData } from '@/features/canvas/types/node';
import {
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  computeViewportRects,
  searchFreeBlockPosition,
} from '@/features/canvas/utils/taskNodePlacement';
import {
  buildCanvasSizeSources,
  buildNodeOccupancyRects,
} from '@/features/canvas/utils/nodeOccupancy';
import {
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING,
} from '@/features/canvas/services/groupGeometry';

// ---------------------------------------------------------------------------
// CLI 出生组（spec docs/integrations/CLI与本地Agent集成.md §5.4 / CLI-043、CLI-044）
// ---------------------------------------------------------------------------

export type BirthGroupResolution =
  | { kind: 'unique'; groupId: string }
  | { kind: 'ambiguous'; groupIds: string[] }
  | { kind: 'none' };

/**
 * 按组名解析出生组（CLI --group 的前置校验阶段拦截输入，CLI-043）。
 *
 * 匹配口径：节点组（type=group）按 GroupNodeData.name 精确匹配；Agent 容器不参与匹配
 *（--group 语义是「生进节点组」，Agent 容器成员关系归 Agent 血缘链路承载）。空名组不匹配。
 * 画布未载入按「无匹配」处理并留痕（调用方此前已确保项目打开，此为防御分支）。
 */
export const resolveBirthGroupIdByName = (groupName: string): BirthGroupResolution => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) {
    console.debug('[taskProjection] birth group resolution: graph not loaded', { groupName });
    return { kind: 'none' };
  }
  const matches: GraphNode<GroupNodeData>[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'group') continue;
    if ((node.data as GroupNodeData).name !== groupName) continue;
    matches.push(node as GraphNode<GroupNodeData>);
  }
  const first = matches[0];
  if (matches.length === 1 && first) return { kind: 'unique', groupId: first.id };
  if (matches.length > 1) return { kind: 'ambiguous', groupIds: matches.map((node) => node.id) };
  return { kind: 'none' };
};

/**
 * CLI 出生组自动建组（CLI-043 零匹配分支 / CLI-044 空组建组共享实现）：
 * 视口安全区防重叠块搜索定位（空组派生包围盒 = 组头卡片 + padding 的最小可见尺寸，
 * 与 groupDerivedSize 空组 entry 同口径）→ 空组建组（allowEmpty 专用通道）→ 命名。
 *
 * 安全区放不下（极端 zoom / 拥挤）时零坐标兜底并留痕；建组失败（图未载入等）返回 null
 * 由调用方按 projection-failed 语义处置（受理已成立，画布可见性未达成）。
 */
export const createBirthGroup = (groupName: string): string | null => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!graph) {
    console.debug('[taskProjection] birth group creation: graph not loaded', { groupName });
    return null;
  }
  const { safe } = computeViewportRects(normalizeViewport(graph.viewport), state.ui.canvasContainerSize);
  const sizeSources = buildCanvasSizeSources(state);
  const emptyGroupCell = {
    dx: 0,
    dy: 0,
    width: GROUP_COLLAPSED_MIN_WIDTH,
    height: GROUP_HEADER_HEIGHT + GROUP_PADDING.top + GROUP_PADDING.bottom,
  };
  const anchor = {
    x: safe.x + (safe.width - emptyGroupCell.width) / 2,
    y: safe.y + (safe.height - emptyGroupCell.height) / 2,
  };
  const found = searchFreeBlockPosition({
    occupancy: buildNodeOccupancyRects(graph.nodes, sizeSources),
    anchor,
    cells: [emptyGroupCell],
    stepX: emptyGroupCell.width + TASK_BATCH_GAP_X,
    stepY: emptyGroupCell.height + TASK_BATCH_GAP_Y,
    target: safe,
  });
  if (found === null) {
    console.debug('[taskProjection] birth group safe-area search exhausted, fallback to origin', { groupName });
  }
  const position = found ?? { x: 0, y: 0 };
  const groupId = state.createGroup([], position, { allowEmpty: true });
  if (groupId === null) {
    console.debug('[taskProjection] birth group creation failed', { groupName });
    return null;
  }
  const trimmed = groupName.trim();
  if (trimmed.length > 0) {
    // renameGroup 非合批感知，独立成一条历史：与 CLI 建组映射同口径（可逐步撤销）。
    state.renameGroup(groupId, trimmed);
  }
  return groupId;
};

/**
 * 按 task_id 集合解析画布任务投影身份（CLI-046 受理回执/终态输出的 node_id/group_id 数据源）。
 * 投影缺失（未创建/已 morph/图未载入）输出 null——缺省不伪造，不以占位值冒充。
 */
export const resolveTaskCanvasIdentities = (
  taskIds: readonly string[],
): ReadonlyMap<string, CliTaskCanvasIdentity> => {
  const graph = useCanvasStore.getState().nodeGraph;
  const result = new Map<string, CliTaskCanvasIdentity>();
  if (!graph) {
    console.debug('[taskProjection] task canvas identity resolution: graph not loaded');
    for (const taskId of taskIds) result.set(taskId, { node_id: null, group_id: null });
    return result;
  }
  for (const taskId of taskIds) {
    const node = graph.nodes.find(
      (candidate) => candidate.type === 'task' && (candidate.data as TaskNodeData).taskId === taskId,
    );
    if (!node) {
      result.set(taskId, { node_id: null, group_id: null });
      continue;
    }
    result.set(taskId, {
      node_id: node.id,
      group_id: typeof node.groupId === 'string' && node.groupId.length > 0 ? node.groupId : null,
    });
  }
  return result;
};
