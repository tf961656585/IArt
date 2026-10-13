import { describe, it } from 'vitest';

// resultArea 重构后 companion 机制已废弃，需要重写。
// resultArea 已从独立 GraphNode 退化为 model.data.resultArea 子结构：
// - GraphNodeType 不再包含 'resultArea'
// - DEFAULT_MODEL_COMPANIONS 已清空（augmentNodeDefinitionCompanions）
// - addNode(model) 不再创建 companion resultArea 节点
// 因此下列用例（addNode 创建 companion、companion 随 owner 联动位移、级联删除等）
// 的前置假设全部失效，整体跳过，待基于 model.data.resultArea 新语义重写。
describe.skip('nodeCompanion integration (canvasStore)', () => {
  it('addNode(model) should create companion resultArea with sourceNodeId binding');

  it('updateNodePositionsBatch dragging owner should move companion by same delta');

  it('updateNodePositionsBatch dragging companion should move owner by same delta');

  it('updateNodePositionsBatch should enforce locked dock position even if payload contains inconsistent owner+companion positions');

  it('removeNodes should cascade remove companion nodes bound via dataField');

  it('removeNodes should not remove owner when only companion is deleted');
});
