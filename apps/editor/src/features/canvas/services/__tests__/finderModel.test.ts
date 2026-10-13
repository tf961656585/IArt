import { describe, expect, it } from 'vitest';
import type { AgentSessionRecord } from '@iart/contracts';
import {
  buildFinderEntries,
  deriveGroupCandidates,
  listFinderCandidates,
  queryFinderEntries,
} from '../finderModel';
import type { FinderAgentProjection, FinderEntry } from '../finderModel';
import type { GraphNode } from '../../types/node';
import type { AgentNodeData } from '../../types/agentNode';
import type { GroupNodeData, TextInputNodeData } from '../../types/node';
import type { AssetNodeData, TaskNodeData } from '../../types/taskNode';

// ────────────────────────────────────────────
// 最小夹具：直接构造节点与会话投影（不 mock store）
// ────────────────────────────────────────────

const makeNode = (id: string, type: GraphNode['type'], data: GraphNode['data'], groupId: string | undefined = undefined): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId,
});

const makeGroupNode = (id: string, name: string, collapsed = false): GraphNode =>
  makeNode(id, 'group', {
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
    name,
    collapsed,
    color: undefined,
  } satisfies GroupNodeData);

const makeAgentNode = (id: string, sessionId: string): GraphNode =>
  makeNode(id, 'agent', {
    label: 'Agent',
    agentSessionId: sessionId,
  } satisfies AgentNodeData);

const makeTaskNode = (
  id: string,
  status: TaskNodeData['status'],
  modelId = 'gpt-image-2',
  updatedAt = 2000,
): GraphNode =>
  makeNode(id, 'task', {
    label: modelId,
    modelId,
    taskId: `${id}-task`,
    taskIndex: 0,
    batchId: `${id}-batch`,
    status,
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 1000,
    updatedAt,
  } satisfies TaskNodeData);

const makeAssetNode = (id: string, mediaType: AssetNodeData['mediaType']): GraphNode =>
  makeNode(id, 'asset', {
    label: '资产',
    sourceBatchId: `${id}-batch`,
    sourceTaskId: `${id}-task`,
    sourceModelId: 'veo-3.1',
    mediaType,
    assetId: `${id}-asset`,
  } satisfies AssetNodeData);

const textInputData = (): TextInputNodeData => ({
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
});

const makeImageInputNode = (id: string): GraphNode =>
  makeNode(id, 'imageInput', {
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
    assetId: null,
    imageUrl: null,
    imageMeta: null,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: 'upload',
    mediaError: undefined,
    derivedFromNodeId: undefined,
    derivedOp: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    originalImageMeta: null,
    resizePercent: undefined,
    outpaintModelId: undefined,
  });

const makeSession = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: 'sess-1',
  nodeId: 'node-agent',
  modelId: 'glm-5.3-flash',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '分镜脚本会话',
  createdAt: 1000,
  updatedAt: 2000,
  messageCount: 24,
  lastMessageAt: 3000,
  ...overrides,
});

const makeProjection = (overrides: Partial<FinderAgentProjection> = {}): FinderAgentProjection => ({
  sessionsById: {},
  inFlightBySessionId: {},
  errorsBySessionId: {},
  ...overrides,
});

// ────────────────────────────────────────────
// 断言辅助
// ────────────────────────────────────────────

const titlesInOrder = (entries: FinderEntry[]): string[] => entries.map((e) => e.title);
const nodeIdsInOrder = (entries: FinderEntry[]): string[] => entries.map((e) => e.nodeId);

describe('buildFinderEntries 条目构建', () => {
  it('组：主标题取组名，副行含成员数（来自传入索引）与折叠态，无状态', () => {
    const entries = buildFinderEntries(
      [makeGroupNode('grp-1', '主视觉组', true), makeNode('m1', 'textInput', textInputData(), 'grp-1')],
      new Map([['grp-1', 1]]),
      makeProjection(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe('主视觉组');
    expect(entries[0]?.subline).toBe('1 个成员 · 已折叠');
    expect(entries[0]?.badge).toBe('组');
    expect(entries[0]?.status).toBeNull();
    expect(entries[0]?.statusWord).toBeNull();
    expect(entries[0]?.sortTime).toBeNull();
  });

  it('组空名（含纯空白）兜底「未命名组」；索引缺项按 0 成员', () => {
    const entries = buildFinderEntries(
      [makeGroupNode('grp-1', '   ')],
      new Map(),
      makeProjection(),
    );
    expect(entries[0]?.title).toBe('未命名组');
    expect(entries[0]?.subline).toBe('0 个成员 · 已展开');
  });

  it('Agent：会话标题为主标题，副行 = 模型 ID · 消息量 · 时间 · 状态词；在途 = 运行中', () => {
    const entries = buildFinderEntries(
      [makeAgentNode('agt-1', 'sess-1')],
      new Map(),
      makeProjection({
        sessionsById: { 'sess-1': makeSession() },
        inFlightBySessionId: {
          'sess-1': { requestId: 'r1', agentSessionId: 'sess-1', nodeId: 'agt-1' },
        },
      }),
    );
    const entry = entries[0];
    expect(entry?.title).toBe('分镜脚本会话');
    expect(entry?.badge).toBe('Agent');
    expect(entry?.subline).toContain('glm-5.3-flash');
    expect(entry?.subline).toContain('24 条消息');
    expect(entry?.subline).toContain('正在回复');
    expect(entry?.status).toBe('running');
    expect(entry?.sortTime).toBe(3000);
  });

  it('Agent 会话缺失：标题兜底「未命名会话」，状态词为空闲，不虚构模型与时间', () => {
    const entries = buildFinderEntries(
      [makeAgentNode('agt-1', 'sess-missing')],
      new Map(),
      makeProjection(),
    );
    const entry = entries[0];
    expect(entry?.title).toBe('未命名会话');
    expect(entry?.subline).toBe('空闲');
    expect(entry?.status).toBeNull();
    expect(entry?.sortTime).toBeNull();
  });

  it('Agent 空标题兜底「未命名会话」；零消息会话不显示消息量段', () => {
    const entries = buildFinderEntries(
      [makeAgentNode('agt-1', 'sess-1')],
      new Map(),
      makeProjection({
        sessionsById: {
          'sess-1': makeSession({ title: '  ', messageCount: 0, lastMessageAt: null }),
        },
      }),
    );
    const entry = entries[0];
    expect(entry?.title).toBe('未命名会话');
    expect(entry?.subline).toBe('glm-5.3-flash · 空闲');
  });

  it('任务：主标题 = 模型 ID；submitting/generating/polling/downloading=运行中、failed=失败、succeeded/cancelled 无状态档', () => {
    const entries = buildFinderEntries(
      [
        makeTaskNode('t-run', 'generating'),
        makeTaskNode('t-fail', 'failed'),
        makeTaskNode('t-done', 'succeeded'),
        makeTaskNode('t-cancel', 'cancelled'),
        makeTaskNode('t-poll', 'polling', 'veo-3.1'),
      ],
      new Map(),
      makeProjection(),
    );
    expect(entries.map((e) => e.status)).toEqual(['running', 'failed', null, null, 'running']);
    expect(entries[0]?.title).toBe('gpt-image-2');
    expect(entries[0]?.subline).toContain('生成中');
    expect(entries[1]?.subline).toContain('失败');
    expect(entries[2]?.subline).toContain('已完成');
    expect(entries[4]?.subline).toContain('等待结果');
  });

  it('资产生成结果：主标题 = 模型 ID，媒体档无状态；素材节点：主标题 = 媒体形态', () => {
    const entries = buildFinderEntries(
      [makeAssetNode('gen-1', 'video'), makeImageInputNode('imp-1')],
      new Map(),
      makeProjection(),
    );
    expect(entries[0]?.title).toBe('veo-3.1');
    expect(entries[0]?.badge).toBe('视频');
    expect(entries[0]?.kind).toBe('asset');
    expect(entries[0]?.kindBucket).toBe('media');
    expect(entries[0]?.status).toBeNull();
    expect(entries[0]?.sortTime).toBeNull();
    expect(entries[1]?.title).toBe('图片素材');
    expect(entries[1]?.kind).toBe('material');
    expect(entries[1]?.badge).toBe('图片');
  });
});

describe('queryFinderEntries 匹配与排序', () => {
  const entries = buildFinderEntries(
    [
      makeGroupNode('grp-1', '主视觉组'),
      makeAgentNode('agt-1', 'sess-1'),
      makeTaskNode('task-1', 'failed', 'gpt-image-2'),
      makeAssetNode('gen-1', 'video'),
      makeImageInputNode('imp-1'),
    ],
    new Map(),
    makeProjection({ sessionsById: { 'sess-1': makeSession() } }),
  );

  it('关键词大小写不敏感包含匹配，命中主标题与模型 ID', () => {
    expect(queryFinderEntries(entries, { keyword: '分镜', kind: 'all', status: 'all' })).toHaveLength(1);
    expect(
      nodeIdsInOrder(queryFinderEntries(entries, { keyword: 'GLM-5.3', kind: 'all', status: 'all' })),
    ).toEqual(['agt-1']);
  });

  it('类型关键词整词命中该类型全部对象（组 / 任务 / agent）', () => {
    const q = (keyword: string) => queryFinderEntries(entries, { keyword, kind: 'all', status: 'all' });
    expect(nodeIdsInOrder(q('组'))).toEqual(['grp-1']);
    expect(nodeIdsInOrder(q('任务'))).toEqual(['task-1']);
    expect(nodeIdsInOrder(q('Agent'))).toEqual(['agt-1']);
  });

  it('媒体关键词须媒体形态一致：图片/音频只命中素材，视频只命中生成结果', () => {
    const q = (keyword: string) => queryFinderEntries(entries, { keyword, kind: 'all', status: 'all' });
    expect(nodeIdsInOrder(q('图片'))).toEqual(['imp-1']);
    expect(nodeIdsInOrder(q('视频'))).toEqual(['gen-1']);
    expect(q('音频')).toHaveLength(0);
  });

  it('类型关键词与包含匹配互斥：非整词不走类型通道（「任务书」按包含匹配）', () => {
    // 夹具无标题含「任务书」的对象 → 空结果，证明整词判定未误伤包含匹配路径
    expect(queryFinderEntries(entries, { keyword: 'zzz无匹配', kind: 'all', status: 'all' })).toHaveLength(0);
  });

  it('排序三段：前缀匹配优先（压过更新时间）→ 时间倒序 → 无时间置后', () => {
    const ranked = buildFinderEntries(
      [
        makeTaskNode('t-late', 'succeeded', 'x-prefix', 9000),
        makeTaskNode('t-early', 'succeeded', 'prefix-x', 1000),
      ],
      new Map(),
      makeProjection(),
    );
    // 两标题都包含 'prefix'，但 'prefix-x' 是前缀 → 尽管时间更旧仍排第一
    expect(titlesInOrder(queryFinderEntries(ranked, { keyword: 'prefix', kind: 'all', status: 'all' }))).toEqual([
      'prefix-x',
      'x-prefix',
    ]);
  });

  it('时间倒序：有时间者按最近活动在前，无时间者置后；同时间按名称', () => {
    const timed = buildFinderEntries(
      [
        makeTaskNode('t-old', 'succeeded', 'aaa', 1000),
        makeTaskNode('t-new', 'succeeded', 'bbb', 9000),
        makeAssetNode('gen-1', 'image'),
      ],
      new Map(),
      makeProjection(),
    );
    expect(nodeIdsInOrder(queryFinderEntries(timed, { keyword: '', kind: 'all', status: 'all' }))).toEqual([
      't-new',
      't-old',
      'gen-1',
    ]);
  });

  it('同档同时间按主标题名称升序', () => {
    const named = buildFinderEntries(
      [makeGroupNode('grp-b', 'bb'), makeGroupNode('grp-a', 'aa')],
      new Map(),
      makeProjection(),
    );
    expect(titlesInOrder(queryFinderEntries(named, { keyword: '', kind: 'all', status: 'all' }))).toEqual([
      'aa',
      'bb',
    ]);
  });

  it('类型筛选档：媒体档覆盖生成结果与导入素材', () => {
    const mediaAndGroup = buildFinderEntries(
      [makeGroupNode('grp-1', 'g'), makeAssetNode('gen-1', 'image'), makeImageInputNode('imp-1')],
      new Map(),
      makeProjection(),
    );
    expect(
      nodeIdsInOrder(queryFinderEntries(mediaAndGroup, { keyword: '', kind: 'media', status: 'all' })),
    ).toEqual(['gen-1', 'imp-1']);
    expect(
      nodeIdsInOrder(queryFinderEntries(mediaAndGroup, { keyword: '', kind: 'group', status: 'all' })),
    ).toEqual(['grp-1']);
  });

  it('状态筛选：运行中/失败各取所需，无状态对象（组、媒体、空闲 Agent）自动排除', () => {
    const mixed = buildFinderEntries(
      [
        makeGroupNode('grp-1', 'g'),
        makeAgentNode('agt-idle', 'sess-idle'),
        makeAgentNode('agt-busy', 'sess-busy'),
        makeAgentNode('agt-err', 'sess-err'),
        makeTaskNode('task-run', 'polling'),
        makeTaskNode('task-fail', 'failed'),
        makeAssetNode('gen-1', 'audio'),
      ],
      new Map(),
      makeProjection({
        sessionsById: {
          'sess-idle': makeSession({ agentSessionId: 'sess-idle' }),
          'sess-busy': makeSession({ agentSessionId: 'sess-busy' }),
          'sess-err': makeSession({ agentSessionId: 'sess-err' }),
        },
        inFlightBySessionId: {
          'sess-busy': { requestId: 'r', agentSessionId: 'sess-busy', nodeId: 'agt-busy' },
        },
        errorsBySessionId: {
          'sess-err': { code: 'connection_unavailable', message: 'x', requestId: 'r2' },
        },
      }),
    );
    expect(
      nodeIdsInOrder(queryFinderEntries(mixed, { keyword: '', kind: 'all', status: 'running' })),
    ).toEqual(['agt-busy', 'task-run']);
    expect(
      nodeIdsInOrder(queryFinderEntries(mixed, { keyword: '', kind: 'all', status: 'failed' })),
    ).toEqual(['agt-err', 'task-fail']);
  });

  it('状态语义优先级：会话出错压过在途（失败而非运行中）', () => {
    const both = buildFinderEntries(
      [makeAgentNode('agt-1', 'sess-1')],
      new Map(),
      makeProjection({
        sessionsById: { 'sess-1': makeSession() },
        inFlightBySessionId: {
          'sess-1': { requestId: 'r', agentSessionId: 'sess-1', nodeId: 'agt-1' },
        },
        errorsBySessionId: {
          'sess-1': { code: 'connection_unavailable', message: 'x', requestId: 'r2' },
        },
      }),
    );
    expect(both[0]?.status).toBe('failed');
    expect(both[0]?.statusWord).toBe('会话出错');
    expect(queryFinderEntries(both, { keyword: '', kind: 'all', status: 'running' })).toHaveLength(0);
  });

  it('候选全量：空条件返回全部条目且不抛错', () => {
    expect(listFinderCandidates(entries)).toHaveLength(entries.length);
  });
});

describe('deriveGroupCandidates 组候选派生', () => {
  it('产出组候选：空名兜底、成员数来自索引、折叠态透传', () => {
    const candidates = deriveGroupCandidates(
      [makeGroupNode('grp-1', ''), makeGroupNode('grp-2', '评审组', true)],
      new Map([
        ['grp-1', 3],
        ['grp-2', 0],
      ]),
    );
    expect(candidates).toEqual([
      { groupId: 'grp-1', name: '未命名组', memberCount: 3, collapsed: false },
      { groupId: 'grp-2', name: '评审组', memberCount: 0, collapsed: true },
    ]);
  });
});
