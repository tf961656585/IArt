/**
 * chrome overhead 静态常数表（Layout-Model-Driven）。
 *
 * spec: docs/runtime/画布启动性能与Layout-Model架构.md
 *
 * 职责：替代启动期 DOM 实测路径（`getComputedStyle` / `getBoundingClientRect` /
 * ResizeObserver），按节点类型 + variant 查表返回 chrome overhead。
 *
 * 来源（迁移自分散的实测路径）：
 * - model 节点：静态估算值（18 / 54），曾对应 `ResultAreaContainer.tsx` 的
 *   `DEFAULT_CHROME_OVERHEAD_X/Y`（阶段 4 起该常量已删，runtime 期由 RO 实测经
 *   `commitResultAreaChromeMeasurement` 回流精化，本表仅承担启动期 / 实测未就绪时的回落）。
 *   含 embedded result area：card border 1px each side, contentArea p-2 (16/16) + header 36px。
 * - imageInput / videoInput：{0, 0}。noPadding 媒体卡片在 fill 模式下填满 wrapper，
 *   wrapper border-box = 卡片 border-box = `computeMediaDisplaySize` 输出；1px 边框在
 *   border-box 内不额外建模，无 chrome overhead。
 * - audioInput：{26, 26}。ContentNodeCard 常规模式（noPadding=false）：border 1px each side
 *   + contentArea p-3 (12/12)。audioInput 已改裁 layoutModel，由 `computeAudioInputSize`
 *   消费本 overhead（见 audioInputSizePolicy.ts）。
 * - 静态节点（textInput）：header 高度 32（textInput 仍走 static，不消费 chrome，
 *   该值为死值，保留待后续校准）。
 *
 * 本模块是阶段 1 编码起点。具体数值由阶段 5 漂移监控校准。
 *
 * 约束：
 * - 纯函数，无 DOM / window / Date.now / Math.random 访问。
 * - group 节点不通过 chromeConstants 查表（其尺寸由 `buildGroupDerivedSize` 派生，见
 *   computeLayoutModel 主函数）。
 */

import type { GraphNodeType } from "../types/node";

/**
 * chrome overhead：节点 chrome 几何常数（border + padding + header + footer）。
 */
export type ChromeOverhead = {
  overheadX: number;
  overheadY: number;
};

/**
 * chrome 常数表条目类型。
 *
 * variant 用于支持未来按 variant 分档（如 model 节点的 embedded result area variant）。
 * 当前实现全部节点都用 default 档；后续 variant 可作为 key 扩展。
 */
export type ChromeConstantsTable = Readonly<Record<GraphNodeType, ChromeOverhead>>;

/**
 * chrome 常数表（初值，由阶段 5 漂移监控校准）。
 *
 * 数值依据：
 * - 数值来源注释见文件顶部。
 * - group 节点不在表中查表，这里给一个 0 占位（computeLayoutModel 主函数显式跳过 group）。
 */
export const CHROME_CONSTANTS_TABLE: ChromeConstantsTable = {
  model: { overheadX: 18, overheadY: 54 },
  // imageInput / videoInput: noPadding 媒体卡片 fill 模式，wrapper = 卡片 border-box，
  // 媒体展示尺寸由 computeMediaDisplaySize 直接派生，无额外 chrome overhead。
  imageInput: { overheadX: 0, overheadY: 0 },
  videoInput: { overheadX: 0, overheadY: 0 },
  textInput: { overheadX: 16, overheadY: 32 },
  audioInput: { overheadX: 26, overheadY: 26 },
  // task 节点：header + 状态体 + 操作 footer 的 chrome 估算（启动期回落，runtime 期可实测精化）。
  task: { overheadX: 2, overheadY: 74 },
  // asset 节点：媒体卡片 fill 模式，wrapper = 卡片 border-box，无额外 chrome overhead。
  asset: { overheadX: 0, overheadY: 0 },
  // agent 节点（Agent 容器）：Layout Model 恒为静态 defaultSize（单节点形态 240×64），
  // 容器形态尺寸由 buildGroupDerivedSize 派生——两者都不消费本表 overhead
  //（条目仅为表完整性；数值 = 卡片 1px 边框 ×2）。
  agent: { overheadX: 2, overheadY: 2 },
  // group 节点尺寸由 buildGroupDerivedSize 派生，computeLayoutModel 不通过 chromeConstants 查 group。
  group: { overheadX: 0, overheadY: 0 },
};

/**
 * 默认 fallback（未知 variant / 未识别节点类型）。
 *
 * 与静态节点保持一致，作为兜底档。
 */
export const DEFAULT_CHROME_OVERHEAD: ChromeOverhead = { overheadX: 16, overheadY: 32 };

/**
 * 按节点类型 + variant 解析 chrome overhead。
 *
 * 纯函数：相同输入产出相同输出，无副作用。
 *
 * @param nodeType 节点类型（GraphNodeType）
 * @param _variant variant（当前未使用，预留扩展点；显式接收以便后续按 variant 分档）
 * @returns chrome overhead（overheadX / overheadY）
 */
export function resolveChromeOverhead(
  nodeType: GraphNodeType,
  _variant: string | undefined,
): ChromeOverhead {
  const entry = CHROME_CONSTANTS_TABLE[nodeType];
  if (entry === undefined || entry === null) {
    return DEFAULT_CHROME_OVERHEAD;
  }
  // 当前不按 variant 分档；variant 参数预留扩展点。
  return { overheadX: entry.overheadX, overheadY: entry.overheadY };
}
