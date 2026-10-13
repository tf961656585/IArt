import { computeAutoLayout } from '../../layout/autoLayout';
import type { AutoLayoutResult } from '../../layout/autoLayoutTypes';
import type { EffectiveSizeSources } from '../../utils/effectiveSize';
import { normalizeNodeGraphSettings } from '../../types/nodeGraph';
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
    const layoutEligibleNodes = nodeGraph.nodes.filter(
      (n) =>
        !isContainerNode(n) && !(typeof n.groupId === 'string' && n.groupId.length > 0),
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
    };

    const layoutResult = await computeAutoLayout(
      layoutEligibleNodes,
      layoutOptions,
    );

    const positions = layoutResult.positions;
    if (!Object.keys(positions).length) {
      return { ...layoutResult, changedCount: 0 };
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

    return { ...layoutResult, changedCount: touched };
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
