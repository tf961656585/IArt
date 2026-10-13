/**
 * prompt 内联 @ 资产引用 token 字面量契约（spec：docs/editor/prompt内联交互.md）。
 *
 * 承载形态：prompt 文本中的锚点以 `[[@asset:<assetId>]]` token 存储（镜像 [[pp:]] 范式），
 * assetId 为被引用资产的身份。
 *
 * 本模块只承载 token 的字面量形态与解析结果类型，供 token 编辑器 DOM 层与编辑面共用；
 * 编号派生、候选集合与提交期替换已随旧连线模型退场，不再由本模块承载。
 */

export type MentionMediaKind = "image" | "video" | "audio";

/** `[[@asset:<assetId>]]` 字面量（与 token 编辑器 DOM 序列化同一形态）。 */
export const assetMentionTokenOf = (assetId: string): string =>
  `[[@asset:${assetId}]]`;

/**
 * asset token 匹配 pattern（不含正则标志位），供本模块与 token 编辑器 DOM 层
 * 组合正则时共用同一形态，禁止两处各写字面量。
 */
export const ASSET_MENTION_TOKEN_PATTERN = String.raw`\[\[@asset:([^\]]+)\]\]`;

export type AssetMentionCandidate = {
  /** 被引用资产的身份 */
  assetId: string;
  /** 编辑面显示编号（Image1/Video1/Audio1） */
  label: string;
  mediaKind: MentionMediaKind;
  /** 组内序号（0-based） */
  index: number;
};
