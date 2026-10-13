/**
 * 工具条目的共享展示口径（状态词 / 状态色调 / 工具名文案 / 参数解析）。
 *
 * 单一口径：会话流工具条目卡（AgentSessionToolActivity）、工具结果媒体
 * （AgentSessionMedia）与批量审批面板（AgentToolProposalPanel）都消费这里，
 * 面板不再从消息组件里反向取内部导出（原先的跨文件耦合已消除）。
 */

import type { AgentToolCallRecord } from '@iart/contracts';

const TOOL_LABEL: Record<string, string> = {
  generate_image: '生成图像',
  generate_video: '生成视频',
  crop_image: '裁剪图片',
  resize_image: '缩放图片',
  chroma_key_image: '图片抠像',
  smart_split_image: '智能分割',
  trim_video: '截取视频片段',
  make_video_spritesheet: '生成序列帧图集',
  extract_video_frames: '抽取视频帧',
};

/** 未登记工具名的可见回落：不把 `generate_image` 这类内部工具名印给用户（原名进日志）。 */
const UNKNOWN_TOOL_LABEL = '未知操作';

export const toolLabel = (toolName: string): string => {
  const label = TOOL_LABEL[toolName];
  if (label !== undefined) return label;
  console.debug('[agentSession] unknown tool name: no user-facing label', { toolName });
  return UNKNOWN_TOOL_LABEL;
};

/** 工具调用状态 → 用户可见状态词（工具条目卡与批量审批面板共用，单一口径）。 */
export const TOOL_STATUS_LABEL: Record<AgentToolCallRecord['status'], string> = {
  proposed: '等待确认',
  dispatching: '正在启动…',
  running: '正在执行…',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  // 未勾选 / 整轮驳回 / 超时未决共用同一结算呈现：说「未执行」，不说「已跳过」（一个字面两处指代）。
  skipped: '未执行',
};

/**
 * 状态词文字色（两主题 token 对卡底 ≥3:1，见 globals.css 语义状态色）。
 * 状态只由状态词与呼吸点表达，条目卡不再有左侧状态色条（批次 C 去 folder 化）。
 */
export const TOOL_STATUS_TONE: Record<AgentToolCallRecord['status'], string> = {
  proposed: 'text-foreground',
  dispatching: 'text-foreground',
  running: 'text-foreground',
  succeeded: 'text-(--st-succeeded)',
  failed: 'text-(--st-failed-text)',
  cancelled: 'text-(--st-failed-text)',
  skipped: 'text-muted-foreground',
};

/** 生成中档（状态词前带呼吸点、条目卡状态词走生成中色调）。 */
export const isToolStatusGenerating = (status: AgentToolCallRecord['status']): boolean =>
  status === 'dispatching' || status === 'running';

/**
 * 工具 argsJson 的展示字段（读真实参数名：生成工具注册表为 prompt / reference_asset_ids）。
 * 解析失败或形状不符按「无该字段」收敛，不臆造。
 */
export type ToolArgsShape = {
  prompt?: unknown;
  reference_asset_ids?: unknown;
  /** 目标生成模型的任务数；工具注册表未声明该字段，缺失按「无该字段」收敛（不是常量 1）。 */
  task_count?: unknown;
};

export const parseToolArgs = (
  argsJson: string,
): { prompt: string | null; referenceAssetIds: string[]; taskCount: number | null } => {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { prompt: null, referenceAssetIds: [], taskCount: null };
    }
    const record = parsed as ToolArgsShape;
    const prompt = typeof record.prompt === 'string' && record.prompt.trim() ? record.prompt : null;
    const rawIds = record.reference_asset_ids;
    const referenceAssetIds = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === 'string')
      : [];
    const rawCount = record.task_count;
    const taskCount =
      typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount > 0 ? rawCount : null;
    return { prompt, referenceAssetIds, taskCount };
  } catch {
    return { prompt: null, referenceAssetIds: [], taskCount: null };
  }
};
