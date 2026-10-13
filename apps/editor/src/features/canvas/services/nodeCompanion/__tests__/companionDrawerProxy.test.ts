import { describe, expect, it } from 'vitest';

// resultArea 重构后 companion 机制已废弃，需要重写。
// 以下用例依赖旧版独立 resultArea 节点（type: 'resultArea'）与
// buildEmbeddedCompanionIndex 的 companion 联动，
// 重构后 resultArea 已退化为 model.data.resultArea 子结构，GraphNodeType
// 不再包含 'resultArea'，DEFAULT_MODEL_COMPANIONS 也已清空。这些用例整体跳过。
describe.skip('resultArea 重构后 companion 机制已废弃，需要重写', () => {
  // buildEmbeddedCompanionIndex 的 companion 端点映射逻辑已失效（owner+resultArea
  // 节点对不再存在）。保留用例标题以便后续按 model.data.resultArea 新语义重写。

  it('buildEmbeddedCompanionIndex should include drawer companions when owner exists', () => {
    // 旧实现：createOwnerModelNode + createResultAreaNode → buildEmbeddedCompanionIndex
    // 新语义下 resultArea 不再是独立节点，需基于 model.data.resultArea 重新设计。
    expect(true).toBe(true);
  });

  it('buildEmbeddedCompanionIndex should NOT include orphan companions', () => {
    expect(true).toBe(true);
  });
});
