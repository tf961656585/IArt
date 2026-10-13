/**
 * 节点有效尺寸统一解析入口。
 *
 * 所有需要"节点当前占用空间"的非渲染消费者（布局、组派生、辅助几何等）
 * 必须通过本模块的 resolveEffectiveSize 解析，不得自行判断该读哪一类尺寸。
 *
 * 优先级链（spec：画布启动性能与Layout-Model架构.md「与现有 spec 的关系」节收口）：
 *   容器节点（组 | Agent 容器）→ derived 优先
 *   普通节点 → layoutModel > measured > default
 *
 * Layout-Model-Driven 范式下 Layout Model 是节点尺寸的唯一业务事实源，
 * desired 的反馈环降级为 runtime 期单节点级漂移校准，不进入主优先级链。
 *
 * measured 通过本入口封装提供给消费者——这是封装，不是禁令。
 */

import { nodeRegistry } from '../nodes/registry';
import type { DesiredSize, GraphNodeType, NodeSize } from '../types';

/**
 * 全局默认节点尺寸——全仓库唯一事实源。
 *
 * 禁止在其他文件复制同值字面量。所有需要默认尺寸兜底的位置必须引用本常量。
 */
export const DEFAULT_NODE_SIZE: NodeSize = { width: 220, height: 120 };

/**
 * 尺寸收敛容差——全仓库唯一事实源。
 *
 * 用于判断 measured 是否已收敛到 desired（actual 与 desired 的宽高差均不超过此值视为收敛）。
 * 禁止在其他文件硬编码容差值。
 */
export const SIZE_CONVERGENCE_EPSILON_PX = 1;

const normalizeOptionalSize = (size: NodeSize | null | undefined): NodeSize | undefined => {
  if (!size) return undefined;
  const width = Math.round(Number(size.width));
  const height = Math.round(Number(size.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
};

/**
 * 解析节点类型默认尺寸（注册表 defaultSize → 全局兜底）。
 */
export const resolveNodeTypeDefaultSize = (
  nodeType: GraphNodeType,
  fallback: NodeSize = DEFAULT_NODE_SIZE,
): NodeSize => {
  const directDefinition = nodeRegistry.get(nodeType);
  const fromDirectKey = normalizeOptionalSize(
    directDefinition !== null && directDefinition !== undefined ? directDefinition.defaultSize : undefined,
  );
  if (fromDirectKey) return fromDirectKey;

  const definitions = nodeRegistry.getAllDefinitions();
  for (const definition of definitions) {
    if (definition.type !== nodeType) continue;
    const normalized = normalizeOptionalSize(definition.defaultSize);
    if (normalized) return normalized;
  }

  return { ...fallback };
};

/** resolveEffectiveSize 的尺寸来源集合。 */
export type EffectiveSizeSources = {
  /** measured size 映射（ReactFlow DOM 实测）。视口外/未挂载节点无此值。 */
  measuredByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /**
   * desired size 映射（业务意图，携带 pending/accepted state）。
   *
   * runtime 期单节点级漂移校准输入；启动期为空，不进入主优先级链。
   * 保留完整 DesiredSize entry（含 state）供 runtime 期漂移监控降级路径消费。
   */
  desiredByNodeId: Readonly<Record<string, DesiredSize | undefined>> | undefined;
  /** derived size 映射（组节点由成员几何派生）。仅组节点使用。 */
  derivedByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /**
   * default size 兜底映射（按节点 id 提供的回退值）。
   * 缺失时回退到 resolveNodeTypeDefaultSize(nodeType) → DEFAULT_NODE_SIZE。
   */
  defaultByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /**
   * Layout Model 节点尺寸映射（spec：画布启动性能与Layout-Model架构.md）。
   *
   * Layout-Model-Driven 范式下节点尺寸的唯一业务事实源。优先级最高，主导主优先级链。
   * 由 canvasStore.layoutModelActions 在 hydrate 收敛后全量计算、按 nodeId 增量重算。
   *
   * 调用方必须提供本字段（spec：所有消费者必须传入 layoutModelByNodeId）。
   * 缺失时（runtime 漂移降级场景）回退到 measured → default 链路。
   */
  layoutModelByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
};

/** 从 byNodeId 映射中按 id 读取尺寸（显式空值检查，避免可选链）。 */
const readSizeById = (
  map: Readonly<Record<string, NodeSize | undefined>> | undefined,
  id: string,
): NodeSize | undefined => {
  if (map === null || map === undefined) return undefined;
  return map[id];
};

/**
 * 解析节点的有效尺寸。
 *
 * 优先级固定如下（spec：画布启动性能与Layout-Model架构.md「与现有 spec 的关系」节收口，
 * 与渲染投影层 buildProjectionSizeByNodeId 同口径）：
 *   1. 容器节点（type==='group' | 'agent'）→ derived（成员几何派生，buildGroupDerivedSize 产出）
 *   2. layoutModel —— Layout-Model-Driven 范式下节点尺寸的唯一业务事实源（主档）
 *   3. measured —— ReactFlow 已测量的真实尺寸（视口外节点无此值，回退 lastMeasured）
 *   4. default（按 id → 节点类型注册表 → 全局兜底）
 *
 * desired 不进入主优先级链（runtime 期漂移校准专用，由漂移监控触发单节点级降级）。
 *
 * Layout Model 始终可得（spec：画布自动布局算法.md「measured 中间态的 Layout Model 强兜底矫正」
 * 明确「Layout Model 始终可得，不存在 desired 缺失场景」）。
 *
 * 容器节点回退口径（组与 Agent 容器同构、差在回退目标）：
 * - 组：derived 缺失（成员未挂载等）时回退到节点类型注册表默认值——组尺寸只能由成员几何派生。
 * - Agent 容器：derived 缺失 = 无成员的单节点形态，回落主优先级链
 *   （layoutModel 恒为注册表 defaultSize 240×64，与既有静态尺寸路径同值）。
 */
export const resolveEffectiveSize = (
  node: { id: string; type: GraphNodeType } | null | undefined,
  sources: EffectiveSizeSources,
): NodeSize => {
  if (!node) {
    return { ...DEFAULT_NODE_SIZE };
  }

  // 容器节点：derived 优先（组 | Agent 容器同一解析入口，无 Agent 特例分支）
  if (node.type === 'group' || node.type === 'agent') {
    const derived = normalizeOptionalSize(readSizeById(sources.derivedByNodeId, node.id));
    if (derived) return derived;
    // 组不回退到 layoutModel/measured/default——组尺寸只能由成员几何派生
    if (node.type === 'group') {
      return resolveNodeTypeDefaultSize(node.type);
    }
    // Agent 容器（无派生 entry）继续走主优先级链（静态 240×64 路径）
  }

  // 普通节点：layoutModel → measured → default（desired 不进入主优先级链）
  const layoutModelSize = normalizeOptionalSize(readSizeById(sources.layoutModelByNodeId, node.id));
  if (layoutModelSize) return layoutModelSize;

  const measured = normalizeOptionalSize(readSizeById(sources.measuredByNodeId, node.id));
  if (measured) return measured;

  const explicitDefault = normalizeOptionalSize(readSizeById(sources.defaultByNodeId, node.id));
  if (explicitDefault) return explicitDefault;

  return resolveNodeTypeDefaultSize(node.type);
};

/**
 * 批量解析节点有效尺寸，产出 byNodeId 映射。
 *
 * 用于布局算法、组派生等需要全图尺寸快照的消费者。
 */
export const resolveEffectiveSizeByNodeId = (
  nodes: ReadonlyArray<{ id: string; type: GraphNodeType }>,
  sources: EffectiveSizeSources,
): Record<string, NodeSize> => {
  const next: Record<string, NodeSize> = {};
  for (const node of nodes) {
    next[node.id] = resolveEffectiveSize(node, sources);
  }
  return next;
};

/**
 * 判断 measured 是否已收敛到 target（用于 desired 的 pending→accepted 迁移判定）。
 *
 * 宽高差均在 SIZE_CONVERGENCE_EPSILON_PX 以内视为收敛。
 */
export const isSizeConverged = (
  measured: NodeSize | null | undefined,
  target: NodeSize,
): boolean => {
  if (!measured) return false;
  return (
    Math.abs(measured.width - target.width) <= SIZE_CONVERGENCE_EPSILON_PX &&
    Math.abs(measured.height - target.height) <= SIZE_CONVERGENCE_EPSILON_PX
  );
};
