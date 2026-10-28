import type {
  MediaAssetsChangedNotification,
  MediaAsset,
  RuntimeMediaAssetView,
  RuntimeTaskFailure,
  RuntimeTaskOutputView,
  RuntimeTaskView,
  TaskStateNotification,
  TaskStateSnapshot,
} from '@iart/contracts';
import type { PromptDockBatchSubmitResponse } from '@iart/contracts';
import type { AgentTaskLineage } from '@iart/contracts';
import { parseAgentTaskLineage } from '@iart/contracts';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { applyOutpaintResultToAssetNode } from '@/features/canvas/utils/assetDerivation';
import { findAgentNodeBySessionId } from '@/features/agent/agentNodeProjection';
import { toast } from 'sonner';
import type {
  AssetNodeData,
  GraphNode,
  NodePosition,
  NodeSize,
  TaskNodeData,
  TaskNodeStatus,
} from '@/features/canvas/types/node';
import { TASK_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/task/taskNodeFactory';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';
import { normalizeViewport } from '@/features/canvas/components/canvas/nodeCanvasConstants';
import { logCanvasDebugEvent } from '@/features/canvas/debug/canvasDebug';
import {
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  computeGridCellsForSizes,
  computeTaskBatchPlacement,
  rectsIntersect,
  searchFreeBlockPosition,
} from '@/features/canvas/utils/taskNodePlacement';
import { computeMediaDisplaySize } from '@/features/canvas/layoutModel/mediaDisplaySizePolicy';
import { resolveEffectiveSize } from '@/features/canvas/utils/effectiveSize';
import {
  buildCanvasSizeSources,
  buildNodeOccupancyRects,
} from '@/features/canvas/utils/nodeOccupancy';
import { GROUP_HEADER_HEIGHT, GROUP_PADDING } from '@/features/canvas/services/groupGeometry';
import { getGroupMembers, isContainerCollapsed } from '@/features/canvas/services/groupMembership';
import {
  noteBatchTaskTerminal,
  registerBatchAcceptance,
  reopenBatchTaskForRequery,
} from './batchCompletion';
import { requestCanvasLocateToNode } from '@/features/canvas/services/canvasLocateRequest';
import {
  convertNotificationOutputs,
  convertRuntimeMediaAssetViewToProjectMediaAsset,
} from '@/features/canvas/hooks/taskIndex/mediaProjector';

/**
 * 任务节点 / 资产节点画布投影编排（Todo 6）。
 *
 * 职责边界（spec PromptDock生成主链.md / 固定任务数批次提交与投影语义.md）：
 * - 提交受理响应是创建任务节点投影的唯一触发事实，响应成功即确认任务已落库；
 * - task:state-changed / task:state-snapshot / media-assets:changed 只 O(1) 更新既有投影，
 *   绝不凭 taskId 创建节点；
 * - 终态：succeeded → 首个资产原位 morph、额外资产邻近落位；failed → 保留可重试/删除；
 *   cancel 命令 accepted → 立即移除任务节点；'cancelled' 终态通知对已移除投影幂等忽略；
 * - 「重新查询结果」的 failed → polling 复活（Spec docs/editor/失败任务重新查询-design.md）：
 *   同一任务节点原地清空失败事实与旧进度，不新建节点/批次；未收口批次撤销终态记账。
 * - 项目重开从持久化节点恢复合法 Task/Asset 投影，再用 storage read/snapshot 补全；
 *   绝不从 ResultArea slot 或 taskId 自动造节点。
 */

const normalizeTaskStatus = (raw: string | null | undefined): TaskNodeStatus | null => {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return null;
  switch (value) {
    case 'submitting':
    case 'generating':
    case 'polling':
    case 'downloading':
    case 'succeeded':
    case 'failed':
      return value;
    // TODO(acceptance: 待 Todo 4 契约就绪后移除兼容)：
    // contracts 当前 UNIFIED_GENERATION_STATUSES 尚无 'cancelled'；
    // 本地先兼容 'cancelled'/'canceled' 两种拼写，待 unified-generation 补 'cancelled' 后
    // 消费统一契约枚举并移除 'canceled' 兼容。
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
};

const readFailure = (task: RuntimeTaskView): RuntimeTaskFailure | null => {
  const failure = task.failure;
  if (failure !== null && failure !== undefined) return failure;
  if (task.errorMessage !== null && task.errorMessage !== undefined && task.errorMessage !== '') {
    return {
      code: task.errorCode ?? null,
      message: task.errorMessage,
      userMessage: null,
      backendMessage: null,
      retryable: null,
      details: null,
    };
  }
  return null;
};

const readErrorMessage = (task: RuntimeTaskView): string | null => {
  if (task.errorMessage) return task.errorMessage;
  const failure = task.failure;
  if (failure !== null && failure !== undefined) {
    return failure.userMessage ?? failure.message ?? failure.backendMessage ?? null;
  }
  return null;
};

/** 任务 metadata JSON 域读取字符串字段（不匹配返回空串，不做猜测）。 */
const readMetadataString = (metadata: unknown, key: string): string => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const value: unknown = Reflect.get(metadata, key);
  return typeof value === 'string' ? value : '';
};

const readMetadataPositiveInt = (metadata: unknown, key: string): number => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 0;
  const value: unknown = Reflect.get(metadata, key);
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const buildTaskNodeData = (params: {
  taskId: string;
  taskIndex: number;
  batchId: string;
  modelId: string;
  task: RuntimeTaskView | null;
}): TaskNodeData => {
  const now = Date.now();
  const status = params.task ? normalizeTaskStatus(params.task.status) : null;
  return {
    label: params.modelId || '任务',
    modelId: params.modelId,
    taskId: params.taskId,
    taskIndex: params.taskIndex,
    batchId: params.batchId,
    status: status ?? 'submitting',
    progressPercent: params.task?.progressPercent ?? null,
    progressPhase: params.task?.progressPhase ?? null,
    errorMessage: params.task ? readErrorMessage(params.task) : null,
    failure: params.task ? readFailure(params.task) : null,
    remoteRequestId: params.task?.remoteRequestId ?? null,
    requeryCount: params.task ? readMetadataPositiveInt(params.task.metadata, 'requeryCount') : 0,
    createdAt: params.task?.createdAt ?? now,
    updatedAt: params.task?.updatedAt ?? now,
  };
};

const findTaskNodeByTaskId = (graphId: string | undefined, taskId: string): GraphNode<TaskNodeData> | null => {
  if (!graphId) return null;
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!graph || graph.id !== graphId) return null;
  const node = graph.nodes.find((n) => n.type === 'task' && (n.data as TaskNodeData).taskId === taskId);
  return node ? (node as GraphNode<TaskNodeData>) : null;
};

const findAssetNodeByTaskId = (graphId: string | undefined, taskId: string): GraphNode<AssetNodeData> | null => {
  if (!graphId) return null;
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!graph || graph.id !== graphId) return null;
  const node = graph.nodes.find((n) => n.type === 'asset' && (n.data as AssetNodeData).sourceTaskId === taskId);
  return node ? (node as GraphNode<AssetNodeData>) : null;
};

/** 扩图等加工任务绑定的资产节点（加工作用于资产：无 task 节点投影，outpaintTaskId 锚定）。 */
const findOutpaintAssetNode = (graphId: string | undefined, taskId: string): GraphNode<AssetNodeData> | null => {
  if (!graphId) return null;
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!graph || graph.id !== graphId) return null;
  const node = graph.nodes.find(
    (n) => n.type === 'asset' && (n.data as AssetNodeData).outpaintTaskId === taskId,
  );
  return node ? (node as GraphNode<AssetNodeData>) : null;
};

const buildAssetNodeData = (params: {
  batchId: string;
  taskId: string;
  modelId: string;
  mediaType: AssetNodeData['mediaType'];
  assetId: string;
}): AssetNodeData => ({
  label: params.modelId || '素材',
  sourceBatchId: params.batchId,
  sourceTaskId: params.taskId,
  sourceModelId: params.modelId,
  mediaType: params.mediaType,
  assetId: params.assetId,
});

/**
 * 新建资产节点的期望布局尺寸（morph 期网格排布用）。
 *
 * 与 Layout Model 同一策略源（computeMediaDisplaySize，spec：画布节点尺寸管理架构.md
 * 「媒体节点比例一致性」）：image/video 按媒体 meta 等比钳制（长边 ≤ 320），asset chrome
 * 为 {0,0}（媒体满幅面，chromeConstants.ts）；meta 缺失或 audio 占位壳回落注册表默认尺寸。
 * 落位期用期望尺寸而非默认尺寸：默认 240×180 小于媒体实宽时，按默认步距排布会让
 * 相邻产物互相压叠。
 */
const expectedAssetLayoutSize = (params: {
  mediaType: AssetNodeData['mediaType'];
  media: RuntimeMediaAssetView | null | undefined;
}): NodeSize => {
  const fallback = ASSET_NODE_DEFAULT_SIZE;
  if (params.mediaType !== 'image' && params.mediaType !== 'video') return fallback;
  const original = params.media?.original;
  const width = original?.width;
  const height = original?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return fallback;
  }
  const defaultAspectRatio = params.mediaType === 'image' ? 3 / 2 : 16 / 9;
  const display = computeMediaDisplaySize(
    { width, height, aspectRatio: width / height },
    defaultAspectRatio,
  );
  return display ?? fallback;
};

/**
 * 把一次成功通知/快照中的正式资产输出物化为 AssetNodeData 列表。
 * 返回 null 表示无正式媒体资产（文本输出不物化为资产节点）。
 */
const buildAssetsFromOutputs = (params: {
  batchId: string | null | undefined;
  taskId: string;
  modelId: string;
  outputs: ReturnType<typeof convertNotificationOutputs>;
}): AssetNodeData[] => {
  const assets: AssetNodeData[] = [];
  for (const output of params.outputs) {
    const entry = output.entry;
    if (entry.mediaType === 'text' || entry.mediaType === undefined) continue;
    const assetId = typeof entry.assetId === 'string' ? entry.assetId : null;
    if (!assetId) continue;
    assets.push(
      buildAssetNodeData({
        batchId: params.batchId ?? '',
        taskId: params.taskId,
        modelId: params.modelId,
        mediaType: entry.mediaType,
        assetId,
      }),
    );
  }
  return assets;
};

/** 把运行域媒体资产合并进画布媒体资产注册表（只写 patch，同源构建）。 */
const mergeRuntimeMediaAssets = (mediaAssets: RuntimeMediaAssetView[]): void => {
  const state = useCanvasStore.getState();
  const patch: Record<string, MediaAsset> = {};
  let changed = false;
  for (const row of mediaAssets) {
    const converted = convertRuntimeMediaAssetViewToProjectMediaAsset(row);
    if (converted && converted.id) {
      patch[converted.id] = converted;
      changed = true;
    }
  }
  if (changed) {
    state.setProjectMediaAssets(patch, { source: 'backend-projection' });
  }
};

/** 批量任务节点网格每行个数（与落位搜索共用的呈现口径）。 */
const TASK_PROJECTION_PER_ROW = 3;

/**
 * 草稿引用资产 → 画布资产节点 position（保持引用顺序）。
 * 未命中的引用留痕后跳过：引用以 assetId 对应画布资产节点，对应不上不阻断落位。
 */
const collectReferenceNodePositions = (
  nodes: ReadonlyArray<GraphNode>,
  referenceAssetIds: ReadonlyArray<string>,
): NodePosition[] => {
  if (referenceAssetIds.length === 0) return [];
  const positions: NodePosition[] = [];
  for (const assetId of referenceAssetIds) {
    const node = nodes.find(
      (n) => n.type === 'asset' && (n.data as AssetNodeData).assetId === assetId,
    );
    if (node) {
      positions.push(node.position);
    } else {
      logCanvasDebugEvent('taskProjection:reference-node-missing', { assetId });
    }
  }
  return positions;
};

/**
 * 创建任务/资产节点投影（提交受理响应 → N 个任务节点）。
 *
 * 这是任务节点创建的唯一触发事实；后续通知/snapshot/storage read 只能更新既有投影。
 *
 * @param params.selectCreatedNodes 受理后是否选中新创建的任务节点（界面提交的第一时间用户
 *   反馈，默认 true）；程序化提交（CLI）传 false——落位照常（视口锚定）但不改画布选中态，
 *   用户可能正在选别的对象（spec docs/integrations/CLI与本地Agent集成.md §6.4：程序化提交
 *   不触发创作面 UI 状态，「与界面一致」指投影与落位语义，非 UI 反馈）。
 */
export const createTaskProjectionsForAcceptance = (params: {
  nodeGraphId: string | undefined;
  response: PromptDockBatchSubmitResponse;
  modelId: string;
  /** 草稿引用的资产 id（保持引用顺序），用于参考锚定落位 */
  referenceAssetIds?: ReadonlyArray<string>;
  selectCreatedNodes?: boolean | undefined;
  /**
   * 出生组节点标识（spec CLI-043，CLI --group 程序化提交）：任务节点创建即写入该组归属
   * （addNode membership 通道，AG-CT-001 同款机制接口），落位锚点改为组内锚定。缺省
   * （界面提交 / 未指定 --group）保持视口锚定与自由节点语义。
   */
  birthGroupId?: string | undefined;
}): { ok: true } | { ok: false; reason: string } => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!params.nodeGraphId || !graph || graph.id !== params.nodeGraphId) {
    return { ok: false, reason: '画布还没准备好，任务没能添加上，请重试。' };
  }

  const tasks = params.response.tasks;
  // 批次收口台账登记（batchCompletion.ts）：终态通知链路据此检测「全部任务终态」触发整块重排。
  registerBatchAcceptance(
    params.response.batch_id,
    tasks.map((acceptance) => ({ taskId: acceptance.task_id, taskIndex: acceptance.task_index })),
  );

  // 出生组锚定（spec CLI-043）：--group 指定时落位锚点改为组内——组内有成员以成员包围盒
  // 下缘为续排起点（每行 3 网格、批内网格步距与批次一致），空组以组头卡片下缘为起点；参考
  // 资产右侧锚点被组内锚定覆盖；目标组自身派生包围盒不计为障碍（批次要扩展它），其他容器
  // 包围盒照常计为障碍（excludeNodeIds 通道）。锚点是块原点首选位，整批落位仍经批次1 的
  // 安全区→可见区→无界防重叠搜索引擎定位（安全区内离锚点最近的空闲位胜出）。出生组在提交
  // 期间被删除属防御分支：退回默认视口锚定且不建立成员关系（addNode 不传 membership，机制层
  // debug 留痕），不因缺锚点丢失投影。
  let effectiveBirthGroupId: string | null = null;
  let birthAnchor: NodePosition | undefined;
  if (params.birthGroupId !== undefined) {
    const groupNode = graph.nodes.find(
      (node) => node.id === params.birthGroupId && node.type === 'group',
    );
    if (groupNode === undefined) {
      console.debug('[taskProjection] birth group missing at projection time, fallback placement', {
        birthGroupId: params.birthGroupId,
      });
    } else {
      effectiveBirthGroupId = groupNode.id;
      const members = getGroupMembers(graph, groupNode.id);
      if (members.length > 0) {
        // 成员包围盒下缘：成员真实有效尺寸（resolveEffectiveSize 主链，与占位/派生同链）。
        const sizeSources = buildCanvasSizeSources(state);
        let minX = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const member of members) {
          if (member.position.x < minX) minX = member.position.x;
          const bottom = member.position.y + resolveEffectiveSize(member, sizeSources).height;
          if (bottom > maxY) maxY = bottom;
        }
        birthAnchor = Number.isFinite(minX) && Number.isFinite(maxY)
          ? { x: minX, y: maxY }
          : undefined;
      } else {
        birthAnchor = {
          x: groupNode.position.x,
          y: groupNode.position.y + GROUP_HEADER_HEIGHT + GROUP_PADDING.top,
        };
      }
    }
  }

  // 视口锚定落位（spec：PromptDock生成主链.md「终态画布投影」）：
  // 安全区 → 可见区 → 无界平面，防重叠是硬约束（不存在允许重叠的兜底）；锚点优先参考资产右侧邻近。
  // 既有节点占位按真实有效尺寸解析，容器按派生包围盒整体占位（nodeOccupancy.ts）。
  const referencePositions = collectReferenceNodePositions(
    graph.nodes,
    params.referenceAssetIds ?? [],
  );
  const placement = computeTaskBatchPlacement({
    viewport: normalizeViewport(graph.viewport),
    containerSize: state.ui.canvasContainerSize,
    nodes: graph.nodes,
    count: tasks.length,
    nodeSize: TASK_NODE_DEFAULT_SIZE,
    perRow: TASK_PROJECTION_PER_ROW,
    referencePositions: effectiveBirthGroupId !== null ? [] : referencePositions,
    sizeSources: buildCanvasSizeSources(state),
    ...(birthAnchor !== undefined ? { anchorOverride: birthAnchor } : {}),
    ...(effectiveBirthGroupId !== null ? { excludeNodeIds: new Set([effectiveBirthGroupId]) } : {}),
  });
  logCanvasDebugEvent('taskProjection:batch-placement', {
    mode: placement.mode,
    containerFallback: placement.containerFallback,
    referenceCount: referencePositions.length,
    taskCount: tasks.length,
    base: placement.base,
    birthGroupId: effectiveBirthGroupId,
  });

  const columnWidth = TASK_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X;
  const rowHeight = TASK_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y;

  const added: string[] = [];
  for (const acceptance of tasks) {
    const index = acceptance.task_index >= 0 ? acceptance.task_index : added.length;
    const col = index % TASK_PROJECTION_PER_ROW;
    const row = Math.floor(index / TASK_PROJECTION_PER_ROW);
    const node = state.addNode(
      'task',
      { x: placement.base.x + col * columnWidth, y: placement.base.y + row * rowHeight },
      buildTaskNodeData({
        taskId: acceptance.task_id,
        taskIndex: index,
        batchId: params.response.batch_id,
        modelId: params.modelId,
        task: null,
      }),
      // 创建即入出生组（AG-CT-001 同款机制接口，成员关系与创建同一历史）：目标缺失/资格
      // 不符时机制层回退自由节点并留痕，此处不重复校验。
      effectiveBirthGroupId !== null ? { groupId: effectiveBirthGroupId } : undefined,
    );
    if (node) added.push(node.id);
  }

  // 创建后选中新任务节点：提交的第一时间用户反馈；节点由构造保证在视口内，不移动视口。
  // 程序化提交（selectCreatedNodes: false）不做选中反馈：不改画布选中态（用户可能正在选别的对象）。
  if (added.length > 0 && params.selectCreatedNodes !== false) {
    state.projectSelectionContract({
      selectedNodeIds: added,
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
  }

  // 远处出生可发现：整批矩形与可见区完全不相交（拥挤画布搜索走到远处）时给一条可点击的
  // 定位提示（sonner toast 既有载体 + 定位请求事件桥接到统一定位抽象，canvasLocateRequest.ts）。
  const firstAddedNode =
    added.length > 0
      ? (useCanvasStore.getState().nodeGraph?.nodes.find((node) => node.id === added[0]) ?? null)
      : null;
  if (
    firstAddedNode !== null &&
    !rectsIntersect(placement.batchBounds, placement.visibleBounds)
  ) {
    logCanvasDebugEvent('taskProjection:batch-placement-offscreen', {
      batchBounds: placement.batchBounds,
      visibleBounds: placement.visibleBounds,
    });
    toast('生成任务落在了当前视野外', {
      action: {
        label: '查看',
        onClick: () => {
          requestCanvasLocateToNode({
            nodeId: firstAddedNode.id,
            reason: 'task-batch-offscreen-toast',
          });
        },
      },
      duration: 8000,
    });
  }

  if (added.length !== tasks.length) {
    return { ok: false, reason: '任务已经开始，但有一部分没能显示在画布上，请重新打开项目查看。' };
  }
  return { ok: true };
};

/**
 * O(1) 更新一个既有任务投影（task:state-changed / snapshot 共用）。
 * 绝不凭 taskId 创建节点；找不到即留痕跳过（条件跳过必须留痕，AGENTS.md）。
 */
const applyTaskRowToProjection = (
  graphId: string,
  task: RuntimeTaskView,
  outputs: RuntimeTaskOutputView[],
  mediaAssets: RuntimeMediaAssetView[],
): void => {
  const status = normalizeTaskStatus(task.status);
  const taskNode = findTaskNodeByTaskId(graphId, task.taskId);
  const assetNode = findAssetNodeByTaskId(graphId, task.taskId);

  if (status === 'cancelled') {
    // 'cancelled' 终态通知：取消命令被接受时投影已立即移除；晚到通知幂等忽略。
    // 若仍有残留 task 节点（如恢复竞态），在此兜底移除，绝不生成资产。
    if (taskNode) {
      useCanvasStore.getState().removeNode(taskNode.id, { deleteGroupMembers: false });
      console.debug('[taskProjection] cancelled terminal: removed late task projection', { taskId: task.taskId });
    } else {
      // 扩图取消：产出占位节点是派生副本，移除之（源资产不受影响，非破坏）。
      const outpaintNode = findOutpaintAssetNode(graphId, task.taskId);
      if (outpaintNode) {
        useCanvasStore.getState().removeNode(outpaintNode.id, { deleteGroupMembers: false });
        toast.error('扩图已取消');
      } else if (!assetNode) {
        console.debug('[taskProjection] cancelled terminal ignored (projection already removed)', { taskId: task.taskId });
      }
    }
    return;
  }

  if (!taskNode) {
    // 加工作用于资产（扩图）：无 task 节点投影，结果直接回填持有 outpaintTaskId 的资产节点
    //（spec 媒体工具加工「加工是资产上的动作」；设计层 node-chrome 顶栏扩图入口）。
    const outpaintNode = findOutpaintAssetNode(graphId, task.taskId);
    if (outpaintNode && status === 'succeeded') {
      const convertedOutputs = convertNotificationOutputs(outputs, mediaAssets);
      const firstImage = convertedOutputs.find(
        (o) => o.entry.mediaType === 'image' && typeof o.entry.assetId === 'string' && o.entry.assetId,
      );
      if (firstImage?.entry.assetId) {
        const assetId = firstImage.entry.assetId;
        const media = mediaAssets.find((m) => m.assetId === assetId) ?? null;
        applyOutpaintResultToAssetNode({
          nodeId: outpaintNode.id,
          resultAssetId: assetId,
          mediaAsset: media ? convertRuntimeMediaAssetViewToProjectMediaAsset(media) : null,
        });
        toast.success('扩图完成');
        return;
      }
      console.debug('[taskProjection] outpaint succeeded without image output (ignored)', {
        taskId: task.taskId,
      });
      return;
    }
    if (outpaintNode && status === 'failed') {
      // 加工失败：产出占位节点是派生副本，移除之（源资产不受影响，非破坏）。
      useCanvasStore.getState().removeNode(outpaintNode.id, { deleteGroupMembers: false });
      toast.error('扩图失败，生成的素材已移除');
      return;
    }
    // 合法路径：提交受理时创建的 task 节点必在（morph 后不存在）。snapshot 对已 morph 的
    // task 与已移除的投影是幂等 no-op；此处留 debug 痕迹不造节点。
    console.debug('[taskProjection] task row unmatched by node (no-op, no creation)', {
      taskId: task.taskId,
      status: task.status,
    });
    return;
  }

  if (status === 'succeeded') {
    // 成功终态：把正式媒体资产落位。输出与媒体随同一次通知/快照到达。
    morphSucceededTask(graphId, taskNode, task, outputs, mediaAssets);
    return;
  }

  // 「重新查询结果」复活：同一任务 failed → polling。失败事实与旧进度必须显式清空——
  // 不能用 `??` 继承旧值（轮询失败时后端把 progress.phase 置 null、不携带 failure，
  // 继承会让新等待态继续显示上一条失败摘要/百分比）。批次台账只对未收口批次撤销终态记账。
  const isRequeryRevive = taskNode.data.status === 'failed' && status === 'polling';
  if (isRequeryRevive) {
    reopenBatchTaskForRequery({ batchId: task.batchId, taskId: task.taskId });
  }

  const nextData: TaskNodeData = {
    ...taskNode.data,
    status: status ?? taskNode.data.status,
    progressPercent: isRequeryRevive
      ? null
      : (task.progressPercent ?? taskNode.data.progressPercent),
    progressPhase: isRequeryRevive
      ? null
      : (task.progressPhase ?? taskNode.data.progressPhase),
    errorMessage: isRequeryRevive ? null : readErrorMessage(task),
    failure: isRequeryRevive ? null : readFailure(task),
    remoteRequestId: task.remoteRequestId ?? taskNode.data.remoteRequestId ?? null,
    requeryCount:
      readMetadataPositiveInt(task.metadata, 'requeryCount') ||
      taskNode.data.requeryCount ||
      0,
    updatedAt: task.updatedAt ?? Date.now(),
  };
  useCanvasStore.getState().updateNodeData(taskNode.id, nextData, 'promptdock-projection');
};

/** succeeded：首个资产原位继任（替换继任语义 AG-CN-017），额外资产按受理期网格步距落位。 */
const morphSucceededTask = (
  graphId: string,
  taskNode: GraphNode<TaskNodeData>,
  task: RuntimeTaskView,
  outputs: RuntimeTaskOutputView[],
  mediaAssets: RuntimeMediaAssetView[],
): void => {
  const convertedOutputs = convertNotificationOutputs(outputs, mediaAssets);
  const placements = buildAssetsFromOutputs({
    batchId: task.batchId,
    taskId: task.taskId,
    modelId: taskNode.data.modelId,
    outputs: convertedOutputs,
  });

  const store = useCanvasStore.getState();
  const graph = store.nodeGraph;
  if (!graph || graph.id !== graphId) return;

  // 无媒体资产：任务成功但无画布资产（如纯文本），任务节点移除而非长期保留
  //（spec：成功任务节点不得长期保留为任务节点）。
  if (placements.length === 0) {
    store.removeNode(taskNode.id, { deleteGroupMembers: false });
    console.debug('[taskProjection] succeeded task with no media asset: remove task node', {
      taskId: task.taskId,
    });
    return;
  }

  const origin = taskNode.position;
  // 原位替换（AG-CN-017 替换继任保持成员身份）：继任资产经 store.replaceNode 创建——
  // membership 默认继承任务节点的 groupId（组内任务节点的继任资产保持组员身份，容器
  // 不因替换变空；无组任务节点的继任资产为自由节点），绑定任务节点的注释改绑首个
  // 继任节点，一次替换 = 一条历史（undo 一步回到替换前）。
  // 首个资产固定原位（cell 0）；同任务追加资产不再无条件按默认尺寸网格步进，改以继任
  // 原点为锚做防重叠搜索整块落位。格子按媒体期望布局尺寸（与 Layout Model 同一策略源
  // computeMediaDisplaySize，asset chrome {0,0}）取列最大宽/行最大高——默认 240×180 小于
  // 媒体实宽时会产出相邻产物互相压叠，按真实期望尺寸排布消除。锚点空闲时与网格口径自然一致。
  const sizeSources = buildCanvasSizeSources(store);
  const mediaByAssetId = new Map<string, RuntimeMediaAssetView>();
  for (const media of mediaAssets) {
    mediaByAssetId.set(media.assetId, media);
  }
  const expectedSizes = placements.map((data) =>
    expectedAssetLayoutSize({
      mediaType: data.mediaType,
      media: mediaByAssetId.get(data.assetId) ?? null,
    }),
  );
  const { cells } = computeGridCellsForSizes(
    expectedSizes,
    TASK_PROJECTION_PER_ROW,
    TASK_BATCH_GAP_X,
    TASK_BATCH_GAP_Y,
  );
  const columnWidth = ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X;
  const rowHeight = ASSET_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y;
  // 追加资产（cell 1..n-1）作为可移动块：搜索锚点为追加块的相对网格原点
  const extraCells = cells.slice(1);
  let extraBlockOrigin: NodePosition | null = null;
  if (extraCells.length > 0) {
    const extraMinDx = Math.min(...extraCells.map((cell) => cell.dx));
    const extraMinDy = Math.min(...extraCells.map((cell) => cell.dy));
    // 障碍：画布既有内容真实占位 − 被替换的任务节点（其矩形由 cell 0 继任）＋ cell 0 本身；
    // 追加资产将继任任务节点的容器成员身份，目标容器自己的派生包围盒不算障碍（容器随成员生长）。
    const excludeNodeIds = new Set<string>([taskNode.id]);
    if (typeof taskNode.groupId === 'string' && taskNode.groupId.length > 0) {
      const container = graph.nodes.find(
        (node) => node.id === taskNode.groupId && (node.type === 'group' || node.type === 'agent'),
      );
      if (container !== undefined && !isContainerCollapsed(container)) {
        excludeNodeIds.add(container.id);
      }
    }
    const occupancy = buildNodeOccupancyRects(graph.nodes, sizeSources, { excludeNodeIds });
    const firstCell = cells[0];
    if (firstCell) {
      occupancy.push({
        x: origin.x,
        y: origin.y,
        width: firstCell.width,
        height: firstCell.height,
      });
    }
    const found = searchFreeBlockPosition({
      occupancy,
      anchor: { x: origin.x + extraMinDx, y: origin.y + extraMinDy },
      cells: extraCells.map((cell) => ({
        ...cell,
        dx: cell.dx - extraMinDx,
        dy: cell.dy - extraMinDy,
      })),
      stepX: columnWidth,
      stepY: rowHeight,
      target: null,
    });
    if (found !== null) {
      extraBlockOrigin = { x: found.x, y: found.y };
    }
    // found === null 属防御分支（理论不可达：无界搜索超限已在 search 内抛内部断言）；
    // 此时 extraBlockOrigin 保持 null，追加资产退回相对网格位（最小退化，不出现在正常路径）。
  }
  const extraMinDx = extraCells.length > 0 ? Math.min(...extraCells.map((cell) => cell.dx)) : 0;
  const extraMinDy = extraCells.length > 0 ? Math.min(...extraCells.map((cell) => cell.dy)) : 0;
  const extrasBase = extraBlockOrigin ?? { x: origin.x + extraMinDx, y: origin.y + extraMinDy };
  store.replaceNode(
    taskNode.id,
    placements.map((data, i) => {
      const cell = cells[i];
      if (i === 0 || !cell) {
        return { key: 'asset', position: { x: origin.x, y: origin.y }, data };
      }
      return {
        key: 'asset',
        position: { x: extrasBase.x + (cell.dx - extraMinDx), y: extrasBase.y + (cell.dy - extraMinDy) },
        data,
      };
    }),
  );
};

/**
 * agent 派生任务成功的产物资产落位（spec docs/agent/04「血缘与画布投影」、
 * docs/agent/02「产物资产节点与血缘归属」）。
 *
 * 与任务链路的差异只有两点（其余复用同一批抽象）：
 * - 锚点来源：所属 Agent 节点（血缘 agentSessionId → 画布 agent 节点），而非任务节点；
 *   产物锚定该节点周围聚拢，同一会话的连续产物以它为锚点，不逐次落回安全区中心；
 * - 无任务节点可 morph：落位全部走 computeTaskBatchPlacement + 网格步距追加
 *   （与任务批量落位同一引擎），首个产物落在锚点旁第一个空闲位而不是覆盖宿主节点。
 *
 * 不变量：
 * - 不移动视口（纯计算落位，只 addNode）；
 * - 产物自动包含（默认初值，spec 02 AG-CT-001）：锚点存在时 addNode 携带
 *   membership（groupId 指向该 Agent 节点），创建即入容器、与创建同一历史；
 *   成员关系是空间组织归属，用户可拖入/拖出改写，与血缘两层互不代言；
 * - 所属 Agent 节点不存在（已删除 / 恢复后尚未重建）时退回默认落位（安全区优先、
 *   网格步距防重叠），不建立成员关系（addNode 不传 membership，机制层 debug 留痕），
 *   不因缺锚点丢失产物。
 */
const projectAgentDerivedSucceededAssets = (params: {
  graphId: string;
  task: RuntimeTaskView;
  lineage: AgentTaskLineage;
  outputs: RuntimeTaskOutputView[];
  mediaAssets: RuntimeMediaAssetView[];
}): void => {
  if (normalizeTaskStatus(params.task.status) !== 'succeeded') return;

  const convertedOutputs = convertNotificationOutputs(params.outputs, params.mediaAssets);
  const placements = buildAssetsFromOutputs({
    batchId: params.task.batchId,
    taskId: params.task.taskId,
    modelId: readMetadataString(params.task.metadata, 'modelId'),
    outputs: convertedOutputs,
  });
  // 无媒体资产（纯文本产物）：不落画布节点，也无任务节点需要移除。
  if (placements.length === 0) {
    console.debug('[taskProjection] agent-derived task succeeded without media asset (no node)', {
      taskId: params.task.taskId,
    });
    return;
  }

  const store = useCanvasStore.getState();
  const graph = store.nodeGraph;
  if (!graph || graph.id !== params.graphId) return;

  const agentNode = findAgentNodeBySessionId(params.lineage.agentSessionId);
  if (!agentNode) {
    // 缺锚点：退回默认落位（安全区优先），条件跳过必须留痕（AGENTS.md）；
    // 同时不建立成员关系（membership 不传，spec 02 AG-NP-002「退回默认落位」）。
    console.debug('[taskProjection] agent-derived product anchor missing, fallback placement', {
      taskId: params.task.taskId,
      agentSessionId: params.lineage.agentSessionId,
    });
  }

  const placement = computeTaskBatchPlacement({
    viewport: normalizeViewport(graph.viewport),
    containerSize: store.ui.canvasContainerSize,
    nodes: graph.nodes,
    count: placements.length,
    nodeSize: ASSET_NODE_DEFAULT_SIZE,
    perRow: TASK_PROJECTION_PER_ROW,
    referencePositions: agentNode ? [agentNode.position] : [],
    sizeSources: buildCanvasSizeSources(store),
  });
  logCanvasDebugEvent('taskProjection:agent-derived-assets-placement', {
    taskId: params.task.taskId,
    agentSessionId: params.lineage.agentSessionId,
    anchored: agentNode !== null,
    mode: placement.mode,
    containerFallback: placement.containerFallback,
    assetCount: placements.length,
    base: placement.base,
  });

  const columnWidth = ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X;
  const rowHeight = ASSET_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y;
  for (let i = 0; i < placements.length; i += 1) {
    const data = placements[i];
    if (data === undefined) continue;
    const col = i % TASK_PROJECTION_PER_ROW;
    const row = Math.floor(i / TASK_PROJECTION_PER_ROW);
    store.addNode(
      'asset',
      { x: placement.base.x + col * columnWidth, y: placement.base.y + row * rowHeight },
      data,
      // 产物自动包含（AG-CT-001 默认初值）：锚点存在即创建即入容器；无锚点不传
      // membership（机制层对非法目标回退自由节点 + debug 留痕，这里源头就不建立）。
      agentNode !== null ? { groupId: agentNode.id } : undefined,
    );
  }
};

/** task:state-changed 消费入口。 */
export const applyTaskStateChanged = (notification: TaskStateNotification): void => {
  const graphId = useCanvasStore.getState().nodeGraph?.id;
  if (!graphId) return;
  // 媒体资产合并进画布注册表（patch 同源构建）。
  mergeRuntimeMediaAssets(notification.mediaAssets);
  // agent 工具调用派生任务不落任务节点投影，成功终态把产物资产落为画布资产节点
  //（spec 04「血缘与画布投影」、spec 02「产物资产节点与血缘归属」）。
  const lineage = parseAgentTaskLineage(notification.task.metadata ?? null);
  if (lineage !== null) {
    projectAgentDerivedSucceededAssets({
      graphId,
      task: notification.task,
      lineage,
      outputs: notification.outputs,
      mediaAssets: notification.mediaAssets,
    });
    return;
  }
  applyTaskRowToProjection(
    graphId,
    notification.task,
    notification.outputs,
    notification.mediaAssets,
  );
  // 批次收口检测（batchCompletion.ts）：终态通知逐个记账，批次全部任务终态时触发一次
  // 整块重排。挂接在实时通知链路上，不做轮询；agent 派生任务不在批次台账内（上方分支已返回）。
  const terminalStatus = normalizeTaskStatus(notification.task.status);
  if (
    terminalStatus === 'succeeded' ||
    terminalStatus === 'failed' ||
    terminalStatus === 'cancelled'
  ) {
    noteBatchTaskTerminal({
      graphId,
      batchId: notification.task.batchId,
      taskId: notification.task.taskId,
    });
  }
};

/**
 * task:state-snapshot 消费入口（被动恢复/补全，只更新既有投影）。
 *
 * agent 派生任务在此不落产物节点：快照是恢复/补全来源，补落等于给存量历史产物造节点
 *（spec 04 AG-EX-002「存量产物不补落」）；live 成功终态才是产物落位的事实。
 */
export const applyTaskStateSnapshot = (snapshot: TaskStateSnapshot): void => {
  const state = useCanvasStore.getState();
  const graphId = state.nodeGraph?.id;
  if (!graphId) return;
  for (const task of snapshot.tasks) {
    const media = snapshot.mediaAssetsByTaskId[task.taskId] ?? [];
    mergeRuntimeMediaAssets(media);
    if (parseAgentTaskLineage(task.metadata ?? null) !== null) continue;
    applyTaskRowToProjection(graphId, task, snapshot.taskOutputsByTaskId[task.taskId] ?? [], media);
  }
};

/** media-assets:changed 消费入口（只更新既有投影与媒体注册表，绝不造节点）。 */
export const applyMediaAssetsChanged = (notification: MediaAssetsChangedNotification): void => {
  const state = useCanvasStore.getState();
  if (!state.nodeGraph) return;
  const patch: Record<string, MediaAsset> = {};
  let changed = false;
  for (const row of notification.mediaAssets) {
    const converted = convertRuntimeMediaAssetViewToProjectMediaAsset(row);
    if (converted && converted.id) {
      patch[converted.id] = converted;
      changed = true;
    }
  }
  if (changed) {
    state.setProjectMediaAssets(patch, { source: 'backend-notification' });
  }
};

/** 取消命令被接受 → 立即移除任务节点（取消后晚到通知幂等忽略）。 */
export const cancelTaskProjection = (taskId: string): void => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!graph) return;
  const taskNode = graph.nodes.find(
    (n): n is GraphNode<TaskNodeData> => n.type === 'task' && (n.data as TaskNodeData).taskId === taskId,
  );
  if (taskNode) {
    state.removeNode(taskNode.id, { deleteGroupMembers: false });
  }
};

/**
 * 项目重开恢复（loadNodeGraph 之后调用）。
 *
 * 从持久化节点恢复合法 Task/Asset 投影；不满足合法投影形状的旧节点（model/resultArea/slot）
 * 由 loadGraphNormalization 在打开阶段拒绝/剔除。本函数只做投影不变量补全：
 * 对 task 节点若无 batchId/modelId 等恢复所需字段，保持既有值（通知/快照到达后 O(1) 补全）。
 */
export const reconcilePersistedProjections = (): void => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (!graph) return;
  let touched = false;
  for (const node of graph.nodes) {
    if (node.type === 'task') {
      const data = node.data as TaskNodeData;
      if (typeof data.taskId !== 'string' || data.taskId.length === 0) {
        // 非法持久化任务节点：缺 taskId 无法匹配任何运行域任务 → 剔除。
        state.removeNode(node.id, { deleteGroupMembers: false });
        touched = true;
        console.debug('[taskProjection] reconcile removed task node without taskId', { nodeId: node.id });
      }
    } else if (node.type === 'asset') {
      const data = node.data as AssetNodeData;
      if (typeof data.assetId !== 'string' || data.assetId.length === 0) {
        state.removeNode(node.id, { deleteGroupMembers: false });
        touched = true;
        console.debug('[taskProjection] reconcile removed asset node without assetId', { nodeId: node.id });
      }
    }
  }
  if (touched) {
    console.debug('[taskProjection] reconcile completed');
  }
};

export type TaskProjectionService = {
  createTaskProjectionsForAcceptance: typeof createTaskProjectionsForAcceptance;
  applyTaskStateChanged: typeof applyTaskStateChanged;
  applyTaskStateSnapshot: typeof applyTaskStateSnapshot;
  applyMediaAssetsChanged: typeof applyMediaAssetsChanged;
  cancelTaskProjection: typeof cancelTaskProjection;
  reconcilePersistedProjections: typeof reconcilePersistedProjections;
};

export * from './birthGroup';
