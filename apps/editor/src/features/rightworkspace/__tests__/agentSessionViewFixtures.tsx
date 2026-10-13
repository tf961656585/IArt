import type { AgentMessageRecord, AgentSendRecord, AgentSessionRecord, MediaAsset } from '@iart/contracts';
import type { AgentToolCallLive } from '@/features/agent/agentSessionState';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { GraphNode } from '@/features/canvas/types/node';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';

/**
 * 会话视图测试共用的种子数据与 store 播种器（会话视图用例与媒体统一件用例共用；
 * 非测试文件——文件名不在 vitest include 的 *.test.* / *.spec.* 口径内）。
 *
 * 播种器直接写两个 store 的状态（会话/消息/流式/在途/活跃态与画布资产注册表），
 * 让用例只声明「这一屏有什么」，不重复铺陈投影链路。
 */

export const sessionRecord = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: 'sess_1',
  nodeId: 'node_1',
  modelId: 'my-llm',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '画一只在雨中弹吉他的柴犬',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_600_000,
  messageCount: 2,
  // 最近一次对话时间（= assistantMessage.createdAt）；配置变更不影响这一口径
  lastMessageAt: 1_770_000_600_000,
  ...overrides,
});

export const userMessage: AgentMessageRecord = {
  agentSessionId: 'sess_1',
  seq: 1,
  role: 'user',
  requestId: 'req_1',
  body: { kind: 'chat', content: '画一只在雨中弹吉他的柴犬' },
  plan: null,
  createdAt: 1_770_000_000_000,
  isPartial: false,
};

export const assistantMessage: AgentMessageRecord = {
  agentSessionId: 'sess_1',
  seq: 2,
  role: 'assistant',
  requestId: 'req_1',
  body: { kind: 'chat', content: '好的，我先理一下步骤。' },
  plan: null,
  createdAt: 1_770_000_600_000,
  isPartial: false,
};

export const toolCallMessage: AgentMessageRecord = {
  agentSessionId: 'sess_1',
  seq: 3,
  role: 'assistant',
  requestId: 'req_1',
  body: {
    kind: 'tool_call',
    toolCallId: 'call_1',
    toolName: 'generate_image',
    toolKind: 'generation',
    modelId: 'gpt-image-2',
    argsJson: '{"prompt":"一只柴犬","reference_asset_ids":["asset_ref_1"]}',
  },
  plan: null,
  createdAt: 1_770_000_700_000,
  isPartial: false,
};

export const toolResultMessage: AgentMessageRecord = {
  agentSessionId: 'sess_1',
  seq: 4,
  role: 'assistant',
  requestId: 'req_1',
  body: {
    kind: 'tool_result',
    toolCallId: 'call_1',
    toolName: 'generate_image',
    status: 'succeeded',
    summary: '已生成 1 张图片',
    assetIds: ['asset_1'],
    errorSummary: null,
  },
  plan: null,
  createdAt: 1_770_000_800_000,
  isPartial: false,
};

/** 同轮第二条提案（整轮驳回用例：同一批待决提案不止一条）。 */
export const secondToolCallMessage: AgentMessageRecord = {
  agentSessionId: 'sess_1',
  seq: 5,
  role: 'assistant',
  requestId: 'req_1',
  body: {
    kind: 'tool_call',
    toolCallId: 'call_2',
    toolName: 'generate_video',
    toolKind: 'generation',
    modelId: 'gpt-image-2',
    argsJson: '{"prompt":"一段雨中等车的镜头"}',
  },
  plan: null,
  createdAt: 1_770_000_720_000,
  isPartial: false,
};

export const toolCallLive = (params: {
  toolCallId: string;
  status: AgentToolCallLive['status'];
  /** 所属请求；默认对齐 seed 的在途轮次（req_2），提案面板按它取数。 */
  requestId?: string;
  proposalExpiresAt?: number | null;
  argsJson?: string;
  toolName?: string;
  modelId?: string | null;
}): AgentToolCallLive => ({
  toolCallId: params.toolCallId,
  requestId: params.requestId ?? 'req_2',
  toolName: params.toolName ?? 'generate_image',
  toolKind: 'generation',
  modelId: params.modelId === undefined ? 'gpt-image-2' : params.modelId,
  argsJson: params.argsJson ?? '{"prompt":"一只柴犬"}',
  status: params.status,
  proposalExpiresAt: params.proposalExpiresAt ?? null,
});

export const canvasAsset = {
  id: 'asset_1',
  mediaType: 'image' as const,
  original: {
    url: 'local-media://project/original.png',
    projectRef: null,
    fileKey: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: null,
    width: 800,
    height: 600,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: 'local-media://project/thumb.png',
    mimeType: 'image/png',
    width: 160,
    height: 120,
    status: 'ready' as const,
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 0, updatedAt: 0 },
};

/** 视频产物：缩略图未 ready（海报帧走类型占位）、带真实时长。 */
export const videoAsset = {
  id: 'asset_video',
  mediaType: 'video' as const,
  original: {
    url: 'local-media://project/clip.mp4',
    projectRef: null,
    fileKey: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: 'video/mp4',
    sizeBytes: null,
    width: 1280,
    height: 720,
    durationMs: 4200,
    fps: null,
  },
  thumbnail: {
    url: null,
    mimeType: null,
    width: null,
    height: null,
    status: 'missing' as const,
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 0, updatedAt: 0 },
};

/** 音频产物：时长未知（音频条显示 --:--）。 */
export const audioAsset = {
  id: 'asset_audio',
  mediaType: 'audio' as const,
  original: {
    url: 'local-media://project/voice.mp3',
    projectRef: null,
    fileKey: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: 'audio/mpeg',
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: null,
    mimeType: null,
    width: null,
    height: null,
    status: 'missing' as const,
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 0, updatedAt: 0 },
};

export const mediaAssetNode = (
  id: string,
  label: string,
  assetId: string,
  mediaType: 'image' | 'video' | 'audio',
): GraphNode => ({
  id,
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label,
    sourceBatchId: 'batch_1',
    sourceTaskId: 'task_1',
    sourceModelId: 'gpt-image-2',
    mediaType,
    assetId,
  } satisfies AssetNodeData,
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

export const canvasAssetNode: GraphNode = mediaAssetNode('node_asset_1', '柴犬雨中.png', 'asset_1', 'image');

export const seedCanvas = (
  params: {
    withAsset?: boolean;
    withNode?: boolean;
    withVideoAsset?: boolean;
    withVideoNode?: boolean;
    withAudioAsset?: boolean;
    withAudioNode?: boolean;
  } = {},
): void => {
  const graph = createNodeGraph({
    name: '画板',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  const mediaAssets = {
    ...(params.withAsset ? { asset_1: canvasAsset } : {}),
    ...(params.withVideoAsset ? { asset_video: videoAsset } : {}),
    ...(params.withAudioAsset ? { asset_audio: audioAsset } : {}),
  };
  const nodes = [
    ...(params.withNode ? [canvasAssetNode] : []),
    ...(params.withVideoNode
      ? [mediaAssetNode('node_asset_video', '雨中等车.mp4', 'asset_video', 'video')]
      : []),
    ...(params.withAudioNode
      ? [mediaAssetNode('node_asset_audio', '旁白.mp3', 'asset_audio', 'audio')]
      : []),
  ];
  useCanvasStore.setState({
    mediaAssets,
    nodeGraph: nodes.length > 0 ? { ...graph, nodes } : graph,
  });
};

/**
 * 图片资产工厂（相册用例：一次调用多图 / 多次调用各有产物），比例 800×600。
 */
export const imageAsset = (assetId: string): MediaAsset => ({
  id: assetId,
  mediaType: 'image',
  original: {
    url: `local-media://project/${assetId}.png`,
    projectRef: null,
    fileKey: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: null,
    width: 800,
    height: 600,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: `local-media://project/${assetId}-thumb.png`,
    mimeType: 'image/png',
    width: 160,
    height: 120,
    status: 'ready',
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 0, updatedAt: 0 },
});

/**
 * 批量播种图片资产与其画布资产节点（相册用例：「用作参考」出口需要画布上的持有节点，
 * 等宽高比走 imageAsset 的 800×600）。
 */
export const seedImageAssets = (assetIds: readonly string[]): void => {
  const graph = createNodeGraph({
    name: '画板',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  useCanvasStore.setState({
    mediaAssets: Object.fromEntries(assetIds.map((assetId) => [assetId, imageAsset(assetId)])),
    nodeGraph: {
      ...graph,
      nodes: assetIds.map((assetId) =>
        mediaAssetNode(`node_${assetId}`, `${assetId}.png`, assetId, 'image'),
      ),
    },
  });
};

/** 图片生成调用消息工厂（相册用例：连续同名调用序列的每次调用 = 一条 tool_call）。 */
export const generateImageCall = (params: {
  toolCallId: string;
  seq: number;
  prompt: string;
  referenceAssetIds?: readonly string[];
  createdAt?: number;
}): AgentMessageRecord => ({
  ...toolCallMessage,
  seq: params.seq,
  createdAt: params.createdAt ?? 1_770_000_700_000 + params.seq,
  body: {
    kind: 'tool_call',
    toolCallId: params.toolCallId,
    toolName: 'generate_image',
    toolKind: 'generation',
    modelId: 'gpt-image-2',
    argsJson: JSON.stringify({
      prompt: params.prompt,
      ...(params.referenceAssetIds === undefined
        ? {}
        : { reference_asset_ids: [...params.referenceAssetIds] }),
    }),
  },
});

/** 图片生成结果消息工厂（相册用例：调用的终态 + 产物）。 */
export const generateImageResult = (params: {
  toolCallId: string;
  seq: number;
  assetIds?: readonly string[];
  status?: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  summary?: string;
  errorSummary?: string | null;
  createdAt?: number;
}): AgentMessageRecord => {
  const status = params.status ?? 'succeeded';
  return {
    ...toolResultMessage,
    seq: params.seq,
    createdAt: params.createdAt ?? 1_770_000_700_000 + params.seq,
    body: {
      kind: 'tool_result',
      toolCallId: params.toolCallId,
      toolName: 'generate_image',
      status,
      summary: params.summary ?? '已生成 1 张图片',
      assetIds: [...(params.assetIds ?? [])],
      errorSummary: params.errorSummary ?? null,
    },
  };
};

export const seed = (params: {
  session: AgentSessionRecord | null;
  messages?: AgentMessageRecord[];
  streaming?: string;
  inFlight?: boolean;
  /** 是否已完成按需读取（false = 读取中，用于加载态用例） */
  messagesLoaded?: boolean;
  /** 读取失败标记（用于读取失败态用例） */
  messagesLoadFailed?: boolean;
  /** 本地发送留痕（用于留痕渲染用例） */
  sendRecords?: AgentSendRecord[];
  /** 工具调用活跃态（按 toolCallId） */
  toolCallLive?: Record<string, AgentToolCallLive>;
  error?: { code: 'execution_failed' | 'model_unavailable' | 'cancelled'; message: string } | null;
}) => {
  const session = params.session;
  useAgentSessionStore.setState({
    sessionsById: session === null ? {} : { [session.agentSessionId]: session },
    sessionIdByNodeId: session === null ? {} : { [session.nodeId]: session.agentSessionId },
    messagesBySessionId:
      session === null ? {} : { [session.agentSessionId]: params.messages ?? [] },
    messagesLoadedSessionIds:
      session === null || params.messagesLoaded === false
        ? {}
        : { [session.agentSessionId]: true },
    messagesLoadFailedSessionIds:
      session === null || params.messagesLoadFailed !== true
        ? {}
        : { [session.agentSessionId]: true },
    sendRecordsBySessionId:
      session === null || params.sendRecords === undefined
        ? {}
        : { [session.agentSessionId]: params.sendRecords },
    streamingBySessionId:
      session === null ? {} : { [session.agentSessionId]: params.streaming ?? '' },
    inFlightBySessionId:
      session === null || params.inFlight !== true
        ? {}
        : {
            [session.agentSessionId]: {
              requestId: 'req_2',
              agentSessionId: session.agentSessionId,
              nodeId: session.nodeId,
            },
          },
    toolCallsLiveBySessionId:
      session === null || params.toolCallLive === undefined
        ? {}
        : { [session.agentSessionId]: params.toolCallLive },
    errorsBySessionId:
      session === null || params.error === null || params.error === undefined
        ? {}
        : {
            [session.agentSessionId]: {
              code: params.error.code,
              message: params.error.message,
              requestId: 'req_2',
            },
          },
  });
};

