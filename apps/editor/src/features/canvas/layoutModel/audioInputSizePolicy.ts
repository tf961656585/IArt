/**
 * 音频输入节点尺寸策略（Layout-Model-Driven 唯一口径）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md「计算分层」
 * spec: docs/runtime/画布节点尺寸管理架构.md「禁止事项」（禁止渲染层 CSS 私造口径、
 * 禁止节点内容区以内部滚动兜底内容溢出）
 *
 * 职责：把音频节点的内容状态（音频区固定高度 + 分段数 + 编辑按钮）按统一策略函数
 * 派生为外壳尺寸。本模块是 audioInput 尺寸策略的**单一事实源**，唯一消费者为
 * Layout Model（`computeAudioInputSize` 分派点，见 computeLayoutModel.ts）；
 * 渲染层不得复现本策略。
 *
 * 分段列表**全量渲染不做内部滚动**（spec 变更收口）：分段列表高度按分段数线性
 * 派生（`SEGMENT_LIST_MARGIN_TOP + SEGMENT_HEADER_HEIGHT + N*SEGMENT_ROW_HEIGHT
 * + (N-1)*SEGMENT_GAP_Y`），内容溢出语义为撑高节点外壳。
 *
 * 偏大方向（硬要求）：
 * - 连线态隐藏分段编辑按钮（AudioInputNode 渲染条件含 `!hasInputConnection`），
 *   但 Layout Model 读不到边，恒含编辑按钮高度 —— 只许偏大，不得偏小。
 * - 失败面板（taskInfo.status === 'failed'）是 runtime 态，Layout Model 无法预估
 *   （残余边界，见 spec「输入契约」结构性实测切片）；本策略不含失败面板高度。
 *
 * 纯函数约束（与 Layout Model 主函数一致）：
 * - 给定相同输入，输出确定（无 Date.now()、无 Math.random()、无 DOM 访问）。
 * - 不读取 ReactFlow store、不订阅 ResizeObserver。
 *
 * 常量数值对齐 AudioInputNode.tsx / SegmentList.tsx 的真实实现（阶段 2 已核对），
 * 修改数值必须同步更新测试锚点。
 */

import type { ChromeOverhead } from "./chromeConstants";
import type { NodeSize } from "../types/node";

/**
 * 音频播放区固定高度（px）。
 *
 * 对齐 AudioInputNode.tsx `AUDIO_AREA_HEIGHT = 64`（播放区 minHeight）。
 */
export const AUDIO_AREA_HEIGHT = 64;

/**
 * 音频节点宽度下限（px）。
 *
 * 对齐 AudioInputNode.tsx `MIN_WIDTH = 200`（ContentNodeCard minWidth）。
 */
export const AUDIO_MIN_WIDTH = 200;

/**
 * 音频内容区固有最小宽度（px）。
 *
 * 音频节点内容无刚性固有宽度：播放控件 `w-full` 自适应、分段名 `truncate`、
 * 时间范围短、编辑按钮 `w-full`。宽度下限由 AUDIO_MIN_WIDTH 兜底。
 */
export const AUDIO_CONTENT_MIN_WIDTH = 0;

/**
 * 分段列表头部行高（px）。
 *
 * 对齐 SegmentList.tsx 头部行（「编辑」按钮 `h-5` = 20）。
 */
export const SEGMENT_HEADER_HEIGHT = 20;

/**
 * 单段行高（px）。
 *
 * 对齐 SegmentList.tsx 行样式 `py-0.5 text-[11px]`：
 * text-[11px] 默认 line-height ≈ 16.5 + py-0.5 上下各 2px ≈ 20。
 */
export const SEGMENT_ROW_HEIGHT = 20;

/**
 * 段间垂直间距（px）。
 *
 * 对齐 SegmentList.tsx 列表容器 `space-y-0.5`（段与段之间 2px）。
 */
export const SEGMENT_GAP_Y = 2;

/**
 * 分段列表距上方内容区的外边距（px）。
 *
 * 对齐 SegmentList.tsx 根元素 `mt-2`（8px）。
 */
export const SEGMENT_LIST_MARGIN_TOP = 8;

/**
 * 分段编辑按钮高度（px，含上方外边距）。
 *
 * 对齐 AudioInputNode.tsx 编辑按钮 `h-7 mt-2`（28 + 8 = 36）。
 */
export const AUDIO_EDIT_BUTTON_HEIGHT = 36;

/**
 * 内容块间垂直间距（px）。
 *
 * 对齐 ContentNodeCard.tsx:383 内容区 `<div className="flex flex-col gap-2">`
 * （gap-2 = 8px），作用于内容直接子项之间（音频区 / SegmentList / 编辑按钮）。
 *
 * flex `gap` 与子项自带 margin-top 在 CSS 规范中叠加（flex 子项不折叠外边距），
 * 因此每渲染一个条件块（SegmentList `mt-2` / 编辑按钮 `mt-2`），其上方间距 =
 * gap-2(8) + mt-2(8) = 16px，其中 mt-2 已含在块自身高度常量内，此处补 gap-2 部分。
 */
export const AUDIO_CONTENT_GAP_Y = 8;

/**
 * audioInput 尺寸策略输入（归一化字段，由 computeLayoutModel 分派点从节点 data 提取）。
 */
export type AudioInputSizeInput = {
  /** ContentNodeCard chrome overhead（border 1px + p-3 padding 12px，见 chromeConstants.ts） */
  chrome: ChromeOverhead;
  /** 分段模式开关（data.segmentModeEnabled；false 时即使有分段也不渲染列表） */
  segmentModeEnabled: boolean;
  /** 分段数量（data.segments.length；<=0 视为无分段） */
  segmentsCount: number;
  /** 是否持有音频 URL（data.audioUrl 为非空字符串；连线态恒含编辑按钮高度的偏大依据） */
  hasAudioUrl: boolean;
};

/**
 * 计算 audioInput 节点的 Layout Model 尺寸。
 *
 * 公式（高度，各子块叠加）：
 * ```
 * gapCount   = (分段列表渲染 ? 1 : 0) + (编辑按钮渲染 ? 1 : 0)
 *              // 音频区恒在；每渲染一个条件块，其与前一 block 之间计 1 个 gap-2
 * gapHeight  = gapCount * AUDIO_CONTENT_GAP_Y
 * height = chrome.overheadY
 *        + AUDIO_AREA_HEIGHT                                    // 音频播放区固定高度
 *        + (segmentModeEnabled && N > 0
 *             ? SEGMENT_LIST_MARGIN_TOP + SEGMENT_HEADER_HEIGHT
 *               + N * SEGMENT_ROW_HEIGHT + (N-1) * SEGMENT_GAP_Y
 *             : 0)                                              // 分段列表（全量渲染，无内部滚动）
 *        + (hasAudioUrl ? AUDIO_EDIT_BUTTON_HEIGHT : 0)         // 分段编辑按钮（连线态隐藏但 LM 读不到边，恒含偏大）
 *        + gapHeight                                            // 内容块间 gap（flex gap 与块内 mt-2 叠加，偏大方向）
 * width  = max(AUDIO_MIN_WIDTH, chrome.overheadX + AUDIO_CONTENT_MIN_WIDTH)
 * ```
 *
 * 失败面板为 runtime 态（taskInfo 失败），LM 无法预估，为残余边界（不含在公式内）。
 * 偏大方向：gap 计入后各场景较旧公式高度 +8/+16，只许偏大，不得偏小。
 *
 * 纯函数。
 */
export function computeAudioInputSize(input: AudioInputSizeInput): NodeSize {
  const { chrome, segmentModeEnabled, segmentsCount, hasAudioUrl } = input;
  const safeCount =
    Number.isFinite(segmentsCount) && segmentsCount > 0 ? Math.round(segmentsCount) : 0;

  const segmentListHeight =
    segmentModeEnabled && safeCount > 0
      ? SEGMENT_LIST_MARGIN_TOP +
        SEGMENT_HEADER_HEIGHT +
        safeCount * SEGMENT_ROW_HEIGHT +
        Math.max(0, safeCount - 1) * SEGMENT_GAP_Y
      : 0;

  const editButtonHeight = hasAudioUrl ? AUDIO_EDIT_BUTTON_HEIGHT : 0;

  // 内容块之间各计 1 个 gap：音频区恒在（AUDIO_AREA_HEIGHT 已含）；SegmentList 与
  // 编辑按钮为条件渲染块，渲染时各自与前一 block 之间产生 1 个 gap-2。
  // flex gap 与块内自带 mt-2 叠加（不折叠），gap 在块自身高度（已含 mt-2）之外另计。
  const gapCount = (segmentListHeight > 0 ? 1 : 0) + (editButtonHeight > 0 ? 1 : 0);
  const gapHeight = gapCount * AUDIO_CONTENT_GAP_Y;

  const height =
    chrome.overheadY + AUDIO_AREA_HEIGHT + segmentListHeight + editButtonHeight + gapHeight;
  const width = Math.max(AUDIO_MIN_WIDTH, chrome.overheadX + AUDIO_CONTENT_MIN_WIDTH);
  return { width, height };
}
