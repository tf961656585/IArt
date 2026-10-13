/**
 * 画板节点自动布局入口。
 *
 * 画布无连线、无端口、无拓扑：布局是纯几何遍历，按传入顺序单列垂直摆放节点。
 * 算法是纯函数语义：输入节点集合、尺寸数据，输出每个节点的位置。
 * 算法本身不读写 store，不感知分组语义，不触发视口行为。
 *
 * 方向固定 LR（左→右），间距固定标准值（spec：画布自动布局算法.md「布局配置项」）。
 *
 * spec：docs/runtime/画布自动布局算法.md
 */

import type { GraphNode, NodeGraph, NodeSize, GraphNodeType } from '../types';
import { normalizeSnapGrid } from '../types/nodeGraph';
import type { EffectiveSizeSources } from '../utils/effectiveSize';
import { resolveEffectiveSizeByNodeId } from '../utils/effectiveSize';
import { computeLayoutWithElk } from './elkLayoutEngine';
import { DEFAULT_NODE_SIZE } from './layoutPrimitives';
import type { AutoLayoutOptions, AutoLayoutResult } from './autoLayoutTypes';
import { nodeRegistry } from '../nodes/registry';
import { logCanvasDebugEvent } from '../debug/canvasDebug';

export type { AutoLayoutOptions, AutoLayoutResult } from './autoLayoutTypes';

/**
 * 为全部节点构建 defaultByNodeId 映射（兜底尺寸注入）。
 * 当调用方传入 defaultNodeSize 时，用它填充所有节点的 default 档。
 */
const buildDefaultByNodeId = (
  defaultNodeSize: NodeSize,
  nodes: ReadonlyArray<GraphNode>,
): Record<string, NodeSize | undefined> => {
  const next: Record<string, NodeSize | undefined> = {};
  for (const node of nodes) {
    next[node.id] = defaultNodeSize;
  }
  return next;
};

/**
 * 把 defaultNodeSize 合并进既有的 defaultByNodeId：已有条目保留，缺失的用 defaultNodeSize 填充。
 */
const mergeDefaultByNodeId = (
  existing: Readonly<Record<string, NodeSize | undefined>> | undefined,
  defaultNodeSize: NodeSize,
  nodes: ReadonlyArray<GraphNode>,
): Record<string, NodeSize | undefined> => {
  const next: Record<string, NodeSize | undefined> = {};
  for (const node of nodes) {
    const existingSize = existing !== null && existing !== undefined ? existing[node.id] : undefined;
    next[node.id] = existingSize ?? defaultNodeSize;
  }
  return next;
};

const DEFAULT_AUTO_LAYOUT_OPTIONS: AutoLayoutOptions = {
  defaultNodeSize: undefined,
  snapGrid: undefined,
  sizeSources: undefined,
  columns: undefined,
};

/**
 * 计算自动布局。
 *
 * 尺寸必须经 resolveEffectiveSize 解析（spec 输入契约），算法内部不手拼回退链。
 * 调用方传入的 sizeSources 必须整份透传——Layout Model 是节点尺寸的唯一业务事实源，
 * 本层只允许注入 defaultNodeSize 兜底档，不得丢弃或改写调用方提供的来源档
 *（spec：画布节点尺寸管理架构.md「与画布自动布局算法.md 的关系」；画布自动布局算法.md
 * 「输入契约·调用层尺寸可信度义务」）。
 * 输入 nodes 不应含组节点（type==='group'）：组节点不参与位置布局计算，调用层在算法入口前
 * 过滤掉组节点（spec：画布自动布局算法.md「组节点在布局中的地位」）。
 *
 * columns 为本次排布列数：缺省时单列垂直摆放，调用层给出时按网格分行摆放
 *（spec：画布自动布局算法.md「网格摆放」）。
 *
 * @returns Promise（ELK 是异步引擎）
 */
export const computeAutoLayout = async (
  nodes: GraphNode[],
  options: AutoLayoutOptions = DEFAULT_AUTO_LAYOUT_OPTIONS,
): Promise<AutoLayoutResult> => {
  const snapGrid = normalizeSnapGrid(options.snapGrid);

  // 组装尺寸来源集合。defaultNodeSize 作为兜底，映射到 sizeSources.defaultByNodeId。
  const defaultNodeSize = options.defaultNodeSize;
  let sizeSources: EffectiveSizeSources;
  if (options.sizeSources) {
    sizeSources = defaultNodeSize
      ? {
          ...options.sizeSources,
          defaultByNodeId: mergeDefaultByNodeId(
            options.sizeSources.defaultByNodeId,
            defaultNodeSize,
            nodes,
          ),
        }
      : options.sizeSources;
  } else {
    sizeSources = {
      measuredByNodeId: undefined,
      desiredByNodeId: undefined,
      derivedByNodeId: undefined,
      defaultByNodeId: defaultNodeSize
        ? buildDefaultByNodeId(defaultNodeSize, nodes)
        : undefined,
      layoutModelByNodeId: undefined,
    };
  }

  if (nodes.length === 0) {
    return { positions: {} };
  }

  // 尺寸经统一解析入口解析（spec 输入契约：禁止算法内部手拼回退链）
  const sizeByNodeId = resolveEffectiveSizeByNodeId(nodes, sizeSources);
  const sizeMap = new Map<string, NodeSize>();
  for (const node of nodes) {
    const resolved = sizeByNodeId[node.id];
    sizeMap.set(node.id, resolved ?? DEFAULT_NODE_SIZE);
  }

  // dev 级可观测性留痕：记录回退到 default 的节点并区分原因分类
  //（spec：画布节点尺寸管理架构.md「可观测性」节）。
  logDefaultFallbackNodes(nodes, sizeSources);

  const positions = await computeLayoutWithElk(nodes, sizeMap, {
    snapGrid,
    columns: options.columns,
  });

  return {
    positions,
    // 画布无连线，缺省列数时按单列垂直摆放；字段保留供既有消费方（CanvasToolbar）读取。
  };
};

export const computeAutoLayoutForGraph = async (
  graph: NodeGraph,
  options: AutoLayoutOptions | undefined,
): Promise<AutoLayoutResult> =>
  computeAutoLayout(graph.nodes, {
    defaultNodeSize: options !== undefined ? options.defaultNodeSize : undefined,
    snapGrid: graph.settings !== undefined ? graph.settings.snapGrid : options !== undefined ? options.snapGrid : undefined,
    sizeSources: options !== undefined ? options.sizeSources : undefined,
    columns: options !== undefined ? options.columns : undefined,
  });

/**
 * 判定节点是否走了 default 回退，并区分原因分类。
 *
 * 原因分类（spec：画布节点尺寸管理架构.md「可观测性」节）：
 * - layoutModel 节点回退到 default = 异常，Layout Model 始终可得、不存在缺失场景（dev 级 warn 语义）
 * - dynamic 节点回退到 default = 疑似 producer 未触发（dev 级 warn 语义）
 * - static 节点回退到 default = 正常（dev 级 info 语义）
 *
 * 留痕经 canvasDebug 统一通道，不侵入 resolveEffectiveSize 纯函数。
 */
type DefaultFallbackReason =
  | 'layout-model-source-missing'
  | 'dynamic-producer-not-triggered'
  | 'static-normal';

const resolveNodeDefaultFallbackReason = (
  node: { id: string; type: GraphNodeType },
  sizeSources: EffectiveSizeSources,
): DefaultFallbackReason | null => {
  // 组节点用 derived，不走 default 链路，跳过。
  if (node.type === 'group') return null;

  // 命中 Layout Model 即不构成 default 回退：它是普通节点尺寸的唯一业务事实源，优先级最高
  //（spec：画布节点尺寸管理架构.md「与画布自动布局算法.md 的关系」）。
  const layoutModel = sizeSources.layoutModelByNodeId;
  const hasLayoutModel = layoutModel !== undefined && layoutModel[node.id] !== undefined;
  if (hasLayoutModel) return null;
  const measured = sizeSources.measuredByNodeId;
  const hasMeasured = measured !== undefined && measured[node.id] !== undefined;
  if (hasMeasured) return null;
  const desired = sizeSources.desiredByNodeId;
  const hasDesired = desired !== undefined && desired[node.id] !== undefined;
  if (hasDesired) return null;

  // 走了 default 回退，按 sizeStrategy 区分原因。
  const definition = nodeRegistry.get(node.type);
  const strategy = definition !== undefined ? definition.sizeStrategy : undefined;
  if (strategy !== undefined && strategy.mode === 'dynamic') {
    return 'dynamic-producer-not-triggered';
  }
  // 声明 layoutModel 的节点本就始终可得，回退到 default 属尺寸失真（真实渲染重叠的直接来源），
  // 不得再按 static-normal 静默归类。
  if (strategy !== undefined && strategy.mode === 'layoutModel') {
    return 'layout-model-source-missing';
  }
  return 'static-normal';
};

const logDefaultFallbackNodes = (
  nodes: ReadonlyArray<GraphNode>,
  sizeSources: EffectiveSizeSources,
): void => {
  const layoutModelFallback: string[] = [];
  const dynamicFallback: string[] = [];
  const staticFallback: string[] = [];
  for (const node of nodes) {
    const reason = resolveNodeDefaultFallbackReason(node, sizeSources);
    if (reason === null) continue;
    if (reason === 'layout-model-source-missing') {
      layoutModelFallback.push(node.id);
    } else if (reason === 'dynamic-producer-not-triggered') {
      dynamicFallback.push(node.id);
    } else {
      staticFallback.push(node.id);
    }
  }
  if (layoutModelFallback.length > 0) {
    logCanvasDebugEvent('auto-layout:default-fallback(layoutModel-missing)', {
      traceScope: 'autoLayout',
      phase: 'default-fallback',
      fallbackReason: 'layout-model-source-missing',
      nodeIds: layoutModelFallback,
      summary: `${layoutModelFallback.length} layoutModel node(s) fell back to default (layout model source missing)`,
    });
  }
  if (dynamicFallback.length > 0) {
    logCanvasDebugEvent('auto-layout:default-fallback(dynamic)', {
      traceScope: 'autoLayout',
      phase: 'default-fallback',
      fallbackReason: 'dynamic-producer-not-triggered',
      nodeIds: dynamicFallback,
      summary: `${dynamicFallback.length} dynamic node(s) fell back to default (producer not triggered)`,
    });
  }
  if (staticFallback.length > 0) {
    logCanvasDebugEvent('auto-layout:default-fallback(static)', {
      traceScope: 'autoLayout',
      phase: 'default-fallback',
      fallbackReason: 'static-normal',
      nodeIds: staticFallback,
      summary: `${staticFallback.length} static node(s) using default size (normal)`,
    });
  }
};
