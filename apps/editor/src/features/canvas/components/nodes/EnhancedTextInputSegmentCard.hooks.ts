import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * 文本段卡片拖拽排序能力（@dnd-kit 就地接入，不做公共抽象——见设计文档 Non-Goals）。
 *
 * - 手柄限定：整卡不可拖，仅手柄挂 listeners，避免与 contentEditable 划选文字手势冲突。
 * - readOnly 时禁用排序：useSortable disabled 短路拖拽，且调用方不展开 attributes/listeners。
 */
export function useSegmentCardSortable(segmentId: string, enabled: boolean) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: segmentId,
    disabled: !enabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return { attributes, listeners, setNodeRef, style, isDragging };
}
