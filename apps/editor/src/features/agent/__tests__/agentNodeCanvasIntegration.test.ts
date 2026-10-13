import { describe, expect, it } from 'vitest';

import { nodeRegistry } from '@/features/canvas/nodes/registry';
import { normalizeNodeDataShape } from '@/features/canvas/store/internal/loadGraphNormalization';
import { sanitizeNode } from '@/features/canvas/export/validationSanitizers';
import { buildClipboardPayloadFromSelection } from '@/features/canvas/clipboard/selectionPayload';
import { resolveNodeTypeDefaultSize } from '@/features/canvas/utils/effectiveSize';
import { resolveChromeOverhead } from '@/features/canvas/layoutModel/chromeConstants';
import { AGENT_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/agent/agentNodeFactory';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import { createGraphNode } from '@/features/canvas/types/node';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';

/**
 * Agent 节点类型在画布既有链路（注册表 / 打开归一化 / bundle 导入 sanitize / 内部复制 /
 * 尺寸解析 / chrome 表）上的存读回归。
 *
 * 用契约把「agent 节点能存能读、导出导入不丢、不参与复制」封口：任一环缺注册或误判，
 * 节点会被静默降级为注释或复制出共享同一 agentSessionId 的第二节点。
 */

const agentNode = (): GraphNode<AgentNodeData> => {
  const node = createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 10, y: 20 },
    data: { label: 'Agent', agentSessionId: 'sess-1' },
  });
  return { ...node, id: 'agent-node-1' };
};

const imageInputNode = (): GraphNode => {
  const node = nodeRegistry.createNode('imageInput', { x: 0, y: 0 }, undefined);
  if (!node) throw new Error('imageInput 节点定义未注册');
  return node;
};

const graphWith = (nodes: GraphNode[]): NodeGraph => ({
  id: 'graph-1',
  name: 'test',
  description: undefined,
  status: 'draft',
  nodes,
  annotations: [],
  variables: undefined,
  settings: undefined,
  viewport: { x: 0, y: 0, zoom: 1 },
  meta: {
    version: '1.0.0',
    schemaVersion: undefined,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

describe('Agent 节点类型：注册表与尺寸', () => {
  it('注册为 palette 不可见、可删除、不可复制、static 尺寸策略', () => {
    const definition = nodeRegistry.get('agent');
    expect(definition).toBeDefined();
    expect(definition?.type).toBe('agent');
    expect(definition?.palette?.visible).toBe(false);
    expect(definition?.deletable).toBe(true);
    // 节点 ↔ 会话 1:1：复制会产生共享同一会话的第二节点
    expect(definition?.copyable).toBe(false);
    expect(definition?.sizeStrategy).toEqual({ mode: 'static' });
    expect(definition?.defaultSize).toEqual(AGENT_NODE_DEFAULT_SIZE);
    expect(definition?.executable).toBe(false);
    // 注册期校验：defaultSize 必须存在（validateNodeDefinition）
    expect(definition?.defaultData).toMatchObject({ label: 'Agent', agentSessionId: '' });
  });

  it('尺寸解析与 chrome 表都有 agent 档（不落默认兜底）', () => {
    expect(resolveNodeTypeDefaultSize('agent')).toEqual(AGENT_NODE_DEFAULT_SIZE);
    expect(resolveChromeOverhead('agent', undefined)).toEqual({ overheadX: 2, overheadY: 2 });
  });
});

describe('Agent 节点类型：打开归一化', () => {
  it('保留 agentSessionId 引用，不被改写或丢弃', () => {
    const normalized = normalizeNodeDataShape(agentNode(), {
      modelInlineControlsCollapsedDefault: false,
    });
    expect(normalized.type).toBe('agent');
    expect(normalized.data).toMatchObject({ label: 'Agent', agentSessionId: 'sess-1' });
  });
});

describe('Agent 节点类型：bundle 导入 sanitize', () => {
  it('合法 agent 节点保留为节点（不降级为自由注释），引用原样带入', () => {
    const result = sanitizeNode(agentNode(), 0, { modelInlineControlsCollapsedDefault: false });
    expect(result.kind).toBe('node');
    if (result.kind !== 'node') return;
    expect(result.node.type).toBe('agent');
    expect(result.node.data).toMatchObject({ agentSessionId: 'sess-1' });
    expect(result.node.position).toEqual({ x: 10, y: 20 });
  });
});

describe('Agent 节点类型：内部复制候选', () => {
  it('Agent 节点不进内部复制 payload（多选混选一并排除）', () => {
    const imageInput = imageInputNode();

    // 单选 Agent 节点：无可复制候选
    expect(
      buildClipboardPayloadFromSelection({
        nodeGraph: graphWith([agentNode()]),
        selectedNodeIds: ['agent-node-1'],
      }),
    ).toBeNull();

    // 多选混选：只收集合法候选
    const payload = buildClipboardPayloadFromSelection({
      nodeGraph: graphWith([agentNode(), imageInput]),
      selectedNodeIds: ['agent-node-1', imageInput.id],
    });
    expect(payload?.nodes.map((node) => node.type)).toEqual(['imageInput']);
  });
});
