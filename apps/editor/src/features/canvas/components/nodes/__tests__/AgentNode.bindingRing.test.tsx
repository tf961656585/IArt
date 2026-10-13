import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import { cast } from '@/lib/utils';
import { AgentNode } from '../AgentNode';

/**
 * Agent 节点的绑定环（spec docs/agent/02「选中态工具栏·绑定态视觉」、
 * docs/agent/06「选中驱动的进入—还原—粘滞」）。
 *
 * 绑定环是选中环的升级态、且只从 PromptDock store 派生（不写节点 data）：
 * PromptDock 处于 agent 形态并绑定该节点 → 加 `is-bound`（globals.css 2.5px accent 描边）；
 * 绑定解除（还原/粘滞/「新会话」/形态切回）→ 回落普通选中环。
 */

const AGENT_NODE_ID = 'agent-node-1';
const OTHER_NODE_ID = 'agent-node-2';
const SESSION_ID = 'sess_1';

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
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const agentNode = (id: string, agentSessionId: string): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'Agent', agentSessionId },
  }),
  id,
});

const renderNode = (nodeId: string, selected = true) =>
  render(<AgentNode {...cast<NodeProps>({ id: nodeId, selected })} />);

const ringOf = (nodeId: string): HTMLElement => {
  const element = document.querySelector(`[data-agent-node="${nodeId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error('agent node not rendered');
  return element;
};

beforeEach(() => {
  cleanup();
  useCanvasStore.setState({
    nodeGraph: graphWith([
      agentNode(AGENT_NODE_ID, SESSION_ID),
      agentNode(OTHER_NODE_ID, 'sess_2'),
    ]),
  });
  useAgentSessionStore.setState({
    sessionsById: {},
    sessionIdByNodeId: {},
  });
  usePromptDockStore.setState({ form: 'generate', agentBinding: null });
});

describe('AgentNode 绑定环', () => {
  it('PromptDock 绑定该节点会话 → 选中环升级为绑定环（is-bound）', () => {
    usePromptDockStore.setState({
      form: 'agent',
      agentBinding: { nodeId: AGENT_NODE_ID, agentSessionId: SESSION_ID },
    });

    renderNode(AGENT_NODE_ID);

    const ring = ringOf(AGENT_NODE_ID);
    expect(ring.className).toContain('is-selected');
    expect(ring.className).toContain('is-bound');
    expect(ring.getAttribute('data-bound')).toBe('true');
  });

  it('绑定的是别的节点 → 本节点回落普通选中环', () => {
    usePromptDockStore.setState({
      form: 'agent',
      agentBinding: { nodeId: OTHER_NODE_ID, agentSessionId: 'sess_2' },
    });

    renderNode(AGENT_NODE_ID);

    const ring = ringOf(AGENT_NODE_ID);
    expect(ring.className).toContain('is-selected');
    expect(ring.className).not.toContain('is-bound');
    expect(ring.getAttribute('data-bound')).toBeNull();
  });

  it('形态切回生成式（绑定仍在）→ 不呈现绑定环', () => {
    usePromptDockStore.setState({
      form: 'generate',
      agentBinding: { nodeId: AGENT_NODE_ID, agentSessionId: SESSION_ID },
    });

    renderNode(AGENT_NODE_ID);

    expect(ringOf(AGENT_NODE_ID).className).not.toContain('is-bound');
  });

  it('未选中 → 不呈现选中环（绑定环只是选中环的升级态，CSS 需 .is-selected.is-bound）', () => {
    usePromptDockStore.setState({
      form: 'agent',
      agentBinding: { nodeId: AGENT_NODE_ID, agentSessionId: SESSION_ID },
    });

    renderNode(AGENT_NODE_ID, false);

    const ring = ringOf(AGENT_NODE_ID);
    expect(ring.className).not.toContain('is-selected');
    expect(ring.className).toContain('is-bound');
  });

  it('还原（快照恢复回生成式）后回落普通选中环', async () => {
    usePromptDockStore.setState({
      form: 'agent',
      agentBinding: { nodeId: AGENT_NODE_ID, agentSessionId: SESSION_ID },
      agentEntrySnapshot: {
        nodeId: AGENT_NODE_ID,
        agentSessionId: SESSION_ID,
        form: 'generate',
        binding: null,
      },
    });
    renderNode(AGENT_NODE_ID);
    expect(ringOf(AGENT_NODE_ID).className).toContain('is-bound');

    // 还原 = 形态与绑定回到进入前（生成式、未绑定）。store 变更须包 act：
    // 订阅者重渲染由 React 调度，不包就会被断言读到旧 DOM。
    await act(async () => {
      usePromptDockStore.getState().restoreAgentEntrySnapshot('test');
    });

    expect(ringOf(AGENT_NODE_ID).className).not.toContain('is-bound');
  });
});
