import type { GraphNodeType } from '../../types/node';
import type { NodeCompanionDeclaration } from '../../types/nodeCompanion';

type NodeDefinitionLike = {
  type: GraphNodeType;
  companions: NodeCompanionDeclaration[] | undefined;
};

/**
 * resultArea companion 声明已删除。
 *
 * resultArea 已从独立 GraphNode 退化为 model.data.resultArea 子结构，
 * 不再需要 companion 机制创建和管理。companion 声明列表现为空，
 * 保留文件和函数签名以兼容 nodeRegistry 的调用约定。
 */
export const DEFAULT_MODEL_COMPANIONS: NodeCompanionDeclaration[] = [];

export const augmentNodeDefinitionCompanions = <T extends NodeDefinitionLike>(definition: T): T => {
  if (definition.type !== 'model') return definition;
  if (Array.isArray(definition.companions) && definition.companions.length > 0) return definition;
  return {
    ...definition,
    companions: DEFAULT_MODEL_COMPANIONS,
  };
};

export const getDefaultCompanionDeclarationsForNodeType = (type: GraphNodeType): NodeCompanionDeclaration[] => {
  if (type === 'model') return DEFAULT_MODEL_COMPANIONS;
  return [];
};
