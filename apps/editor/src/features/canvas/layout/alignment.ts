/**
 * 选中节点对齐/分布工具（纯函数）。
 *
 * 参照 yEd / draw.io / Figma / Blender 节点编辑器的标准对齐能力：
 * 6 种对齐（左/水平居中/右/顶/垂直居中/底）+ 2 种分布（水平/垂直等距）。
 *
 * 设计：
 * - 纯函数，不依赖 ELK，不依赖 store。
 * - 对齐的参考系是选中集的包围盒边/中心（不是某个 key object）。
 * - 不保持几何中心不动——对齐的语义就是吸附到包围盒边/中心，结果必然改变部分节点位置。
 * - 触发条件：对齐需 ≥2 节点，分布需 ≥3 节点；不满足返回 null。
 * - 输出经 snap grid 吸附。
 *
 * spec：docs/runtime/画布节点组.md「对齐作用域」
 */

import type { NodePosition, NodeSize } from '../types';
import { alignPosition } from './layoutPrimitives';

/** 对齐/分布模式 */
export type AlignmentMode =
  | 'left' | 'centerHorizontal' | 'right'      // 水平对齐
  | 'top' | 'centerVertical' | 'bottom'        // 垂直对齐
  | 'distributeHorizontal' | 'distributeVertical';  // 分布

/** 对齐操作的输入节点（需 id + position + size） */
export interface AlignableNode {
  id: string;
  position: NodePosition;
  size: NodeSize;
}

/**
 * 判断模式是否为分布模式（需 ≥3 节点）。
 */
export const isDistributeMode = (mode: AlignmentMode): boolean =>
  mode === 'distributeHorizontal' || mode === 'distributeVertical';

/**
 * 计算对齐/分布后的目标位置。
 *
 * @param nodes 参与对齐的节点（已含 position 和 size）
 * @param mode 对齐/分布模式
 * @param gap 分布间距（仅分布模式使用，对齐模式忽略）
 * @param snapGrid 网格吸附
 * @returns 每个节点的目标位置；节点数不足时返回 null
 */
export const computeAlignment = (
  nodes: AlignableNode[],
  mode: AlignmentMode,
  gap: number,
  snapGrid: [number, number],
): Record<string, NodePosition> | null => {
  if (nodes.length === 0) return null;

  // 触发条件校验
  if (isDistributeMode(mode)) {
    if (nodes.length < 3) return null;
  } else {
    if (nodes.length < 2) return null;
  }

  const positions: Record<string, NodePosition> = {};

  switch (mode) {
    case 'left': {
      const minX = Math.min(...nodes.map((n) => n.position.x));
      for (const n of nodes) {
        positions[n.id] = alignPosition({ x: minX, y: n.position.y }, snapGrid);
      }
      break;
    }
    case 'right': {
      const maxRight = Math.max(...nodes.map((n) => n.position.x + n.size.width));
      for (const n of nodes) {
        positions[n.id] = alignPosition({ x: maxRight - n.size.width, y: n.position.y }, snapGrid);
      }
      break;
    }
    case 'centerHorizontal': {
      const minX = Math.min(...nodes.map((n) => n.position.x));
      const maxX = Math.max(...nodes.map((n) => n.position.x + n.size.width));
      const centerX = (minX + maxX) / 2;
      for (const n of nodes) {
        positions[n.id] = alignPosition({ x: centerX - n.size.width / 2, y: n.position.y }, snapGrid);
      }
      break;
    }
    case 'top': {
      const minY = Math.min(...nodes.map((n) => n.position.y));
      for (const n of nodes) {
        positions[n.id] = alignPosition({ x: n.position.x, y: minY }, snapGrid);
      }
      break;
    }
    case 'bottom': {
      const maxBottom = Math.max(...nodes.map((n) => n.position.y + n.size.height));
      for (const n of nodes) {
        positions[n.id] = alignPosition({ x: n.position.x, y: maxBottom - n.size.height }, snapGrid);
      }
      break;
    }
    case 'centerVertical': {
      const minY = Math.min(...nodes.map((n) => n.position.y));
      const maxY = Math.max(...nodes.map((n) => n.position.y + n.size.height));
      const centerY = (minY + maxY) / 2;
      for (const n of nodes) {
        positions[n.id] = alignPosition({ x: n.position.x, y: centerY - n.size.height / 2 }, snapGrid);
      }
      break;
    }
    case 'distributeHorizontal': {
      // 按 x 排序，首尾不动，中间节点均匀分布
      const sorted = [...nodes].sort((a, b) => a.position.x - b.position.x);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (!first || !last) return null;
      const startX = first.position.x;
      const endX = last.position.x;
      const totalSpan = endX - startX;
      const step = (totalSpan - gap * (sorted.length - 1)) / (sorted.length - 1);
      // 累积各节点宽度（首尾之间），保证每个节点左边界间距 = gap + 前节点宽度
      // 简化：按等间距放置（首尾不动，中间均匀），这是 draw.io/Figma 的标准做法
      for (let i = 0; i < sorted.length; i += 1) {
        const n = sorted[i];
        if (!n) continue;
        if (i === 0) {
          positions[n.id] = alignPosition({ x: startX, y: n.position.y }, snapGrid);
        } else if (i === sorted.length - 1) {
          positions[n.id] = alignPosition({ x: endX, y: n.position.y }, snapGrid);
        } else {
          const x = startX + i * step;
          positions[n.id] = alignPosition({ x, y: n.position.y }, snapGrid);
        }
      }
      break;
    }
    case 'distributeVertical': {
      // 按 y 排序，首尾不动，中间节点均匀分布
      const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (!first || !last) return null;
      const startY = first.position.y;
      const endY = last.position.y;
      const totalSpan = endY - startY;
      const step = (totalSpan - gap * (sorted.length - 1)) / (sorted.length - 1);
      for (let i = 0; i < sorted.length; i += 1) {
        const n = sorted[i];
        if (!n) continue;
        if (i === 0) {
          positions[n.id] = alignPosition({ x: n.position.x, y: startY }, snapGrid);
        } else if (i === sorted.length - 1) {
          positions[n.id] = alignPosition({ x: n.position.x, y: endY }, snapGrid);
        } else {
          const y = startY + i * step;
          positions[n.id] = alignPosition({ x: n.position.x, y }, snapGrid);
        }
      }
      break;
    }
  }

  return positions;
};
