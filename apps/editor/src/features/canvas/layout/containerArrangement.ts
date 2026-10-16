/**
 * 容器内整理的共享计算（纯函数，无 store 依赖）。
 *
 * 两个消费方共用同一实现，禁止各自复制锚点补偿逻辑：
 * - 画布「容器内整理」动作（canvasStore.groupActions.autoLayoutContainer）；
 * - 批次收口整块重排的同容器桶（promptdock/projection/batchCompletion.ts）。
 *
 * 语义（spec：docs/runtime/画布自动布局算法.md「网格摆放」、docs/runtime/画布节点组.md
 * 「自动布局协作」）：对成员集合执行布局引擎排布（列数由调用方给出），并把算法输出
 * 平移补偿到「整理前成员包围盒左上角」——容器锚点保持，组框随成员派生自动更新。
 */

import type { GraphNode, NodePosition } from '../types';
import type { EffectiveSizeSources } from '../utils/effectiveSize';
import { computeAutoLayout } from './autoLayout';

export type ContainerArrangementParams = {
  /** 参与整理的成员集合（布局输入序决定占格顺序；不应含组节点） */
  members: ReadonlyArray<GraphNode>;
  /** 成员尺寸来源（经 resolveEffectiveSize 统一解析） */
  sizeSources: EffectiveSizeSources;
  /** 网格列数；缺省单列垂直摆放 */
  columns: number | undefined;
  /** 对齐网格（画板 snapGrid） */
  snapGrid: [number, number] | undefined;
};

/**
 * 节点集合位置包围盒左上角（锚点计算共享几何源）。
 *
 * 共享消费者：容器内整理（本文件）与全局整理锚点补偿（canvasStore.layoutActions），
 * 两者必须用同一包围盒口径计算锚点，禁止各自复制实现。
 */
export const bboxTopLeft = (nodes: ReadonlyArray<GraphNode>): NodePosition => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.position.x < minX) minX = node.position.x;
    if (node.position.y < minY) minY = node.position.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0 };
  return { x: minX, y: minY };
};

/**
 * 计算容器成员整理后的目标位置（锚点补偿后）。
 * 返回 null = 布局引擎未产出任何位置（空成员或成员几何非法），调用方按无操作处理。
 */
export const computeContainerArrangedPositions = async (
  params: ContainerArrangementParams,
): Promise<Record<string, NodePosition> | null> => {
  const { members, sizeSources, columns, snapGrid } = params;
  if (members.length === 0) return null;

  const beforeAnchor = bboxTopLeft(members);

  const layoutResult = await computeAutoLayout([...members], {
    defaultNodeSize: undefined,
    snapGrid,
    sizeSources,
    columns,
  });
  if (Object.keys(layoutResult.positions).length === 0) return null;

  // 锚点保持：算出算法输出后的包围盒左上角，补偿平移使整理后锚点 = 整理前锚点
  const afterAnchor = bboxTopLeft(
    members.map((member) => {
      const nextPosition = layoutResult.positions[member.id];
      return nextPosition ? { ...member, position: nextPosition } : member;
    }),
  );
  const dx = beforeAnchor.x - afterAnchor.x;
  const dy = beforeAnchor.y - afterAnchor.y;
  const positions: Record<string, NodePosition> = {};
  for (const [id, position] of Object.entries(layoutResult.positions)) {
    positions[id] = { x: position.x + dx, y: position.y + dy };
  }
  return positions;
};
