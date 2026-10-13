import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

import type { AgentMessageRecord, AgentSessionRecord } from '@iart/contracts';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph, TextInputNodeData } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import { cast } from '@/lib/utils';
import { AgentNode } from '../AgentNode';

/**
 * Agent 容器成员计数徽章（spec docs/agent/02「节点身份与数据」·AG-NP-005、AG-CT-005、AG-CT-007）。
 *
 * 口径改写于 2026-09-22：原文保护「成功产物数徽章」（工具结果消息 assetIds 去重计数）为
 * **旧行为**，本文件断言已按新 spec 更新（AG-NP-005 变更记录：徽章挂在容器折叠卡片上，
 * 计的是容器内成员，不是会话成功产物数——成员被拖出/拖入后两者分叉）。新口径：
 * - 徽章只在**折叠态**展示（AG-CT-005），**计数=容器成员数**（groupId 指向本节点的节点数），
 *   与会话产物消息彻底脱钩（AG-CT-007：计数走变更驱动增量索引，不订阅会话消息派生）；
 * - 展开态退场——容器范围成员可见，再显计数是复读；
 * - 无成员不显示（不显示 0，也不拿别的字段兜底）；
 * - 只读、不内嵌产物网格（浏览回到会话视图）。
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

const agentNode = (overrides: { collapsed?: boolean } = {}): GraphNode<AgentNodeData> => ({
  ...createGraphNode<AgentNodeData>({
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      label: 'Agent',
      agentSessionId: SESSION_ID,
      ...(overrides.collapsed !== undefined ? { collapsed: overrides.collapsed } : {}),
    },
  }),
  id: AGENT_NODE_ID,
});

/** 叶成员节点（textInput 形状对齐 store 索引测试夹具）；groupId 指向 Agent 容器即为成员。 */
const memberNode = (id: string, groupId?: string): GraphNode<TextInputNodeData> => ({
  id,
  type: 'textInput',
  position: { x: 0, y: 0 },
  data: {
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
    segments: [],
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    separator: undefined,
    customSeparator: undefined,
    promptPresetSnapshots: undefined,
    taskInfo: undefined,
    promptInterview: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const sessionRecord = (): AgentSessionRecord => ({
  agentSessionId: SESSION_ID,
  nodeId: AGENT_NODE_ID,
  modelId: 'my-llm',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '夜景改造',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_900_000,
  messageCount: 5,
  lastMessageAt: 1_770_000_600_000,
});

/** 成功产物消息（旧口径的数据源；新口径下它不得再决定徽章计数）。 */
const toolResult = (seq: number, assetIds: readonly string[]): AgentMessageRecord => ({
  agentSessionId: SESSION_ID,
  seq,
  role: 'assistant',
  requestId: 'req_1',
  body: {
    kind: 'tool_result',
    toolCallId: `call_${seq}`,
    toolName: 'generate_image',
    status: 'succeeded',
    summary: '已生成',
    assetIds: [...assetIds],
    errorSummary: null,
  },
  plan: null,
  createdAt: 1_770_000_700_000 + seq,
  isPartial: false,
});

const seedSession = (messages: AgentMessageRecord[]): void => {
  useAgentSessionStore.setState({
    sessionsById: { [SESSION_ID]: sessionRecord() },
    sessionIdByNodeId: { [AGENT_NODE_ID]: SESSION_ID },
    messagesBySessionId: { [SESSION_ID]: messages },
  });
};

const seedGraph = (nodes: GraphNode[]): void => {
  useCanvasStore.setState({ nodeGraph: graphWith(nodes) });
};

const renderNode = (selected = false) =>
  render(<AgentNode {...cast<NodeProps>({ id: AGENT_NODE_ID, selected })} />);

/** 成员计数徽章（新口径 testid；旧口径 agent-node-product-count 必须不再渲染）。 */
const badgeOf = (): HTMLElement | null => screen.queryByTestId('agent-node-member-count');
const legacyProductBadgeOf = (): HTMLElement | null =>
  screen.queryByTestId('agent-node-product-count');

beforeEach(() => {
  cleanup();
  seedGraph([agentNode()]);
  usePromptDockStore.setState({ form: 'generate', agentBinding: null });
  useAgentSessionStore.setState({
    sessionsById: {},
    sessionIdByNodeId: {},
    messagesBySessionId: {},
    inFlightBySessionId: {},
  });
});

describe('Agent 容器成员计数徽章', () => {
  // @spec: AG-NP-005, AG-CT-005
  it('折叠态徽章计数=成员数（成员 3、成功产物消息 5 → 显示 3，不是产物数）', () => {
    seedGraph([
      agentNode({ collapsed: true }),
      memberNode('m1', AGENT_NODE_ID),
      memberNode('m2', AGENT_NODE_ID),
      memberNode('m3', AGENT_NODE_ID),
    ]);
    seedSession([
      toolResult(2, ['asset_1', 'asset_2', 'asset_3']),
      toolResult(3, ['asset_4', 'asset_5']),
    ]);

    renderNode();

    const badge = badgeOf();
    expect(badge).toHaveTextContent('3');
    expect(badge?.textContent).not.toContain('产物');
    // 旧口径徽章（成功产物数）不再渲染
    expect(legacyProductBadgeOf()).toBeNull();
  });

  // @spec: AG-NP-005, AG-CT-005
  it('展开态徽章退场：有成员且会话有成功产物，仍不显示任何计数徽章', () => {
    seedGraph([
      agentNode(),
      memberNode('m1', AGENT_NODE_ID),
      memberNode('m2', AGENT_NODE_ID),
    ]);
    seedSession([toolResult(2, ['asset_1', 'asset_2', 'asset_3'])]);

    renderNode();

    expect(badgeOf()).toBeNull();
    expect(legacyProductBadgeOf()).toBeNull();
  });

  // @spec: AG-NP-005
  it('无成员（含折叠零成员）：不显示徽章（不显示 0）', () => {
    seedSession([toolResult(2, ['asset_1'])]);
    renderNode();
    expect(badgeOf()).toBeNull();
    expect(legacyProductBadgeOf()).toBeNull();

    cleanup();
    seedGraph([agentNode({ collapsed: true })]);
    renderNode();
    expect(badgeOf()).toBeNull();
    expect(legacyProductBadgeOf()).toBeNull();
  });

  // @spec: AG-CT-007
  it('计数随成员增删经增量索引更新：先零值无徽章，成员落地后出现并计数', async () => {
    seedSession([]);
    renderNode();
    expect(badgeOf()).toBeNull();

    await act(async () => {
      seedGraph([
        agentNode({ collapsed: true }),
        memberNode('m1', AGENT_NODE_ID),
        memberNode('m2', AGENT_NODE_ID),
      ]);
    });
    expect(badgeOf()).toHaveTextContent('2');
    expect(legacyProductBadgeOf()).toBeNull();
  });

  // @spec: AG-NP-005
  it('只读且不内嵌产物网格：单节点形态下无任何可点控件与媒体格', () => {
    seedSession([toolResult(2, ['asset_1'])]);

    renderNode(true);

    const node = document.querySelector(`[data-agent-node="${AGENT_NODE_ID}"]`);
    if (!(node instanceof HTMLElement)) throw new Error('agent node not rendered');
    expect(badgeOf()).toBeNull();
    expect(legacyProductBadgeOf()).toBeNull();
    // 单节点形态节点内没有按钮/链接（产物浏览回到会话视图，不在节点上展开）
    expect(node.querySelectorAll('button,a')).toHaveLength(0);
    // 不内嵌产物网格：没有媒体格 / 产物格 / 预览出口
    expect(node.querySelector('[data-testid="agent-media-box"]')).toBeNull();
    expect(node.querySelector('[data-testid="agent-media-band"]')).toBeNull();
    expect(node.querySelector('[data-testid="agent-album-grid"]')).toBeNull();
    expect(node.querySelector('[data-testid="agent-asset-preview-trigger"]')).toBeNull();
    expect(node.querySelectorAll('img,video')).toHaveLength(0);
    // 选中态仍在（选中驱动的进入由画布选择链承担，节点自身不因徽章多出交互面）
    expect(node.className).toContain('is-selected');
  });
});
