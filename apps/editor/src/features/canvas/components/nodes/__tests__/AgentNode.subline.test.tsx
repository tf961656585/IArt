import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

import type { AgentSessionRecord } from '@iart/contracts';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import { formatBeijingShortDateTime } from '@/shared/utils/time';
import { cast } from '@/lib/utils';
import { AgentNode } from '../AgentNode';

/**
 * Agent 节点副行的时间口径（spec docs/agent/02「节点身份与数据」）。
 *
 * 保护：
 * - 副行时间取「最后一条正式消息时间」（lastMessageAt），不是会被配置变更抬升的 updatedAt；
 * - 格式为紧凑 `MM/DD HH:mm`（跨年含年份）；
 * - 没有消息（lastMessageAt 为 null）时不显示时间段，也不拿别的字段兜底；
 * - 在途「正在回复…」优先级高于消息量与时间；
 * - 会话读不到时仍是不可用说明，位形不变。
 */

const AGENT_NODE_ID = 'agent-node-1';
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
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const agentNode = (): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'Agent', agentSessionId: SESSION_ID },
  }),
  id: AGENT_NODE_ID,
});

const sessionRecord = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: SESSION_ID,
  nodeId: AGENT_NODE_ID,
  modelId: 'my-llm',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '夜景改造',
  createdAt: 1_770_000_000_000,
  // 配置变更会抬升 updatedAt，但不是消息时间：副行不得读它
  updatedAt: 1_770_000_900_000,
  messageCount: 2,
  lastMessageAt: 1_770_000_600_000,
  ...overrides,
});

const sublineOf = (): string => {
  const element = document.querySelector('[data-agent-node="agent-node-1"] .agent-sub');
  if (!(element instanceof HTMLElement)) throw new Error('agent node subline not rendered');
  return element.textContent ?? '';
};

beforeEach(() => {
  cleanup();
  useCanvasStore.setState({ nodeGraph: graphWith([agentNode()]) });
  usePromptDockStore.setState({ form: 'generate', agentBinding: null });
  useAgentSessionStore.setState({
    sessionsById: { [SESSION_ID]: sessionRecord() },
    sessionIdByNodeId: { [AGENT_NODE_ID]: SESSION_ID },
    inFlightBySessionId: {},
  });
});

describe('Agent 节点副行时间口径', () => {
  it('时间取最后一条消息时间（lastMessageAt），不是 updatedAt；格式为 MM/DD HH:mm', () => {
    render(<AgentNode {...cast<NodeProps>({ id: AGENT_NODE_ID, selected: false })} />);

    const lastMessageAt = 1_770_000_600_000;
    // 格式断言固定参照年（与消息同年 → 不带年份），不随运行年份漂移；组件用的默认「当下」参照由下面这行覆盖。
    expect(formatBeijingShortDateTime(lastMessageAt, lastMessageAt)).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2}$/,
    );
    expect(sublineOf()).toBe(`消息 2 条 · ${formatBeijingShortDateTime(lastMessageAt)}`);
    // updatedAt（配置变更抬升的值）不出现在副行
    expect(sublineOf()).not.toContain(formatBeijingShortDateTime(1_770_000_900_000));
  });

  it('跨年消息带年份（YYYY/MM/DD HH:mm）', () => {
    // 2025-12-31 23:59（北京时间），当下已是 2026 年
    const crossYear = Date.parse('2025-12-31T15:59:00.000Z');
    useAgentSessionStore.setState({
      sessionsById: { [SESSION_ID]: sessionRecord({ lastMessageAt: crossYear }) },
    });
    render(<AgentNode {...cast<NodeProps>({ id: AGENT_NODE_ID, selected: false })} />);

    expect(sublineOf()).toContain('2025/12/31 23:59');
  });

  it('没有消息（lastMessageAt 为 null）：不显示时间段，也不拿 updatedAt 兜底', () => {
    useAgentSessionStore.setState({
      sessionsById: {
        [SESSION_ID]: sessionRecord({ lastMessageAt: null, messageCount: 0 }),
      },
    });
    render(<AgentNode {...cast<NodeProps>({ id: AGENT_NODE_ID, selected: false })} />);

    expect(sublineOf()).toBe('');
  });

  it('在途「正在回复…」优先于消息量与时间', () => {
    useAgentSessionStore.setState({
      inFlightBySessionId: {
        [SESSION_ID]: { requestId: 'req_1', agentSessionId: SESSION_ID, nodeId: AGENT_NODE_ID },
      },
    });
    render(<AgentNode {...cast<NodeProps>({ id: AGENT_NODE_ID, selected: false })} />);

    expect(sublineOf()).toBe('正在回复…');
  });

  it('会话读不到：仍是不可用说明（不显示空串或零值摘要）', () => {
    useAgentSessionStore.setState({ sessionsById: {}, sessionIdByNodeId: {} });
    render(<AgentNode {...cast<NodeProps>({ id: AGENT_NODE_ID, selected: false })} />);

    expect(sublineOf()).toBe('这个会话已经不在了，删掉这个节点');
  });
});
