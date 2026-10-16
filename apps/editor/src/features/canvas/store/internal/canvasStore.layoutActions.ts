import { computeAutoLayout } from '../../layout/autoLayout';
import type { AutoLayoutResult } from '../../layout/autoLayoutTypes';
import { applyLayoutInputOrder } from '../../layout/layoutPrimitives';
import { bboxTopLeft } from '../../layout/containerArrangement';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import { DEFAULT_NODE_SIZE, resolveEffectiveSizeByNodeId } from '../../utils/effectiveSize';
import { buildNodeOccupancyRects } from '../../utils/nodeOccupancy';
import {
  searchFreeBlockPosition,
  type PlacementCell,
} from '../../utils/taskNodePlacement';
import type { NodePosition } from '../../types';
import { normalizeNodeGraphSettings, normalizeSnapGrid } from '../../types/nodeGraph';
import type { DesiredSize, NodeSize } from '../../types';
import { isContainerNode } from '../../services/groupMembership';
import { markNodesDirty } from './canvasStore.persistence';
import { type CanvasAutoLayoutStoreOptions, type CanvasStoreGet, type CanvasStoreSet, type NodeGraphActions } from './canvasStore.core';

/**
 * 把 store 内部的 desiredSizeByNodeId 投影为布局消费的 desired map（保留完整 entry 含 state）。
 *
 * desired 内部带 pending/accepted 两态，resolveEffectiveSize 按 state 分档处理
 * （pending 优先于 measured，accepted 让位于 measured）。投影必须保留 state，
 * 不得降级为 size-only map，否则 resolveEffectiveSize 无法区分两态。
 */
export const projectDesiredSizeMapForLayout = (
  desiredByNodeId: Record<string, DesiredSize>,
): Record<string, DesiredSize | undefined> => {
  const next: Record<string, DesiredSize | undefined> = {};
  for (const [nodeId, desired] of Object.entries(desiredByNodeId)) {
    next[nodeId] = desired;
  }
  return next;
};

/**
 * 组装布局消费的 EffectiveSizeSources。
 *
 * 全局整理参与节点含视口外节点，measured 实时值不可得；按 spec（画布自动布局算法.md
 * 「调用层尺寸可信度义务」）使用 store 的 measured 会话态缓存 lastMeasuredSizeByNodeId,
 * 让视口外但曾挂载过的节点拿到最近一次真实 measured。options 入参作为可选覆盖（兼容）。
 *
 * desired 来自 store desiredSizeByNodeId（携带 state），derived 来自 UI 传入的组节点派生尺寸。
 */
const buildLayoutSizeSources = (
  options: CanvasAutoLayoutStoreOptions | undefined,
  desiredByNodeId: Record<string, DesiredSize>,
  cachedMeasuredByNodeId: Readonly<Record<string, NodeSize>>,
): EffectiveSizeSources => {
  // 优先用 options 入参的实时 measured（容器内整理场景：节点在视口内，实时可得）；
  // 缺失时回退到 store 会话态缓存（全局整理场景：覆盖视口外节点）。
  const measured = options !== undefined && options.measuredSizeByNodeId !== undefined
    ? options.measuredSizeByNodeId
    : cachedMeasuredByNodeId;
  const derived = options !== undefined ? options.derivedSizeByNodeId : undefined;
  return {
    measuredByNodeId: measured,
    desiredByNodeId: projectDesiredSizeMapForLayout(desiredByNodeId),
    derivedByNodeId: derived,
    defaultByNodeId: undefined,
    layoutModelByNodeId: undefined,
  };
};

/** 等待下一动画帧（让 React + ReactFlow 完成 DOM 测量）。 */
const waitForFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/**
 * 等待 measured 会话态缓存收敛，或达到最大等待帧数。
 *
 * spec（画布自动布局算法.md「全局整理的预挂载测量」）：预挂载测量必须等待 measured 收敛
 * （ReactFlow dimensions change 回调稳定）后才进入算法调用，不得在 measured 未稳定时
 * 提前调用算法。
 *
 * 收敛判定 = 覆盖率 100% + 连续帧无变化：
 * - 覆盖率：全部 eligibleNodeIds 在 lastMeasuredSizeByNodeId 中有值。
 * - 稳定性：连续两帧任意节点 width/height 无变化（对比上一帧快照）。
 *
 * 只校验覆盖率会让大 gallery 节点用偏小中间态值进算法（content-visibility:auto 占位、
 * 图片 lazy load 未撑开），导致整理后重叠。稳定性校验确保算法等图片撑开后再算位置。
 *
 * 达到最大帧数仍不收敛（极少数慢加载场景）则强制进入算法，此时由 desired 强兜底
 * （runAutoLayoutSync 内矫正）接管，不阻塞用户。
 */
const waitForMeasuredConvergence = async (
  get: CanvasStoreGet,
  eligibleNodeIds: ReadonlySet<string>,
  maxFrames = 10,
): Promise<void> => {
  let prevSnapshot: Readonly<Record<string, NodeSize>> = {};
  let stableFrames = 0;
  const requiredStableFrames = 2;
  for (let i = 0; i < maxFrames; i += 1) {
    await waitForFrame();
    const measured = get().ui.lastMeasuredSizeByNodeId;
    let allCovered = true;
    let changedCount = 0;
    for (const id of eligibleNodeIds) {
      const cur = measured[id];
      if (cur === undefined) {
        allCovered = false;
        break;
      }
      const prev = prevSnapshot[id];
      if (prev === undefined || prev.width !== cur.width || prev.height !== cur.height) {
        changedCount += 1;
      }
    }
    if (allCovered && changedCount === 0) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }
    const coverage = allCovered ? '100%' : `${eligibleNodeIds.size - changedCount}/${eligibleNodeIds.size}`;
    console.debug(
      `[autoLayout][preMeasure] frame=${i} coverage=${coverage} changed=${changedCount} stable=${stableFrames}/${requiredStableFrames}`,
    );
    if (allCovered && stableFrames >= requiredStableFrames) return;
    prevSnapshot = measured;
  }
  // 达到最大帧数仍未收敛，留痕后强制进入（desired 强兜底接管）
  const finalMeasured = get().ui.lastMeasuredSizeByNodeId;
  const notConverged: string[] = [];
  for (const id of eligibleNodeIds) {
    const cur = finalMeasured[id];
    const prev = prevSnapshot[id];
    if (cur === undefined) {
      notConverged.push(`${id}(missing)`);
    } else if (prev === undefined || prev.width !== cur.width || prev.height !== cur.height) {
      notConverged.push(`${id}(${cur.width}x${cur.height})`);
    }
  }
  console.debug(
    `[autoLayout][preMeasure] maxFrames=${maxFrames} reached, forcing layout. notConverged=${notConverged.length} ids=${notConverged.join(',')}`,
  );
};

export const createCanvasLayoutActions = (
  set: CanvasStoreSet,
  get: CanvasStoreGet,
): Pick<NodeGraphActions, 'autoLayout' | 'autoLayoutWithPreMeasure'> => {
  /**
   * 执行全局整理核心逻辑（不含预挂载测量编排）。
   * 异步：ELK 布局引擎是异步的。
   */
  const runAutoLayoutAsync = async (
    options: CanvasAutoLayoutStoreOptions | undefined,
  ): Promise<(AutoLayoutResult & { changedCount: number }) | null> => {
    const { nodeGraph } = get();
    if (nodeGraph === null) return null;

    const normalizedSettings = normalizeNodeGraphSettings(nodeGraph.settings);

    // 全局整理作用域：仅自由的合法节点（AG-CN-009）。
    // 容器节点（组 | Agent 容器）与容器内成员（groupId!==undefined）不进入全局布局输入。
    // 容器 position 是派生量（由成员包围盒派生），且 ELK Layered 不支持固定位置节点，
    // 参与布局会被重排到与真实渲染位置无关的虚构位置，
    // 其派生高度会污染自由节点 y 位置，删除 position 后留下 y 空洞（spec：画布自动布局算法.md
    // 「组节点在布局中的地位」+ 画布节点组.md「整理作用域」）。
    // order 显式顺序（CLI --order 承载，spec CLI-030）：重排输入数组序；缺省不传时数组序
    // 即现状口径，默认排序行为不变。
    const layoutEligibleNodes = applyLayoutInputOrder(
      nodeGraph.nodes.filter(
        (n) =>
          !isContainerNode(n) && !(typeof n.groupId === 'string' && n.groupId.length > 0),
      ),
      options?.order,
    );

    const desiredByNodeId = get().ui.desiredSizeByNodeId;
    const layoutModelByNodeId = get().ui.layoutModelByNodeId;
    const baseSizeSources = buildLayoutSizeSources(
      options,
      desiredByNodeId,
      get().ui.lastMeasuredSizeByNodeId,
    );
    // Layout-Model-Driven：Layout Model 主导主优先级链（layoutModel > measured > default），
    // desired 收窄为 runtime 期漂移校准，不再作为 measured 不可信时的强兜底（spec：
    // 画布启动性能与Layout-Model架构.md「与画布自动布局算法.md 的关系」节明确
    // 「Layout Model 始终可得，不存在 desired 缺失场景」）。applyDesiredFallback 已下线。
    const sizeSources: EffectiveSizeSources = {
      ...baseSizeSources,
      layoutModelByNodeId,
    };
    const layoutOptions = {
      defaultNodeSize: undefined,
      snapGrid: normalizedSettings.snapGrid,
      sizeSources,
      // --columns 透传（spec §5.3「均映射列数语义」/ CLI-032）：缺省 undefined 时布局引擎
      // 单列垂直摆放（既有口径不变），给出时按网格分行摆放。
      columns: options?.columns,
    };

    const layoutResult = await computeAutoLayout(
      layoutEligibleNodes,
      layoutOptions,
    );

    const rawPositions = layoutResult.positions;
    if (!Object.keys(rawPositions).length) {
      return { ...layoutResult, changedCount: 0 };
    }

    // 锚点保持（与容器内整理同一包围盒口径，spec：画布节点组.md「自动布局协作」）：
    // 整理前参与自由节点整块包围盒左上角作为锚点。
    const beforeAnchor = bboxTopLeft(layoutEligibleNodes);

    // 容器几何约束（spec：画布自动布局算法.md「容器几何约束」）：整块经防重叠搜索求位，
    // 摆放输出不得与任何容器的实际占位相交——展开态容器按成员派生包围盒、折叠态按折叠
    // 卡片尺寸（nodeOccupancy 统一占位口径）。障碍 = 全部容器占位：自由节点整块将整体
    // 重摆（旧位置不构成障碍），容器成员占位被其容器包围盒覆盖（排除非容器节点后仅剩
    // 容器矩形，excludeNodeIds 机制复用 nodeOccupancy 既有口径）。
    const containerOccupancy = buildNodeOccupancyRects(
      nodeGraph.nodes,
      sizeSources,
      {
        excludeNodeIds: new Set(
          nodeGraph.nodes.filter((n) => !isContainerNode(n)).map((n) => n.id),
        ),
      },
    );

    // 整块格子：placeGridFlow 首格在原点，rawPositions 即相对块原点的偏移；
    // 尺寸与布局算法同源（同一 resolveEffectiveSizeByNodeId 输入，禁止第二份解析链）。
    const sizeByNodeId = resolveEffectiveSizeByNodeId(layoutEligibleNodes, sizeSources);
    const cells: PlacementCell[] = [];
    for (const node of layoutEligibleNodes) {
      const raw = rawPositions[node.id];
      if (!raw) continue;
      const size = sizeByNodeId[node.id] ?? DEFAULT_NODE_SIZE;
      cells.push({ dx: raw.x, dy: raw.y, width: size.width, height: size.height });
    }

    // 整块求位：以整理前锚点为首选位环形搜索（步距 = snapGrid，候选位保持网格节奏）。
    // 无容器冲突时 ring 0 即命中 → 块原点 = 整理前锚点（锚点保持精确成立，消除 CLI 路径
    // 整块甩到画布原点的问题）；冲突时落到最近可行位（按环序确定性搜索）。
    const snapGrid = normalizeSnapGrid(normalizedSettings.snapGrid);
    const blockOrigin = searchFreeBlockPosition({
      occupancy: containerOccupancy,
      anchor: beforeAnchor,
      cells,
      stepX: snapGrid[0],
      stepY: snapGrid[1],
      target: null,
    });
    // 无界目标搜索不返回 null（超限在其内部抛断言）；此处仅类型兜底，理论不可达。
    const resolvedBlockOrigin = blockOrigin ?? beforeAnchor;
    if (
      resolvedBlockOrigin.x !== beforeAnchor.x ||
      resolvedBlockOrigin.y !== beforeAnchor.y
    ) {
      console.debug('[autoLayout] free-node block displaced to avoid container occupancy', {
        beforeAnchor,
        blockOrigin: resolvedBlockOrigin,
        containers: containerOccupancy.length,
      });
    }

    const positions: Record<string, NodePosition> = {};
    for (const [nodeId, pos] of Object.entries(rawPositions)) {
      positions[nodeId] = {
        x: pos.x + resolvedBlockOrigin.x,
        y: pos.y + resolvedBlockOrigin.y,
      };
    }

    let touched = 0;
    const touchedNodeIds: string[] = [];
    set((state) => {
      if (state.nodeGraph === null) return;
      for (const node of state.nodeGraph.nodes) {
        // 容器节点 position 是派生量（由成员包围盒派生），不回写算法输出。
        if (isContainerNode(node)) continue;
        const nextPos = positions[node.id];
        if (nextPos) {
          node.position = nextPos;
          touched += 1;
          touchedNodeIds.push(node.id);
        }
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

    // 返回值携带补偿后的最终坐标（消费方只读 changedCount，positions 语义保持真实最终位）。
    return { ...layoutResult, positions, changedCount: touched };
  };

  return {
    autoLayout: (options) => runAutoLayoutAsync(options),

    /**
     * 带预挂载测量的全局整理（spec：画布自动布局算法.md「全局整理的预挂载测量」）。
     *
     * 编排流程：
     * 1. 设 preLayoutMeasuring=true，渲染层临时关闭节点虚拟化，让视口外从未挂载的节点挂载 DOM。
     * 2. 等待 measured 会话态缓存覆盖全部参与节点（或达到最大等待帧数）。
     * 3. 调用整理核心 runAutoLayoutAsync（此时用 lastMeasuredSizeByNodeId 作为 measured 来源，
     *    覆盖率已达标，sizeMap 接近真实渲染尺寸）。
     * 4. 清 preLayoutMeasuring=false，恢复正常虚拟化。
     *
     * 预挂载测量是全局整理的编排增强。
     */
    autoLayoutWithPreMeasure: async (options) => {
      const { nodeGraph } = get();
      if (nodeGraph === null) return null;

      // 收集参与整理的节点 id，用于校验 measured 覆盖率。
      // 作用域与 runAutoLayoutAsync 一致：仅自由的合法节点（非容器节点 + 非容器成员）。
      const eligibleNodeIds = new Set(
        nodeGraph.nodes
          .filter(
            (n) =>
              !isContainerNode(n) &&
              !(typeof n.groupId === 'string' && n.groupId.length > 0),
          )
          .map((n) => n.id),
      );

      set((state) => {
        state.ui.preLayoutMeasuring = true;
      });

      try {
        await waitForMeasuredConvergence(get, eligibleNodeIds);
        return runAutoLayoutAsync(options);
      } finally {
        set((state) => {
          state.ui.preLayoutMeasuring = false;
        });
      }
    },
  };
};
