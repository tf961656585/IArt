import type { GraphNodeData } from "../../types";

export type RuntimeLayoutNodeData = GraphNodeData & {
  sizeMode: unknown | undefined;
};

export const sanitizeRuntimeLayoutData = (
  data: (GraphNodeData & { sizeMode: unknown | undefined }) | GraphNodeData | null | undefined,
): GraphNodeData => {
  if (!data || typeof data !== "object") return {} as GraphNodeData;
  if (!Object.prototype.hasOwnProperty.call(data, "sizeMode")) return data;
  const layoutData = data as GraphNodeData & { sizeMode: unknown | undefined };
  const { sizeMode: _sizeMode, ...rest } = layoutData;
  return rest as GraphNodeData;
};

/**
 * 旧格式字段剥离（load 边界）。
 *
 * `data.resultAreaAutoLayoutState` 是旧「运行时持久化布局」通路的残留字段。
 * 单一求解收口后它无写回通路、无消费方（spec：画布节点尺寸管理架构.md「写入规则」——
 * 结构性实测回流是唯一测量回流通路）：load 边界直接剥离丢弃，不迁入任何 store 切片。
 * repair path 的 sanitizeModelNodeData 按字段白名单重建 data（不含本字段），
 * fast path 不经过 sanitizer，由本函数兜底剥离；两层共同保证旧字段不进内存事实源。
 */
