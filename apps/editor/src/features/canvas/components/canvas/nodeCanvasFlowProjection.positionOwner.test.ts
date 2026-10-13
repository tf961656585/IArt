import { describe, expect, it } from 'vitest';
import { toFlowNodes } from './nodeCanvasFlowProjection';
import type { CanvasLayoutSnapshotNode } from '../../store/selectors';

describe('toFlowNodes position owner', () => {
  it('只使用正式 layout snapshot position 构建 Flow node position', () => {
    const nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 40, y: 80 },
        draggable: true,
      },
    ] satisfies CanvasLayoutSnapshotNode[];

    const flowNodes = toFlowNodes(nodes, {
      renderSizeByNodeId: undefined,
      groupDerivedByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });

    expect(flowNodes).toHaveLength(1);
    expect(flowNodes[0]?.position).toEqual({ x: 40, y: 80 });
  });

  it('投影层 select 只由 selectedNodeIdSet 控制，未命中时 selected 为 false', () => {
    const nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 0, y: 0 },
        draggable: true,
      },
    ] satisfies CanvasLayoutSnapshotNode[];

    const flowNodes = toFlowNodes(nodes, {
      renderSizeByNodeId: undefined,
      groupDerivedByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });

    expect(flowNodes).toHaveLength(1);
    const firstNode = flowNodes[0];
    expect(firstNode).toBeDefined();
    if (firstNode !== undefined) {
      expect(firstNode.selected).toBe(false);
    }
  });

  it('回注真实 measured 以保住 handleBounds 稳定（spec：投影规则 规则 3/7）', () => {
    const nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 0, y: 0 },
        draggable: true,
      },
    ] satisfies CanvasLayoutSnapshotNode[];

    const withMeasured = toFlowNodes(nodes, {
      renderSizeByNodeId: undefined,
      groupDerivedByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: { 'node-1': { width: 300, height: 200 } },
    });
    expect(withMeasured[0]?.measured).toEqual({ width: 300, height: 200 });

    // 未提供真实 measured 时不回注，由 ReactFlow 首次测量补齐（避免冻结缓存）
    const withoutMeasured = toFlowNodes(nodes, {
      renderSizeByNodeId: undefined,
      groupDerivedByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: undefined,
    });
    expect(withoutMeasured[0]?.measured).toBeUndefined();

    // 零尺寸真实 measured 不回注（避免注入无效值）
    const zeroMeasured = toFlowNodes(nodes, {
      renderSizeByNodeId: undefined,
      groupDerivedByNodeId: undefined,
      selectedNodeIdSet: undefined,
      realMeasuredByNodeId: { 'node-1': { width: 0, height: 0 } },
    });
    expect(zeroMeasured[0]?.measured).toBeUndefined();
  });
});
