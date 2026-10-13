import type {
  DesiredSize,
  GraphNode,
  NodeSize,
} from "../types";
import { resolveEffectiveSize } from "../utils/effectiveSize";
import type { useCanvasStore } from "./canvasStore";
import { selectGraphNodeById } from "./selectors.base";

type RenderFallbackSizeByNodeIdCache = {
  graphId: string | null;
  dataRevision: number;
  layoutRevision: number;
  nodesRef: ReadonlyArray<GraphNode> | null;
  desiredSizeByNodeIdRef: Readonly<Record<string, DesiredSize>> | null;
  layoutModelByNodeIdRef: Readonly<Record<string, NodeSize>> | null;
  value: Record<string, NodeSize>;
};

const isSameNodeSize = (prev: NodeSize | null, next: NodeSize | null): boolean => {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  return prev.width === next.width && prev.height === next.height;
};

const renderFallbackSizeByNodeIdCache: RenderFallbackSizeByNodeIdCache = {
  graphId: null,
  dataRevision: -1,
  layoutRevision: -1,
  nodesRef: null,
  desiredSizeByNodeIdRef: null,
  layoutModelByNodeIdRef: null,
  value: {},
};

export const selectDesiredSizeByNodeId = (
  state: ReturnType<typeof useCanvasStore.getState>,
): Readonly<Record<string, DesiredSize>> => {
  return state.ui.desiredSizeByNodeId;
};

/**
 * 启动阶段镜像 selector（spec：画布启动性能与Layout-Model架构.md）。
 *
 * 真实事实源是 useCanvasPreparationController 内部的 PreparationState.phase，
 * controller 通过 setPreparationPhase action 把它同步进 store，供 desired producers /
 * commit gate / useFlowNodeActualSize 等 React 组件用单点订阅的方式拿到 phase。
 *
 * 返回 string 而非 PreparationPhase 联合类型，避免 store 内部对 canvas 屏蔽的
 * 依赖反向回流到 store 类型层（store.core 只持有 string 镜像）。消费方在需要严格
 * 类型时再本地做 string 字面量比较即可。
 */
export const selectPreparationPhase = (
  state: ReturnType<typeof useCanvasStore.getState>,
): string => {
  return state.preparationPhase;
};

/**
 * 判断当前是否处于「desired 反馈环应禁用」的启动期
 * （spec：画布启动性能与Layout-Model架构.md 启动期零反馈环）。
 *
 * 启动期范围：loading-project → connecting-sync → waiting-interactive。
 * runtime 期（ready）才允许 desired 写入 / commit gate 推进。
 * failed / awaiting-* / resolving-project 等态 desired producers 也不应推进，
 * 但不在本 helper 范围内（caller 仍可在外层做更细的判断）。
 */
export const isStartupPhaseForDesired = (phase: string): boolean => {
  return (
    phase === 'loading-project' ||
    phase === 'connecting-sync' ||
    phase === 'waiting-interactive'
  );
};

/**
 * Layout Model 节点尺寸 selector（spec：画布启动性能与Layout-Model架构.md）。
 *
 * Layout-Model-Driven 范式下节点尺寸的唯一业务事实源。
 * 由 canvasStore.layoutModelActions 在 hydrate 收敛后全量计算、在节点内容变化时增量重算。
 *
 * desired 的反馈环降级为 runtime 期单节点级漂移校准，不进入主优先级链。
 */
export const selectLayoutModelByNodeId = (
  state: ReturnType<typeof useCanvasStore.getState>,
): Readonly<Record<string, NodeSize>> => {
  return state.ui.layoutModelByNodeId;
};

// Store-side render fallback projection. This is not the ReactFlow actual size truth.
export const selectStoreRenderFallbackSizeByNodeId = (
  state: ReturnType<typeof useCanvasStore.getState>,
): Record<string, NodeSize> => {
  const graph = state.nodeGraph;
  const nodes = (graph !== null && graph !== undefined ? graph.nodes : undefined) ?? null;
  if (!graph) {
    if (renderFallbackSizeByNodeIdCache.graphId !== null) {
      renderFallbackSizeByNodeIdCache.graphId = null;
      renderFallbackSizeByNodeIdCache.dataRevision = -1;
      renderFallbackSizeByNodeIdCache.layoutRevision = -1;
      renderFallbackSizeByNodeIdCache.nodesRef = null;
      renderFallbackSizeByNodeIdCache.desiredSizeByNodeIdRef = null;
      renderFallbackSizeByNodeIdCache.layoutModelByNodeIdRef = null;
      renderFallbackSizeByNodeIdCache.value = {};
    }
    return renderFallbackSizeByNodeIdCache.value;
  }

  if (!nodes) {
    return renderFallbackSizeByNodeIdCache.value;
  }

  const desiredSizeByNodeId = selectDesiredSizeByNodeId(state);
  const layoutModelByNodeId = selectLayoutModelByNodeId(state);

  if (
    renderFallbackSizeByNodeIdCache.graphId === graph.id &&
    renderFallbackSizeByNodeIdCache.dataRevision === state.dataRevision &&
    renderFallbackSizeByNodeIdCache.layoutRevision === state.layoutRevision &&
    renderFallbackSizeByNodeIdCache.nodesRef === nodes &&
    renderFallbackSizeByNodeIdCache.desiredSizeByNodeIdRef === desiredSizeByNodeId &&
    renderFallbackSizeByNodeIdCache.layoutModelByNodeIdRef === layoutModelByNodeId
  ) {
    return renderFallbackSizeByNodeIdCache.value;
  }

  const canReusePerNode =
    renderFallbackSizeByNodeIdCache.graphId === graph.id &&
    renderFallbackSizeByNodeIdCache.dataRevision === state.dataRevision &&
    renderFallbackSizeByNodeIdCache.layoutRevision === state.layoutRevision &&
    renderFallbackSizeByNodeIdCache.nodesRef === nodes &&
    renderFallbackSizeByNodeIdCache.desiredSizeByNodeIdRef !== null &&
    renderFallbackSizeByNodeIdCache.layoutModelByNodeIdRef !== null;

  const prevValue = renderFallbackSizeByNodeIdCache.value;
  const prevDesiredSizeByNodeId =
    renderFallbackSizeByNodeIdCache.desiredSizeByNodeIdRef ?? {};
  const prevLayoutModelByNodeId =
    renderFallbackSizeByNodeIdCache.layoutModelByNodeIdRef ?? {};
  const next: Record<string, NodeSize> = {};
  let changed = !canReusePerNode;

  if (canReusePerNode) {
    for (const node of nodes) {
      const prevSize = prevValue[node.id];
      const prevDesired = prevDesiredSizeByNodeId[node.id];
      const currDesired = desiredSizeByNodeId[node.id];
      const prevLayoutModel = prevLayoutModelByNodeId[node.id];
      const currLayoutModel = layoutModelByNodeId[node.id];
      if (
        prevSize &&
        prevDesired === currDesired &&
        prevLayoutModel === currLayoutModel
      ) {
        next[node.id] = prevSize;
        continue;
      }

      const desiredSize = currDesired ?? undefined;
      const layoutModelSize = currLayoutModel ?? undefined;
      const nextSize = resolveEffectiveSize(node, {
        measuredByNodeId: undefined,
        desiredByNodeId: desiredSize !== undefined ? { [node.id]: desiredSize } : undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId: layoutModelSize !== undefined ? { [node.id]: layoutModelSize } : undefined,
      });
      next[node.id] = isSameNodeSize(prevSize ?? null, nextSize)
        ? (prevSize ?? nextSize)
        : nextSize;
      if (!prevSize || next[node.id] !== prevSize) {
        changed = true;
      }
    }
  } else {
    for (const node of nodes) {
      const prevSize = prevValue[node.id];
      const currDesired = desiredSizeByNodeId[node.id];
      const currLayoutModel = layoutModelByNodeId[node.id];
      const desiredSize = currDesired ?? undefined;
      const layoutModelSize = currLayoutModel ?? undefined;
      const nextSize = resolveEffectiveSize(node, {
        measuredByNodeId: undefined,
        desiredByNodeId: desiredSize !== undefined ? { [node.id]: desiredSize } : undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId: layoutModelSize !== undefined ? { [node.id]: layoutModelSize } : undefined,
      });
      next[node.id] = isSameNodeSize(prevSize ?? null, nextSize)
        ? (prevSize ?? nextSize)
        : nextSize;
    }
  }

  if (Object.keys(prevValue).length !== nodes.length) {
    changed = true;
  }

  renderFallbackSizeByNodeIdCache.graphId = graph.id;
  renderFallbackSizeByNodeIdCache.dataRevision = state.dataRevision;
  renderFallbackSizeByNodeIdCache.layoutRevision = state.layoutRevision;
  renderFallbackSizeByNodeIdCache.nodesRef = nodes;
  renderFallbackSizeByNodeIdCache.desiredSizeByNodeIdRef = desiredSizeByNodeId;
  renderFallbackSizeByNodeIdCache.layoutModelByNodeIdRef = layoutModelByNodeId;
  renderFallbackSizeByNodeIdCache.value = changed ? next : prevValue;
  return renderFallbackSizeByNodeIdCache.value;
};

// Store-side render fallback projection for one node. This is not the ReactFlow actual size truth.
export const selectStoreRenderFallbackSizeForNode = (nodeId: string) => {
  let cacheGraphId: string | null = null;
  let cacheStructureRevision = -1;
  let cacheLayoutRevision = -1;
  let cacheNodeRef: GraphNode | null = null;
  let cacheDesiredSize: DesiredSize | null = null;
  let cacheLayoutModelSize: NodeSize | null = null;
  let cacheValue: NodeSize | null = null;

  return (state: ReturnType<typeof useCanvasStore.getState>): NodeSize | null => {
    const graph = state.nodeGraph;
    if (!graph) {
      cacheGraphId = null;
      cacheStructureRevision = -1;
      cacheLayoutRevision = -1;
      cacheNodeRef = null;
      cacheDesiredSize = null;
      cacheLayoutModelSize = null;
      cacheValue = null;
      return cacheValue;
    }

    const node = selectGraphNodeById(nodeId)(state);
    const desiredEntry = state.ui.desiredSizeByNodeId[nodeId];
    const desired = desiredEntry ?? null;
    const layoutModelEntry = state.ui.layoutModelByNodeId[nodeId] ?? null;
    const sameRevision =
      cacheGraphId === graph.id &&
      cacheStructureRevision === state.dataRevision &&
      cacheLayoutRevision === state.layoutRevision &&
      cacheNodeRef === node &&
      cacheDesiredSize === desired &&
      cacheLayoutModelSize === layoutModelEntry;

    if (sameRevision) {
      return cacheValue;
    }

    cacheGraphId = graph.id;
    cacheStructureRevision = state.dataRevision;
    cacheLayoutRevision = state.layoutRevision;
    cacheNodeRef = node;
    cacheDesiredSize = desired;
    cacheLayoutModelSize = layoutModelEntry;
    const nextValue = resolveEffectiveSize(node, {
      measuredByNodeId: undefined,
      desiredByNodeId: desired !== null ? { [nodeId]: desired } : undefined,
      derivedByNodeId: undefined,
      defaultByNodeId: undefined,
      layoutModelByNodeId: layoutModelEntry !== null ? { [nodeId]: layoutModelEntry } : undefined,
    });

    if (isSameNodeSize(cacheValue, nextValue)) {
      return cacheValue;
    }

    cacheValue = nextValue;
    return cacheValue;
  };
};

/**
 * 占位壳节点的有效尺寸投影（spec：画布交互期渲染降级契约.md「占位壳契约」第 3 项）。
 *
 * 占位壳尺寸必须复用 resolveEffectiveSize 主优先级链：
 *   layoutModel > measured > default
 * 不能只用 lastMeasuredRef（仅 measured 一档）——新节点首次挂载无 measured 时会塌缩，
 * 违反 spec 禁止事项第 2 条「占位壳不得塌缩为零尺寸或小于 default」。
 * desired 收窄为 runtime 期漂移校准，不进入主优先级链
 * （spec：画布启动性能与Layout-Model架构.md）。
 *
 * measured 档的数据源是 store 的会话态缓存 lastMeasuredSizeByNodeId
 * （与 alignmentActions / layoutActions 调 resolveEffectiveSize 同模式），
 * 不是组件的 lastMeasuredRef（那是 DOM 实测，新节点首次挂载时为 null）。
 *
 * 返回 selector 工厂（与 selectStoreRenderFallbackSizeForNode 同模式），
 * 供节点组件用 useCanvasStore(selectEffectiveSizeForPlaceholder(nodeId)) 单节点作用域订阅。
 * 组件应仅在 isPlaceholder=true 时使用本 selector 的返回值作为 stableSize，
 * 完整态仍走原 lastMeasuredRef 路径。
 */
export const selectEffectiveSizeForPlaceholder = (nodeId: string) => {
  let cacheGraphId: string | null = null;
  let cacheStructureRevision = -1;
  let cacheLayoutRevision = -1;
  let cacheNodeRef: GraphNode | null = null;
  let cacheDesiredSize: DesiredSize | null = null;
  let cacheMeasuredSize: NodeSize | null = null;
  let cacheLayoutModelSize: NodeSize | null = null;
  let cacheValue: NodeSize | null = null;

  return (state: ReturnType<typeof useCanvasStore.getState>): NodeSize | null => {
    const graph = state.nodeGraph;
    if (!graph) {
      cacheGraphId = null;
      cacheStructureRevision = -1;
      cacheLayoutRevision = -1;
      cacheNodeRef = null;
      cacheDesiredSize = null;
      cacheMeasuredSize = null;
      cacheLayoutModelSize = null;
      cacheValue = null;
      return cacheValue;
    }

    const node = selectGraphNodeById(nodeId)(state);
    const desiredEntry = state.ui.desiredSizeByNodeId[nodeId];
    const desired = desiredEntry ?? null;
    const measuredEntry = state.ui.lastMeasuredSizeByNodeId[nodeId] ?? null;
    const layoutModelEntry = state.ui.layoutModelByNodeId[nodeId] ?? null;
    const sameRevision =
      cacheGraphId === graph.id &&
      cacheStructureRevision === state.dataRevision &&
      cacheLayoutRevision === state.layoutRevision &&
      cacheNodeRef === node &&
      cacheDesiredSize === desired &&
      cacheMeasuredSize === measuredEntry &&
      cacheLayoutModelSize === layoutModelEntry;

    if (sameRevision) {
      return cacheValue;
    }

    cacheGraphId = graph.id;
    cacheStructureRevision = state.dataRevision;
    cacheLayoutRevision = state.layoutRevision;
    cacheNodeRef = node;
    cacheDesiredSize = desired;
    cacheMeasuredSize = measuredEntry;
    cacheLayoutModelSize = layoutModelEntry;

    const measuredByNodeId =
      measuredEntry !== null ? { [nodeId]: measuredEntry } : undefined;
    const desiredByNodeId =
      desired !== null ? { [nodeId]: desired } : undefined;
    const layoutModelByNodeId =
      layoutModelEntry !== null ? { [nodeId]: layoutModelEntry } : undefined;

    const nextValue = resolveEffectiveSize(node, {
      measuredByNodeId,
      desiredByNodeId,
      derivedByNodeId: undefined,
      defaultByNodeId: undefined,
      layoutModelByNodeId,
    });

    if (isSameNodeSize(cacheValue, nextValue)) {
      return cacheValue;
    }

    cacheValue = nextValue;
    return cacheValue;
  };
};
