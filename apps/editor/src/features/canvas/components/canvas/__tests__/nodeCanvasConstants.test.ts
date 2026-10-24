import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_CLICK_DISTANCE, CANVAS_NODE_DRAG_THRESHOLD } from '../nodeCanvasConstants';

// 口径：docs/runtime/画布交互态与ReactFlow投影边界.md「拖拽与正式位置」4px/4px 阈值
describe('画布节点拖拽阈值', () => {
  it('拖拽启动阈值与点击距离相等且为 4 屏幕 px', () => {
    expect(CANVAS_NODE_DRAG_THRESHOLD).toBe(4);
    expect(CANVAS_NODE_CLICK_DISTANCE).toBe(4);
    expect(CANVAS_NODE_DRAG_THRESHOLD).toBe(CANVAS_NODE_CLICK_DISTANCE);
  });
});
