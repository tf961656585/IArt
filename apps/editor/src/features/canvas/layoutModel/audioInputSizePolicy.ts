/**
 * 音频输入节点尺寸策略（Layout-Model-Driven 唯一口径）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md「计算分层」
 * spec: docs/runtime/画布节点尺寸管理架构.md「禁止事项」（禁止渲染层 CSS 私造口径、
 * 禁止节点内容区以内部滚动兜底内容溢出）
 *
 * 职责：把音频节点的内容状态（音频区固定高度 + 分段数 + 编辑按钮）派生为外壳尺寸。
 * 公式与常量由 @iart/utils/canvas-geometry 承载，本模块只保留 Layout Model 的入口导出
 * （`computeAudioInputSize` 分派点见 computeLayoutModel.ts）；渲染层不得复现本策略。
 *
 * 分段列表**全量渲染不做内部滚动**（spec 变更收口）：分段列表高度按分段数线性
 * 派生，内容溢出语义为撑高节点外壳。
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
 * chrome 由调用方按节点类型传入（audioInput 真实值 {26, 26}：border 1px ×2 + p-3 12px ×2）。
 */

import { computeCanvasAudioNodeSize } from "@iart/utils/canvas-geometry";
import type { ChromeOverhead } from "./chromeConstants";
import type { NodeSize } from "../types/node";

/**
 * 音频区高度、宽度下限、分段行高与内容块间距。
 *
 * 数值由 @iart/utils/canvas-geometry 承载并与其渲染实现对齐；修改数值必须同步更新测试锚点。
 */
export {
  AUDIO_AREA_HEIGHT,
  AUDIO_MIN_WIDTH,
  SEGMENT_HEADER_HEIGHT,
  SEGMENT_ROW_HEIGHT,
  SEGMENT_GAP_Y,
  SEGMENT_LIST_MARGIN_TOP,
  AUDIO_EDIT_BUTTON_HEIGHT,
  AUDIO_CONTENT_GAP_Y,
} from "@iart/utils/canvas-geometry";

/**
 * 音频内容区固有最小宽度（px）。
 *
 * 音频节点内容无刚性固有宽度：播放控件 `w-full` 自适应、分段名 `truncate`、
 * 时间范围短、编辑按钮 `w-full`。宽度下限由 AUDIO_MIN_WIDTH 兜底。
 */
export const AUDIO_CONTENT_MIN_WIDTH = 0;

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
 * 约束：宽度 = max(AUDIO_MIN_WIDTH, chrome.overheadX + AUDIO_CONTENT_MIN_WIDTH)；
 * 高度按 chrome + 音频区 + 分段列表（条件）+ 编辑按钮（条件）+ 条件块间 gap 叠加，
 * 只许偏大不得偏小。纯函数。
 */
export function computeAudioInputSize(input: AudioInputSizeInput): NodeSize {
  const { chrome, segmentModeEnabled, segmentsCount, hasAudioUrl } = input;
  return computeCanvasAudioNodeSize({
    chrome,
    segmentModeEnabled,
    segmentsCount,
    hasAudioUrl,
  });
}
