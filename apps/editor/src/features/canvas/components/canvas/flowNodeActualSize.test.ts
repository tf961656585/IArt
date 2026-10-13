import { describe, expect, it } from 'vitest';
import { buildFlowMeasuredFingerprint, type readFlowNodeActualSize } from './flowNodeActualSize';

/**
 * 实测指纹契约测试。
 *
 * 指纹是实测投影的**失效信号**：xyflow v12 的 nodeLookup 是同一 Map 实例被原地更新，
 * 引用不变，所以依赖 nodeLookup 的 memo 无法感知实测收敛（实测通道曾整场为空，
 * 组内整理因此拿到 default 尺寸导致节点重叠）。指纹必须在「读数变化」时换值、
 * 在「无关变化」时保持稳定（否则会引入无谓重渲染）。
 */

/** 实测读取的输入形状（与 readFlowNodeActualSize 契约一致，去掉可空包装便于夹具构造）。 */
type FlowNodeSizeInput = NonNullable<Parameters<typeof readFlowNodeActualSize>[0]>;

const internalNode = (input: {
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number } | undefined;
}): FlowNodeSizeInput => input as FlowNodeSizeInput;

describe('buildFlowMeasuredFingerprint', () => {
  it('实测尺寸变化时换值', () => {
    const before = buildFlowMeasuredFingerprint(
      new Map([['a', internalNode({ measured: { width: 240, height: 320 } })]]),
    );
    const after = buildFlowMeasuredFingerprint(
      new Map([['a', internalNode({ measured: { width: 240, height: 180 } })]]),
    );

    expect(after).not.toBe(before);
  });

  it('同样内容重复计算结果相同（字符串按值比较，不触发无谓重渲染）', () => {
    const build = () =>
      buildFlowMeasuredFingerprint(
        new Map([
          ['a', internalNode({ measured: { width: 240, height: 320 } })],
          ['b', internalNode({ measured: { width: 320, height: 320 } })],
        ]),
      );

    expect(build()).toBe(build());
  });

  it('无 measured 但存在 width/height 时按 readFlowNodeActualSize 口径参与指纹', () => {
    const withSize = buildFlowMeasuredFingerprint(
      new Map([['a', internalNode({ width: 200, height: 150 })]]),
    );
    const withoutSize = buildFlowMeasuredFingerprint(new Map([['a', internalNode({})]]));

    expect(withSize).not.toBe('');
    expect(withoutSize).toBe('');
  });

  it('节点数量变化时换值（挂载 / 卸载 / 虚拟化）', () => {
    const one = buildFlowMeasuredFingerprint(
      new Map([['a', internalNode({ measured: { width: 240, height: 320 } })]]),
    );
    const two = buildFlowMeasuredFingerprint(
      new Map([
        ['a', internalNode({ measured: { width: 240, height: 320 } })],
        ['b', internalNode({ measured: { width: 240, height: 320 } })],
      ]),
    );

    expect(two).not.toBe(one);
  });

  it('输入缺失时返回空串（不抛错）', () => {
    expect(buildFlowMeasuredFingerprint(undefined)).toBe('');
    expect(buildFlowMeasuredFingerprint(null)).toBe('');
  });
});
