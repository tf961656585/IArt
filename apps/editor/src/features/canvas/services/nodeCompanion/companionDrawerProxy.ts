import nodeRegistry, { type NodeDefinition } from '../../nodes/registry';
import type { DynamicRecord } from '@/client/utils/typeGuards';
import { cast } from '@/lib/utils';
import type { GraphNode } from '../../types/node';
import type { NodeCompanionDeclaration } from '../../types/nodeCompanion';
import { getDefaultCompanionDeclarationsForNodeType } from './augmentNodeDefinitionCompanions';

export type CompanionDrawerProxyPortDirection = 'input' | 'output';

export type CompanionDrawerProxyHandleDecoded = {
  companionNodeId: string;
  portId: string;
  portDirection: CompanionDrawerProxyPortDirection;
};

export type EmbeddedCompanionRef = {
  ownerNodeId: string;
  companionNodeId: string;
  kind: string;
};

export type EmbeddedCompanionIndex = {
  embeddedByCompanionId: ReadonlyMap<string, EmbeddedCompanionRef>;
  embeddedCompanionIdsByOwnerId: ReadonlyMap<string, readonly string[]>;
};

const getOwnerDefinition = (node: GraphNode): NodeDefinition | null => {
  if (node.type === 'model') {
    const modelId = (node.data !== null && node.data !== undefined ? (node.data as { modelId: unknown | undefined }).modelId : undefined);
    if (typeof modelId === 'string' && modelId.trim()) {
      return nodeRegistry.getModelNode(modelId) ?? null;
    }
  }
  return nodeRegistry.get(node.type) ?? null;
};

const getCompanionDeclarationsForOwnerNode = (ownerNode: GraphNode): NodeCompanionDeclaration[] => {
  const ownerDef = getOwnerDefinition(ownerNode);
  const declared = (ownerDef !== null && ownerDef !== undefined ? ownerDef.companions : undefined) ?? [];
  if (declared.length > 0) return declared;
  return getDefaultCompanionDeclarationsForNodeType(ownerNode.type);
};

const getCompanionNodeType = (declaration: NodeCompanionDeclaration): string | null => {
  const def = nodeRegistry.get(declaration.nodeKey);
  return (def !== null && def !== undefined ? def.type : undefined) ?? null;
};

export const buildEmbeddedCompanionIndex = (nodes: readonly GraphNode[]): EmbeddedCompanionIndex => {
  const nodesByType = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = nodesByType.get(node.type) ?? [];
    list.push(node);
    nodesByType.set(node.type, list);
  }

  const embeddedByCompanionId = new Map<string, EmbeddedCompanionRef>();
  const embeddedCompanionIdsByOwnerId = new Map<string, string[]>();

  for (const ownerNode of nodes) {
    const declarations = getCompanionDeclarationsForOwnerNode(ownerNode);
    for (const decl of declarations) {
      if (decl.bind.type !== 'dataField') continue;
      if ((decl.ui !== null && decl.ui !== undefined ? decl.ui.presentation : undefined) !== 'drawer') continue;

      const companionType = getCompanionNodeType(decl);
      if (!companionType) continue;

      const candidates = nodesByType.get(companionType) ?? [];
      const bindField = decl.bind.ownerNodeIdField;

      for (const candidate of candidates) {
        const ownerId = cast<DynamicRecord>(candidate.data)[bindField];
        if (ownerId !== ownerNode.id) continue;

        embeddedByCompanionId.set(candidate.id, {
          ownerNodeId: ownerNode.id,
          companionNodeId: candidate.id,
          kind: decl.kind,
        });

        const list = embeddedCompanionIdsByOwnerId.get(ownerNode.id) ?? [];
        list.push(candidate.id);
        embeddedCompanionIdsByOwnerId.set(ownerNode.id, list);
      }
    }
  }

  const frozenByOwnerId = new Map<string, readonly string[]>();
  for (const [ownerId, list] of embeddedCompanionIdsByOwnerId) {
    frozenByOwnerId.set(ownerId, Object.freeze([...list]));
  }

  return {
    embeddedByCompanionId,
    embeddedCompanionIdsByOwnerId: frozenByOwnerId,
  };
};

