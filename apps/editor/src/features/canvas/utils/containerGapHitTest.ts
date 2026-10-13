/**
 * 容器内空白（容器背板空隙）右键命中判定。
 *
 * 容器（组 | Agent 容器）的包裹层对指针穿透（nodeCanvasFlowProjection.ts
 * `CONTAINER_FLOW_NODE_STYLE`），pane 的 contextmenu 事件只会落在容器背板空隙或真空白上。
 * 本模块把「这次 pane 右键落在哪个容器的空白里」收敛为一个纯函数：
 * 输入画布 flow 坐标与容器几何列表，输出最内层命中容器（面积最小者优先，保证确定性）；
 * 未命中任何容器属正常路径（真空白），返回 null，不留日志。
 *
 * 几何来源是画布既有节点尺寸事实源：容器派生尺寸投影（groupDerivedSize.ts 的
 * `GroupDerivedEntry`，position + size），由接线方组装成本模块的几何条目；
 * 本模块不读运行时状态、不感知 React Flow。
 */

import type { NodePosition } from '../types';
import type { ContainerGapKind } from '../types/clipboard';

/** 容器几何条目（画布 flow 坐标系，左上角原点）。组与 Agent 容器同一形状，无特例。 */
export type ContainerGapGeometry = {
  /** 容器节点 id */
  containerNodeId: string;
  /** 容器种类 */
  containerKind: ContainerGapKind;
  /** 容器左上角 flow 坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 命中结果：最内层（面积最小）命中容器。 */
export type ContainerGapHit = {
  containerNodeId: string;
  containerKind: ContainerGapKind;
};

/**
 * 解析容器内空白命中。
 *
 * 命中规则：
 * - 点落在某容器矩形内（含边界）即命中；退化尺寸（宽或高 ≤ 0）不构成命中面。
 * - 多个容器矩形重叠（组 > Agent 容器两层嵌套的组内空隙）时取面积最小者
 *   （最内层容器）；面积相等时取列表中靠前的一个（输入顺序即确定性仲裁）。
 * - 列表为空或无命中返回 null。
 */
export const resolveContainerGapHit = (
  point: NodePosition,
  geometries: readonly ContainerGapGeometry[],
): ContainerGapHit | null => {
  let best: ContainerGapHit | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const geometry of geometries) {
    if (geometry.width <= 0 || geometry.height <= 0) continue;
    const insideX =
      point.x >= geometry.x && point.x <= geometry.x + geometry.width;
    const insideY =
      point.y >= geometry.y && point.y <= geometry.y + geometry.height;
    if (!insideX || !insideY) continue;
    const area = geometry.width * geometry.height;
    if (area < bestArea) {
      bestArea = area;
      best = {
        containerNodeId: geometry.containerNodeId,
        containerKind: geometry.containerKind,
      };
    }
  }
  return best;
};
