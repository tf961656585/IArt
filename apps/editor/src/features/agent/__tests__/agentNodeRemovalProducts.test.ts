import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentAccepted,
  AgentComplete,
  AgentError,
  AgentMessageAppendParams,
  AgentMessageRecord,
  AgentSendRecord,
  AgentSessionRecord,
  AgentSubmitPrompt,
  AgentToken,
  RuntimeMediaAssetView,
  RuntimeTaskOutputView,
  TaskStateNotification,
} from '@iart/contracts';
import { AGENT_TASK_LINEAGE_METADATA_KEY } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { unregisterNodeRemovalPreflight } from '@/features/canvas/store/internal/nodeRemovalPreflight';
import { applyTaskStateChanged } from '@/features/promptdock/projection/taskProjectionService';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { AssetNodeData, GraphNode, NodePosition } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';

/**
 * 删除 Agent 节点不级联删产物（spec docs/agent/02「撤销重做与删除」/「产物资产节点与血缘归属」、
 * spec docs/agent/04「血缘与画布投影」AG-NP-004）。
 *
 * 覆盖：产物资产节点由 agent 派生产物投影真实创建并自动包含为 Agent 容器成员（锚定 Agent
 * 节点聚拢落位），随后经画布删除咽喉删除 Agent 节点（触发会话级联删除、执行解散）——
 * 产物资产节点与产物资产记录保留、仍可被引用。
 *
 * 宿主搭建：画布 store 用真实实例（删除走真实咽喉与真实组展开），agent 侧只挡掉
 * 存储与 socket 两个最外层依赖（沿用 agentNodeRemoval.test.ts 的挡法）。
 */

type SocketHandlers = {
  onAccepted: (message: AgentAccepted) => void;
  onToken: (message: AgentToken) => void;
  onComplete: (message: AgentComplete) => void;
  onError: (message: AgentError) => void;
};

const GRAPH_ID = 'graph-agent-removal-products';
const AGENT_SESSION_ID = 'sess-1';

const h = vi.hoisted(() => {
  const storage = {
    readAgentSessions: vi.fn<(projectPath: string) => Promise<AgentSessionRecord[]>>(),
    readAgentSessionByNodeId:
      vi.fn<(projectPath: string, nodeId: string) => Promise<AgentSessionRecord | null>>(),
    upsertAgentSession:
      vi.fn<(projectPath: string, session: AgentSessionRecord) => Promise<AgentSessionRecord>>(),
    readAgentMessages:
      vi.fn<(projectPath: string, agentSessionId: string) => Promise<AgentMessageRecord[]>>(),
    appendAgentMessage:
      vi.fn<
        (projectPath: string, message: AgentMessageAppendParams) => Promise<AgentMessageRecord>
      >(),
    appendAgentSendRecord:
      vi.fn<(projectPath: string, sendRecord: AgentSendRecord) => Promise<AgentSendRecord>>(),
    readAgentSendRecords:
      vi.fn<(projectPath: string, agentSessionId: string) => Promise<AgentSendRecord[]>>(),
  };
  const socket = {
    subscribe: vi.fn<(handlers: SocketHandlers) => () => void>(() => () => undefined),
    sendSubmitPrompt: vi.fn<(message: AgentSubmitPrompt) => void>(),
    sendCancel:
      vi.fn<(message: { type: string; agentSessionId: string; requestId: string }) => void>(),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(),
  };
  return { storage, socket };
});

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => '/proj',
  getRuntimeProjectRef: () => 'project-a',
  getRuntimeBackendBaseUrl: () => null,
}));

vi.mock('../agentSessionStorage', () => ({
  agentSessionStorage: h.storage,
  readAgentSessions: h.storage.readAgentSessions,
  readAgentSessionByNodeId: h.storage.readAgentSessionByNodeId,
  upsertAgentSession: h.storage.upsertAgentSession,
  readAgentMessages: h.storage.readAgentMessages,
  appendAgentMessage: h.storage.appendAgentMessage,
  appendAgentSendRecord: h.storage.appendAgentSendRecord,
  readAgentSendRecords: h.storage.readAgentSendRecords,
}));

vi.mock('../agentSocket', () => ({
  agentSocket: h.socket,
  AgentSocketClient: class {},
  isAgentWsMessageType: () => true,
}));

import {
  ensureAgentNodeRemovalPreflightRegistered,
  loadAgentSessions,
  useAgentSessionStore,
} from '../agentSessionStore';

const agentSessionRecord = (nodeId: string): AgentSessionRecord => ({
  agentSessionId: AGENT_SESSION_ID,
  nodeId,
  modelId: 'llm-fast-1',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '会话标题',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3,
  lastMessageAt: 2,
});

const mediaAssetView = (assetId: string): RuntimeMediaAssetView => ({
  assetId,
  mediaType: 'image',
  original: {
    url: `local-media://project-a/images/${assetId}.png`,
    sourceFileName: null,
    projectRef: 'project-a',
    fileKey: `images/${assetId}.png`,
    sourceUrl: `https://remote.example/${assetId}.png`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: `local-media://project-a/thumbs/${assetId}.png`,
    mimeType: 'image/png',
    width: 200,
    height: 150,
    status: 'ready',
    generatedAt: 1,
    error: null,
  },
  lifecycle: { createdAt: 1, updatedAt: 1 },
});

const outputRow = (taskId: string, assetId: string): RuntimeTaskOutputView => ({
  outputId: `out-${assetId}`,
  taskId,
  mediaType: 'image',
  assetId,
  textValue: null,
  sortOrder: 0,
});

const agentDerivedSucceededNotification = (params: {
  taskId: string;
  assetId: string;
}): TaskStateNotification => ({
  type: 'task:state-changed',
  projectPath: '/proj',
  task: {
    taskId: params.taskId,
    status: 'succeeded',
    projectPath: '/proj',
    batchId: 'batch-agent-1',
    metadata: {
      modelId: 'gpt-image-2',
      [AGENT_TASK_LINEAGE_METADATA_KEY]: {
        agentSessionId: AGENT_SESSION_ID,
        toolCallId: 'call-1',
      },
    },
    createdAt: 1,
    updatedAt: 2,
  },
  outputs: [outputRow(params.taskId, params.assetId)],
  mediaAssets: [mediaAssetView(params.assetId)],
});

/** 建图并创建 Agent 节点（节点 id 由注册表生成，会话记录按实际 id 落库）。 */
const setupGraph = (agentPosition: NodePosition): string => {
  const graph = createNodeGraph(createTestNodeGraphParams('agent-removal-products'));
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
  const agentNode = useCanvasStore
    .getState()
    .addNode('agent', agentPosition, { agentSessionId: AGENT_SESSION_ID });
  if (!agentNode) throw new Error('Agent 节点创建失败');
  return agentNode.id;
};

const findAssetNode = (assetId: string): GraphNode<AssetNodeData> | undefined =>
  useCanvasStore
    .getState()
    .nodeGraph?.nodes.find(
      (node) => node.type === 'asset' && (node.data as AssetNodeData).assetId === assetId,
    ) as GraphNode<AssetNodeData> | undefined;

const isClusteredAround = (position: NodePosition, anchor: NodePosition): boolean =>
  Math.abs(position.x - anchor.x) <= 2 * (ASSET_NODE_DEFAULT_SIZE.width + 40) &&
  Math.abs(position.y - anchor.y) <= 2 * (ASSET_NODE_DEFAULT_SIZE.height + 40);

beforeEach(() => {
  vi.clearAllMocks();
  unregisterNodeRemovalPreflight();
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
  });
  useAgentSessionStore.getState().reset();

  h.storage.readAgentSessions.mockResolvedValue([]);
  h.storage.readAgentSessionByNodeId.mockResolvedValue(null);
  h.storage.readAgentMessages.mockResolvedValue([]);
  h.storage.readAgentSendRecords.mockResolvedValue([]);
});

describe('删除 Agent 节点：产物资产节点与记录保留', () => {
  // @spec: AG-NP-004
  it('删除 Agent 节点（级联会话数据）：产物资产节点与资产记录保留', async () => {
    const agentPosition = { x: 900, y: 500 };
    const agentNodeId = setupGraph(agentPosition);
    h.storage.readAgentSessions.mockResolvedValue([agentSessionRecord(agentNodeId)]);
    await loadAgentSessions('/proj');
    ensureAgentNodeRemovalPreflightRegistered();
    expect(useAgentSessionStore.getState().sessionsById[AGENT_SESSION_ID]).toBeTruthy();

    // 产物落画布：真实投影链路（agent 派生产物锚定 Agent 节点聚拢落位，自动包含为容器成员）
    applyTaskStateChanged(
      agentDerivedSucceededNotification({ taskId: 'task-agent-1', assetId: 'asset-p1' }),
    );
    applyTaskStateChanged(
      agentDerivedSucceededNotification({ taskId: 'task-agent-2', assetId: 'asset-p2' }),
    );
    const productBefore = findAssetNode('asset-p1');
    expect(productBefore).toBeTruthy();
    if (!productBefore) throw new Error('产物资产节点未落画布');
    expect(isClusteredAround(productBefore.position, agentPosition)).toBe(true);
    // 自动包含：产物创建即入 Agent 容器（AG-CT-001 默认初值）
    expect(productBefore.groupId).toBe(agentNodeId);
    const recordsBefore = Object.keys(useCanvasStore.getState().mediaAssets);
    expect(recordsBefore).toContain('asset-p1');

    // 删除 Agent 节点：级联删除会话数据（咽喉 → agent 域前置钩子）
    useCanvasStore.getState().removeNodes([agentNodeId], { deleteGroupMembers: true });

    // 会话数据随节点级联消失
    const agentState = useAgentSessionStore.getState();
    expect(agentState.sessionsById[AGENT_SESSION_ID]).toBeUndefined();
    expect(agentState.sessionIdByNodeId[agentNodeId]).toBeUndefined();
    expect(useCanvasStore.getState().nodeGraph?.nodes.some((n) => n.id === agentNodeId)).toBe(
      false,
    );

    // 产物资产节点保留（含位置与溯源字段），产物资产记录保留
    const productAfter = findAssetNode('asset-p1');
    expect(productAfter).toBeTruthy();
    expect(productAfter?.position).toEqual(productBefore.position);
    expect(productAfter?.data).toMatchObject({ assetId: 'asset-p1', sourceTaskId: 'task-agent-1' });
    expect(findAssetNode('asset-p2')).toBeTruthy();
    expect(Object.keys(useCanvasStore.getState().mediaAssets)).toEqual(
      expect.arrayContaining(['asset-p1', 'asset-p2']),
    );
  });
});
