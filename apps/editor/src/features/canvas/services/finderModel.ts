/**
 * 画布对象查找引擎（纯函数域）。
 *
 * 对应设计稿 docs/editor/画布对象查找-design.md §3「对象范围与匹配」与已评审原型
 * prototypes/canvas-object-finder/finder-model.js：条目构建（组 / Agent / 任务 /
 * 资产 / 导入素材）、匹配（大小写不敏感包含 + 类型关键词）、排序（前缀优先 →
 * 最近活动倒序 → 名称）、筛选（类型 × 状态叠加）与组候选派生（供「加入组」弹层
 * 复用为单一事实源）。
 *
 * 本域无状态：全部函数吃普通数据（节点数组 + 会话投影 + 容器成员计数索引），
 * 返回新数组；不 import React、不 import store（仅类型引用）。成员计数一律来自
 * 传入索引（设计稿 D7，禁全图扫描）；时间展示经共享工具 shared/utils/time
 * （北京时间口径），真实数据无时间的对象不虚构时间；原型里为演示虚构的
 * 相对时间字段（「N 分钟前」）不照搬。
 *
 * 范围（设计稿 D1 / §3.1）：组、Agent、任务、媒体（生成结果与导入素材）。
 * 文本素材节点（textInput）与已退役 model 节点不进查找。
 */

import type { AgentSessionRecord } from '@iart/contracts';
import type { AgentInFlightRequest, AgentSessionError } from '../../agent/agentSessionState';
import type { AgentNodeData } from '../types/agentNode';
import type { GraphNode, GroupNodeData } from '../types/node';
import type { AssetNodeData, TaskNodeData, TaskNodeStatus } from '../types/taskNode';
import type { ContainerMemberCountIndex } from '../store/internal/containerMemberIndex';
import { getTaskStatusLabel } from '../utils/taskStatusMeta';
import { formatBeijingShortDateTime } from '@/shared/utils/time';

// ────────────────────────────────────────────
// 对外类型（查找条目 / 查询条件 / 组候选）
// ────────────────────────────────────────────

/** 查找条目类型（细粒度）：asset = 生成结果媒体，material = 导入素材。 */
export type FinderEntryKind = 'group' | 'agent' | 'task' | 'asset' | 'material';

/** 类型筛选档（设计稿 §3.2）：媒体档覆盖生成结果与导入素材。 */
export type FinderKindBucket = 'group' | 'agent' | 'task' | 'media';

/** 类型筛选输入：全部 | 类型档。 */
export type FinderKindFilter = 'all' | FinderKindBucket;

/** 状态筛选输入：全部 | 运行中 | 失败。 */
export type FinderStatusFilter = 'all' | 'running' | 'failed';

/** 运行状态档；null = 无状态（组与媒体，状态筛选时排除）。 */
export type FinderStatusBucket = 'running' | 'failed' | null;

/** 媒体形态（§5 用户所见形态：图片 / 视频 / 音频）。 */
export type FinderMediaForm = 'image' | 'video' | 'audio';

/**
 * Agent 会话投影（store 形状的只读快照）。
 * 由后续 hooks 从 agentSessionStore 的 sessionsById / inFlightBySessionId /
 * errorsBySessionId 取出后传入；本域不触 store。
 */
export type FinderAgentProjection = {
  /** 会话记录（按会话 id）；Agent 节点 data 只持 agentSessionId 稳定引用 */
  sessionsById: Readonly<Record<string, AgentSessionRecord>>;
  /** 在途请求表（按会话 id）；键存在即会话在途 */
  inFlightBySessionId: Readonly<Record<string, AgentInFlightRequest>>;
  /** 会话错误表（按会话 id）；键存在即会话出错 */
  errorsBySessionId: Readonly<Record<string, AgentSessionError>>;
};

/** 查找条目（展示就绪的快照，查询纯函数的输入与输出元素）。 */
export type FinderEntry = {
  /** 稳定对象身份 = 节点 id（定位提交用它） */
  nodeId: string;
  /** 细粒度类型（asset = 生成结果，material = 导入素材） */
  kind: FinderEntryKind;
  /** 类型筛选档（media 覆盖 asset 与 material） */
  kindBucket: FinderKindBucket;
  /** 类型徽章文本（§5 类型标签：组 / Agent / 任务 / 图片 / 视频 / 音频） */
  badge: string;
  /** 主标题（无名称者按 D5/D6 兜底，不返回空串、不虚构名字） */
  title: string;
  /** 副行文本（逐类型组装；真实数据无时间者不虚构时间段） */
  subline: string;
  /** 匹配键集合（已小写归一：主标题；Agent 另含模型 ID） */
  matchKeys: readonly string[];
  /** 排序时间（epoch ms）；null = 无时间（排序置后） */
  sortTime: number | null;
  /** 媒体形态；非媒体对象为 null（类型关键词匹配用） */
  mediaForm: FinderMediaForm | null;
  /** 运行状态档；null = 无状态（组与媒体） */
  status: FinderStatusBucket;
  /** 展示状态词（§5：正在回复 / 空闲 / 任务状态词 / 会话出错）；无状态对象为 null */
  statusWord: string | null;
};

/** 查询条件（视图态，不持久化、不进跨进程契约）。 */
export type FinderQuery = {
  keyword: string;
  kind: FinderKindFilter;
  status: FinderStatusFilter;
};

/** 组候选（groupId / name / memberCount / collapsed）。 */
export type FinderGroupCandidate = {
  groupId: string;
  /** 组显示名；空名兜底「未命名组」 */
  name: string;
  /** 成员数（来自传入的容器成员计数索引，不扫描全图） */
  memberCount: number;
  collapsed: boolean;
};

// ────────────────────────────────────────────
// 常量与展示词
// ────────────────────────────────────────────

const UNNAMED_GROUP_TITLE = '未命名组';
const UNNAMED_SESSION_TITLE = '未命名会话';
const UNNAMED_TITLE = '未命名';

/** Agent 展示状态词（§5：正在回复 / 空闲；出错会话标失败语义）。 */
const AGENT_STATUS_WORD = {
  error: '会话出错',
  replying: '正在回复',
  idle: '空闲',
} as const;

/** 媒体形态徽章 / 副行词（§5 类型标签：媒体节点按用户所见形态标注）。 */
const MEDIA_FORM_LABEL: Record<FinderMediaForm, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

/** 导入素材主标题（D6：无名称 → 媒体形态，不虚构名字）。 */
const MEDIA_FORM_TITLE: Record<FinderMediaForm, string> = {
  image: '图片素材',
  video: '视频素材',
  audio: '音频素材',
};

/** 任务「运行中」档状态集合（本地终态 succeeded / failed / cancelled 不入档）。 */
const TASK_RUNNING_STATUSES: Record<TaskNodeStatus, true | undefined> = {
  submitting: true,
  generating: true,
  polling: true,
  downloading: true,
  succeeded: undefined,
  failed: undefined,
  cancelled: undefined,
};

/**
 * 类型关键词（原型 TYPE_KEYWORDS 同口径）：整词命中该类型全部对象；
 * 媒体关键词还须媒体形态一致。大小写不敏感。
 */
const TYPE_KEYWORDS: ReadonlyArray<{
  keyword: string;
  kind: FinderKindBucket;
  mediaForm: FinderMediaForm | null;
}> = [
  { keyword: 'agent', kind: 'agent', mediaForm: null },
  { keyword: '组', kind: 'group', mediaForm: null },
  { keyword: '任务', kind: 'task', mediaForm: null },
  { keyword: '媒体', kind: 'media', mediaForm: null },
  { keyword: '图片', kind: 'media', mediaForm: 'image' },
  { keyword: '视频', kind: 'media', mediaForm: 'video' },
  { keyword: '音频', kind: 'media', mediaForm: 'audio' },
];

// ────────────────────────────────────────────
// 内部工具
// ────────────────────────────────────────────

/** 副行拼接：过滤空段后以「 · 」相连（无时间的段不进副行）。 */
const joinSubline = (parts: readonly string[]): string =>
  parts.filter((part) => part.length > 0).join(' · ');

const toDisplayTitle = (raw: string | null | undefined, fallback: string): string => {
  const trimmed = raw === null || raw === undefined ? '' : raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

// ────────────────────────────────────────────
// 条目构建
// ────────────────────────────────────────────

/**
 * 从画布节点数组 + 会话投影 + 容器成员计数索引构建查找条目。
 * 输出顺序 = 节点输入顺序（排序归查询）；范围外节点（textInput / model）跳过。
 */
export const buildFinderEntries = (
  nodes: ReadonlyArray<GraphNode>,
  memberCountIndex: ContainerMemberCountIndex,
  agentProjection: FinderAgentProjection,
): FinderEntry[] => {
  const entries: FinderEntry[] = [];
  for (const node of nodes) {
    const entry = buildEntryOfNode(node, memberCountIndex, agentProjection);
    if (entry !== null) entries.push(entry);
  }
  return entries;
};

const buildEntryOfNode = (
  node: GraphNode,
  memberCountIndex: ContainerMemberCountIndex,
  agentProjection: FinderAgentProjection,
): FinderEntry | null => {
  switch (node.type) {
    case 'group': {
      // node.data 是 GraphNodeData 联合；type==='group' 不能自动收窄 data，
      // 显式断言为 GroupNodeData（与画布节点组件既有写法同款，运行时安全）
      const data = node.data as GroupNodeData;
      const title = toDisplayTitle(data.name, UNNAMED_GROUP_TITLE);
      const memberCount = memberCountIndex.get(node.id) ?? 0;
      return {
        nodeId: node.id,
        kind: 'group',
        kindBucket: 'group',
        badge: '组',
        title,
        subline: `${memberCount} 个成员 · ${data.collapsed ? '已折叠' : '已展开'}`,
        matchKeys: [title.toLowerCase()],
        sortTime: null,
        mediaForm: null,
        status: null,
        statusWord: null,
      };
    }
    case 'agent': {
      const data = node.data as AgentNodeData;
      const sessionId = data.agentSessionId;
      const session = agentProjection.sessionsById[sessionId];
      const hasError = sessionId in agentProjection.errorsBySessionId;
      const inFlight = sessionId in agentProjection.inFlightBySessionId;
      // 状态语义：失败 = 会话出错（优先）；运行中 = 在途；空闲不进运行状态档
      const status: FinderStatusBucket = hasError ? 'failed' : inFlight ? 'running' : null;
      const statusWord = hasError
        ? AGENT_STATUS_WORD.error
        : inFlight
          ? AGENT_STATUS_WORD.replying
          : AGENT_STATUS_WORD.idle;
      const title = toDisplayTitle(session?.title, UNNAMED_SESSION_TITLE);
      const modelId = session !== undefined && session.modelId.length > 0 ? session.modelId : '';
      const lastMessageAt = session !== undefined ? session.lastMessageAt : null;
      const matchKeys = [title.toLowerCase()];
      if (modelId.length > 0) matchKeys.push(modelId.toLowerCase());
      return {
        nodeId: node.id,
        kind: 'agent',
        kindBucket: 'agent',
        badge: 'Agent',
        title,
        subline: joinSubline([
          modelId,
          session !== undefined && session.messageCount > 0 ? `${session.messageCount} 条消息` : '',
          lastMessageAt !== null ? formatBeijingShortDateTime(lastMessageAt) : '',
          statusWord,
        ]),
        matchKeys,
        sortTime: lastMessageAt,
        mediaForm: null,
        status,
        statusWord,
      };
    }
    case 'task': {
      const data = node.data as TaskNodeData;
      const title = toDisplayTitle(data.modelId, UNNAMED_TITLE);
      // 展示状态词复用现役任务状态文案（含 submitting 按 progressPhase 细分）
      const statusWord = getTaskStatusLabel(data.status, data.progressPhase) ?? '';
      const status: FinderStatusBucket = data.status === 'failed'
        ? 'failed'
        : TASK_RUNNING_STATUSES[data.status] === true
          ? 'running'
          : null;
      return {
        nodeId: node.id,
        kind: 'task',
        kindBucket: 'task',
        badge: '任务',
        title,
        subline: joinSubline([statusWord, formatBeijingShortDateTime(data.updatedAt)]),
        matchKeys: [title.toLowerCase()],
        sortTime: data.updatedAt,
        mediaForm: null,
        status,
        statusWord: statusWord.length > 0 ? statusWord : null,
      };
    }
    case 'asset': {
      const data = node.data as AssetNodeData;
      const form = data.mediaType;
      const title = toDisplayTitle(data.sourceModelId, UNNAMED_TITLE);
      // 资产节点数据无时间字段：副行只给媒体形态，不虚构时间
      return {
        nodeId: node.id,
        kind: 'asset',
        kindBucket: 'media',
        badge: MEDIA_FORM_LABEL[form],
        title,
        subline: MEDIA_FORM_LABEL[form],
        matchKeys: [title.toLowerCase()],
        sortTime: null,
        mediaForm: form,
        status: null,
        statusWord: null,
      };
    }
    case 'imageInput':
    case 'videoInput':
    case 'audioInput': {
      const form: FinderMediaForm =
        node.type === 'imageInput' ? 'image' : node.type === 'videoInput' ? 'video' : 'audio';
      return {
        nodeId: node.id,
        kind: 'material',
        kindBucket: 'media',
        badge: MEDIA_FORM_LABEL[form],
        title: MEDIA_FORM_TITLE[form],
        subline: MEDIA_FORM_LABEL[form],
        matchKeys: [MEDIA_FORM_TITLE[form].toLowerCase()],
        sortTime: null,
        mediaForm: form,
        status: null,
        statusWord: null,
      };
    }
    default:
      // 文本素材与已退役 model 节点不在查找范围（设计稿 D1 / 契约 data 联合）
      return null;
  }
};

// ────────────────────────────────────────────
// 查询（匹配 + 两类筛选 + 排序）
// ────────────────────────────────────────────

/**
 * 查询主入口：keyword + 类型档 + 状态档 → 排序后的条目数组（纯函数）。
 *
 * - keyword：大小写不敏感包含匹配（匹配键 = 主标题；Agent 另含模型 ID）；
 *   类型关键词（agent / 组 / 任务 / 媒体 / 图片 / 视频 / 音频）整词命中该类型
 *   全部对象（媒体关键词还须媒体形态一致），优先于包含匹配。
 * - 筛选叠加：类型档收窄类型面，状态档排除无状态对象（组与媒体）。
 * - 排序：前缀匹配优先 → 最近活动时间倒序（无时间者置后）→ 主标题名称。
 */
export const queryFinderEntries = (
  entries: ReadonlyArray<FinderEntry>,
  query: FinderQuery,
): FinderEntry[] => {
  const keyword = query.keyword.trim().toLowerCase();
  const keywordType =
    keyword.length > 0 ? (TYPE_KEYWORDS.find((t) => t.keyword === keyword) ?? null) : null;

  let matched = entries.filter((entry) => {
    if (query.kind !== 'all' && entry.kindBucket !== query.kind) return false;
    if (keywordType !== null) {
      if (entry.kindBucket !== keywordType.kind) return false;
      if (keywordType.mediaForm !== null && entry.mediaForm !== keywordType.mediaForm) return false;
      return true;
    }
    if (keyword.length === 0) return true;
    return entry.matchKeys.some((key) => key.includes(keyword));
  });

  // 状态筛选：无状态对象（status 为 null）自动排除
  if (query.status !== 'all') {
    const wanted = query.status;
    matched = matched.filter((entry) => entry.status === wanted);
  }

  const rankOf = (entry: FinderEntry): [number, number, string] => {
    const titleLower = entry.title.toLowerCase();
    const prefix = keyword.length > 0 && keywordType === null && titleLower.startsWith(keyword) ? 0 : 1;
    const time = entry.sortTime ?? -1;
    return [prefix, time, titleLower];
  };

  return [...matched].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return rb[1] - ra[1];
    return ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0;
  });
};

/** 候选全量（下拉打开即列全部可查对象；空画布判定由调用方以条目数为准）。 */
export const listFinderCandidates = (entries: ReadonlyArray<FinderEntry>): FinderEntry[] =>
  queryFinderEntries(entries, { keyword: '', kind: 'all', status: 'all' });

// ────────────────────────────────────────────
// 组候选派生
// ────────────────────────────────────────────

/**
 * 组候选派生（供「加入组」弹层复用）。
 * 成员数来自传入的容器成员计数索引（D7：禁全图扫描）；索引缺项按 0。
 */
export const deriveGroupCandidates = (
  nodes: ReadonlyArray<GraphNode>,
  memberCountIndex: ContainerMemberCountIndex,
): FinderGroupCandidate[] => {
  const candidates: FinderGroupCandidate[] = [];
  for (const node of nodes) {
    if (node.type !== 'group') continue;
    const data = node.data as GroupNodeData;
    candidates.push({
      groupId: node.id,
      name: toDisplayTitle(data.name, UNNAMED_GROUP_TITLE),
      memberCount: memberCountIndex.get(node.id) ?? 0,
      collapsed: data.collapsed === true,
    });
  }
  return candidates;
};
