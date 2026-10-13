/**
 * 画板注释（Annotation）
 * - 注释不属于节点（GraphNode），而是独立的画布元素
 * - 可自由放置，也可绑定到节点
 */

import type { NodePosition, NodeSize } from './node';

export type AnnotationBinding =
  | { type: 'free' }
  | { type: 'node'; nodeId: string };

type AnnotationBindingCandidate = {
  type: unknown | undefined;
  nodeId: unknown | undefined;
};

export const isAnnotationBinding = (value: unknown): value is AnnotationBinding => {
  if (!value || typeof value !== 'object') return false;
  const binding = value as AnnotationBindingCandidate;

  if (binding.type === 'free') return true;
  if (binding.type === 'node') return typeof binding.nodeId === 'string';
  return false;
};

export interface CanvasAnnotationStyle {
  /** 主题颜色（用于背景/边框） */
  color: string;
  /** 字号（画布坐标系，缩放会同步影响显示） */
  fontSize: number;
}

export interface CanvasAnnotation {
  id: string;
  content: string;
  /** 顶点坐标（画布坐标系） */
  position: NodePosition;
  /** 尺寸（画布坐标系） */
  size: NodeSize;
  binding: AnnotationBinding;
  style: CanvasAnnotationStyle;
}

export const DEFAULT_ANNOTATION_SIZE: NodeSize = { width: 240, height: 80 };
export const DEFAULT_ANNOTATION_STYLE: CanvasAnnotationStyle = {
  color: '#fef3c7',
  fontSize: 14,
};

/** 生成唯一注释 ID */
export function generateAnnotationId(): string {
  return `ann_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
