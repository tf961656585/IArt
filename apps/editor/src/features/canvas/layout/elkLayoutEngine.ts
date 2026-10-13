/**
 * 画板节点布局几何引擎适配器。
 *
 * 职责：把项目的 GraphNode + sizeMap 转换为 layout positions。
 *
 * 设计要点：
 * - 画布无连线、无端口、无拓扑：布局是纯几何遍历，默认按传入顺序单列垂直摆放，
 *   给出列数时按网格分行摆放；不读取、不生成也不推导任何连接信息
 *  （spec：画布自动布局算法.md「不支持边界」）。
 * - snap grid 由 placeGridFlow 内的 alignPosition 保证。
 * - 算法是纯函数语义：输入 nodes/sizeMap/options，输出 positions。
 * - 输入 nodes 不含组节点（type==='group'）。组节点不参与位置布局计算，调用层在算法入口前
 *   过滤掉组节点（spec：画布自动布局算法.md「组节点在布局中的地位」）。
 * - 方向固定 LR（左→右），间距固定标准值。spec：画布自动布局算法.md「布局配置项」。
 *
 * spec：docs/runtime/画布自动布局算法.md
 */

import type { GraphNode, NodePosition, NodeSize } from '../types';
import { NODE_GAP, placeGridFlow } from './layoutPrimitives';

export interface ElkLayoutOptions {
  snapGrid: [number, number];
  /**
   * 网格排布列数（容器内整理的「整理为网格」本次选取值）。
   *
   * 缺省或为 1 时按单列垂直摆放（全局整理与默认容器内整理口径）；大于 1 时按列数分行摆放，
   * 行数由节点数与列数决定（spec：画布自动布局算法.md「网格摆放」）。
   */
  columns?: number | undefined;
}

/**
 * 计算节点布局（纯几何遍历）。
 *
 * 输入契约：nodes 必须不含组节点（type==='group'）。组节点不参与位置布局计算，
 * 调用层（store action）在算法入口前过滤掉组节点（spec：画布自动布局算法.md
 * 「组节点在布局中的地位」）。组节点 position 是派生量（由成员包围盒派生），不回写。
 *
 * 画布已无连线与端口，布局不消费、不生成任何连接信息；节点按传入顺序摆放——默认单列
 * 垂直摆放，给出列数时按网格分行摆放，均使用各自有效尺寸推进间距
 *（spec：画布自动布局算法.md「分区内流式摆放」「网格摆放」「禁止事项」）。
 *
 * @param nodes 参与布局的节点（已过滤作用域，不含组节点）
 * @param sizeMap 每个节点的尺寸（必须覆盖全部 nodes，经 resolveEffectiveSize 解析）
 * @param options snap grid 与可选网格列数
 * @returns 每个节点的 position
 */
export const computeLayoutWithElk = async (
  nodes: GraphNode[],
  sizeMap: Map<string, NodeSize>,
  options: ElkLayoutOptions,
): Promise<Record<string, NodePosition>> =>
  placeGridFlow(
    nodes,
    sizeMap,
    options.snapGrid,
    NODE_GAP,
    options.columns !== undefined ? options.columns : 1,
  );
