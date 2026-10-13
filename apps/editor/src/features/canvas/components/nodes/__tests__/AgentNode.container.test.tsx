import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';

import type { AgentSessionRecord } from '@iart/contracts';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createGraphNode } from '@/features/canvas/types/node';
import type { GraphNode, NodeGraph, TextInputNodeData } from '@/features/canvas/types';
import type { AgentNodeData } from '@/features/canvas/types/agentNode';
import { cast } from '@/lib/utils';
import { AgentNode } from '../AgentNode';

/**
 * Agent 容器形态渲染（spec docs/agent/02「节点形态」/AG-CT-005、docs/runtime/画布节点组.md
 * 「空间边界与移动」「折叠」；视觉决策 CN-V-01~07、CN-V-09）。
 *
 * 保护：
 * - 同体两态：无成员 = 既有单节点形态（.agent-surface 卡片、pointer-events 自持、副行显示），
 *   有成员 = 容器形态（accent 背板 + 32px 交互条 chip、副行退场）；切换不预渲染背板；
 * - 展开态计数徽章退场（AG-CT-005）；选中环只落背板、根不带 is-selected（单环不叠，CN-V-07）；
 * - 被组包裹（node.groupId 非空）时背板底档走 --agent-surface-nested（4% 嵌套档，CN-V-07）；
 * - 容器头 chip 必显 model_id（mono 11px）+ 标题 + 审批档 pill（CN-V-02），流式脉冲为 chip 内 dot；
 * - 折叠卡与组折叠卡同构（展开钮 + 标题 + model_id 截断 + 成员计数徽章），点击展开回落形态；
 * - LOD：<80px 屏幕尺寸降级锚点（title 带「标题 · N」）、展开态 <120px 显定位气泡（CN-V-03/05）。
 *
 * 尺寸口径（240×64 ↔ 派生容器尺寸）由投影层/机制层承载（layoutModel 静态 240×64、
 * buildGroupDerivedSize 派生容器 entry），组件测试断言两态的结构形态与不预渲染背板。
 */

const AGENT_NODE_ID = 'agent-node-1';
const GROUP_NODE_ID = 'group-1';
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
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const agentNode = (
  overrides: { collapsed?: boolean; groupId?: string } = {},
): GraphNode<AgentNodeData> => ({
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
  groupId: overrides.groupId,
});

const memberNode = (id: string, groupId?: string): GraphNode<TextInputNodeData> => ({
  id,
  type: 'textInput',
  position: { x: 280, y: 120 },
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
  messageCount: 2,
  lastMessageAt: 1_770_000_600_000,
});

const seedGraph = (nodes: GraphNode[]): void => {
  useCanvasStore.setState({ nodeGraph: graphWith(nodes) });
};

const renderNode = (
  props: { selected?: boolean; width?: number; height?: number } = {},
) =>
  render(
    <AgentNode
      {...cast<NodeProps>({
        id: AGENT_NODE_ID,
        selected: props.selected ?? false,
        width: props.width,
        height: props.height,
      })}
    />,
  );

const rootNode = (): HTMLElement => {
  const element = document.querySelector(`[data-agent-node="${AGENT_NODE_ID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error('agent node not rendered');
  return element;
};

const surfaceOf = (): HTMLElement | null =>
  document.querySelector('[data-testid="agent-container-surface"]');
const chipOf = (): HTMLElement | null =>
  document.querySelector('[data-testid="agent-container-chip"]');
const cardSurfaceOf = (): HTMLElement | null =>
  document.querySelector(`[data-agent-node="${AGENT_NODE_ID}"] .agent-surface`);
const sublineOf = (): HTMLElement | null =>
  document.querySelector(`[data-agent-node="${AGENT_NODE_ID}"] .agent-sub`);

const THREE_MEMBERS = (): GraphNode[] => [
  memberNode('m1', AGENT_NODE_ID),
  memberNode('m2', AGENT_NODE_ID),
  memberNode('m3', AGENT_NODE_ID),
];

beforeEach(() => {
  cleanup();
  seedGraph([agentNode()]);
  usePromptDockStore.setState({ form: 'generate', agentBinding: null });
  useAgentSessionStore.setState({
    sessionsById: { [SESSION_ID]: sessionRecord() },
    sessionIdByNodeId: { [AGENT_NODE_ID]: SESSION_ID },
    messagesBySessionId: {},
    inFlightBySessionId: {},
  });
});

describe('Agent 容器形态切换', () => {
  // @spec: AG-CT-005
  it('无成员恒单节点形态：.agent-surface 卡片、不预渲染背板、指针自持、副行在', () => {
    renderNode();

    const root = rootNode();
    expect(root.getAttribute('data-agent-form')).toBe('leaf');
    expect(cardSurfaceOf()).not.toBeNull();
    expect(surfaceOf()).toBeNull();
    expect(chipOf()).toBeNull();
    expect(root.className).toContain('pointer-events-auto');
    expect(sublineOf()).not.toBeNull();
  });

  // @spec: AG-CT-005
  it('首成员落地切容器形态、末成员移出回落单节点形态（背板/头 chip 随形态进出）', async () => {
    renderNode();
    expect(cardSurfaceOf()).not.toBeNull();
    expect(surfaceOf()).toBeNull();

    // 成员落地 → 容器形态：卡片退场，背板 + 容器头进场（尺寸切换不走补间，机制层直接改派生尺寸）
    await act(async () => {
      seedGraph([agentNode(), ...THREE_MEMBERS()]);
    });
    expect(rootNode().getAttribute('data-agent-form')).toBe('container');
    expect(cardSurfaceOf()).toBeNull();
    expect(surfaceOf()).not.toBeNull();
    expect(chipOf()).not.toBeNull();
    expect(rootNode().className).toContain('pointer-events-none');

    // 末成员移出 → 回落单节点形态
    await act(async () => {
      seedGraph([agentNode()]);
    });
    expect(rootNode().getAttribute('data-agent-form')).toBe('leaf');
    expect(surfaceOf()).toBeNull();
    expect(cardSurfaceOf()).not.toBeNull();
  });

  // @spec: AG-CT-005
  it('容器形态副行退场（「消息 N 条 · 时间」只在单节点形态与孵化期显示）', () => {
    seedGraph([agentNode(), ...THREE_MEMBERS()]);
    renderNode();
    expect(sublineOf()).toBeNull();
  });
});

describe('Agent 容器头（chip）', () => {
  // @spec: AG-NP-005
  it('chip 承载 model_id（mono 必显）+ 标题 + 审批档 pill；展开态计数徽章退场', () => {
    seedGraph([agentNode(), ...THREE_MEMBERS()]);
    renderNode();

    const chip = chipOf();
    if (chip === null) throw new Error('container chip not rendered');
    const modelChip = chip.querySelector('.font-mono');
    expect(modelChip).not.toBeNull();
    expect(modelChip?.textContent).toBe('my-llm');
    expect(chip.textContent).toContain('夜景改造');
    expect(screen.queryByTestId('agent-chip-approval')).toHaveTextContent('逐条确认');
    // 展开态徽章退场（AG-CT-005）
    expect(screen.queryByTestId('agent-node-member-count')).toBeNull();
    // 副行退场
    expect(sublineOf()).toBeNull();
  });

  // @spec: AG-NP-005
  it('容器态流式脉冲缩为 chip 内 dot，且不显示副行', async () => {
    seedGraph([agentNode(), ...THREE_MEMBERS()]);
    renderNode();
    expect(screen.queryByTestId('agent-chip-pulse')).toBeNull();

    await act(async () => {
      useAgentSessionStore.setState({
        inFlightBySessionId: {
          [SESSION_ID]: { requestId: 'req_1', agentSessionId: SESSION_ID, nodeId: AGENT_NODE_ID },
        },
      });
    });
    expect(screen.queryByTestId('agent-chip-pulse')).not.toBeNull();
    expect(sublineOf()).toBeNull();
  });
});

describe('Agent 容器背板选中与嵌套底档', () => {
  // @spec: AG-CT-005
  it('选中环只落背板：根不带 is-selected（单环不叠），背板取 select-ring + 12% 选中档', () => {
    seedGraph([agentNode(), ...THREE_MEMBERS()]);
    renderNode({ selected: true });

    expect(rootNode().className).not.toContain('is-selected');
    const surface = surfaceOf();
    if (surface === null) throw new Error('container surface not rendered');
    expect(surface.className).toContain('var(--select-ring)');
    expect(surface.className).toContain('var(--agent-accent)_12%');
  });

  // @spec: AG-CT-005
  it('常态背板为身份色 6% 底；被组包裹时降 4% 嵌套档（--agent-surface-nested）', () => {
    seedGraph([agentNode(), ...THREE_MEMBERS()]);
    renderNode();
    const plain = surfaceOf();
    if (plain === null) throw new Error('container surface not rendered');
    expect(plain.className).toContain('var(--agent-accent)_6%');
    expect(plain.className).not.toContain('var(--agent-surface-nested)');
    // hairline 边框随 --color-border 深档自派生（组同构 color-mix 配方，CN-V-08）
    expect(plain.className).toContain('var(--color-border)');

    cleanup();
    seedGraph([agentNode({ groupId: GROUP_NODE_ID }), ...THREE_MEMBERS()]);
    renderNode();
    const nested = surfaceOf();
    if (nested === null) throw new Error('nested container surface not rendered');
    expect(nested.className).toContain('var(--agent-surface-nested)');
    expect(nested.className).not.toContain('var(--agent-accent)_6%');
  });
});

describe('Agent 容器折叠卡', () => {
  // @spec: AG-CT-005
  it('折叠卡与组折叠卡同构：展开钮 + 标题 + model_id 截断 + 成员计数徽章；无背板无副行', () => {
    seedGraph([agentNode({ collapsed: true }), ...THREE_MEMBERS()]);
    renderNode();

    const root = rootNode();
    expect(root.getAttribute('data-agent-form')).toBe('collapsed');
    expect(surfaceOf()).toBeNull();
    expect(cardSurfaceOf()).toBeNull();
    expect(sublineOf()).toBeNull();
    expect(screen.getByTitle('展开容器')).not.toBeNull();
    expect(root.textContent).toContain('夜景改造');
    expect(root.querySelector('.font-mono')?.textContent).toBe('my-llm');
    expect(screen.queryByTestId('agent-node-member-count')).toHaveTextContent('3');
  });

  // @spec: AG-CT-005
  it('点击展开钮回落容器形态（折叠/展开走组同一 toggleGroupCollapse 机制）', () => {
    seedGraph([agentNode({ collapsed: true }), ...THREE_MEMBERS()]);
    renderNode();

    fireEvent.click(screen.getByTitle('展开容器'));

    expect(rootNode().getAttribute('data-agent-form')).toBe('container');
    expect(surfaceOf()).not.toBeNull();
    const node = useCanvasStore
      .getState()
      .nodeGraph?.nodes.find((candidate) => candidate.id === AGENT_NODE_ID);
    expect((node?.data as AgentNodeData | undefined)?.collapsed).not.toBe(true);
  });

  // @spec: AG-NP-005
  it('折叠但零成员：徽章不显示（零值不是信息）', () => {
    seedGraph([agentNode({ collapsed: true })]);
    renderNode();
    expect(screen.queryByTestId('agent-node-member-count')).toBeNull();
  });
});

describe('Agent 容器 LOD 投影', () => {
  // @spec: AG-CT-005
  it('折叠态屏幕尺寸 <80px 降级为锚点，锚点 title 带「标题 · N」', () => {
    seedGraph([agentNode({ collapsed: true }), ...THREE_MEMBERS()]);
    renderNode({ width: 50, height: 50 });

    const anchor = document.querySelector('[data-agent-node][role="button"]');
    if (!(anchor instanceof HTMLElement)) throw new Error('lod anchor not rendered');
    expect(anchor.title).toContain('夜景改造 · 3');
    expect(screen.queryByTestId('agent-node-member-count')).toBeNull();
  });

  // @spec: AG-CT-005
  it('展开态屏幕尺寸 <120px 显示定位气泡，气泡文字带「标题 · N」', () => {
    seedGraph([agentNode(), ...THREE_MEMBERS()]);
    renderNode({ width: 240, height: 100 });

    const bubble = Array.from(document.querySelectorAll('button')).find(
      (candidate) => (candidate.textContent ?? '').includes('夜景改造 · 3'),
    );
    expect(bubble).toBeDefined();
  });
});
