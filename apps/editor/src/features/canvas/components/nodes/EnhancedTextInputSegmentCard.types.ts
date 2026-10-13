import type { RefObject } from 'react';

import type { PromptCollectionItem, TextInputSegment } from '../../types';
import type { AssetMentionCandidate } from '../../engine/promptAssetMentions';
import type { PromptTextSurface } from './shared/PromptPresetTokenEditor';

export interface EnhancedTextInputSegmentCardProps {
  /** 当前渲染的文本段 */
  segment: TextInputSegment;
  /** 段在列表中的序号（标题「段落 N」展示 + 上移禁用判断） */
  index: number;
  /** 段总数（下移禁用判断） */
  totalCount: number;
  /** 编辑锁定（任务提交/生成中）：禁用手柄与全部操作 */
  readOnly: boolean;
  /** 当前草稿文本（draftByLocalId[seg.id] ?? seg.text），由父组件按 id 管理 */
  draftText: string;
  promptPresetSnapshots: Record<string, PromptCollectionItem> | null | undefined;
  /** @ 资产引用 token 的显示派生表（见 PromptPresetTokenEditorProps.mentionDisplay） */
  mentionDisplay: ReadonlyMap<string, { label: string }> | null | undefined;
  /** 是否提供 @ 素材插入能力（父组件 useTextNodeMentionContext 派生） */
  mentionEnabled: boolean;
  /** @ 素材候选（父组件 useTextNodeMentionContext 注入，弹层不自行推导） */
  mentionCandidates: AssetMentionCandidate[];
  /** 下游提示长度上限反馈（null 表示不显示计数器） */
  promptLimit?: { max: number; current: number } | null | undefined;
  /**
   * 文本面 ref。父组件按段 id 缓存持有（surfaceRefByLocalIdRef），
   * 保证拖拽重排后 ref 仍按 id 命中而非按 index 错位。
   */
  surfaceRef: RefObject<PromptTextSurface | null>;

  onToggle: (id: string, enabled: boolean) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onDraftChange: (id: string, text: string) => void;
  onDraftChangeWithPromptPreset: (id: string, text: string, preset: PromptCollectionItem) => void;
  onFocus: (id: string) => void;
  onBlur: (id: string) => void;
  onCompositionStart: (id: string) => void;
  onCompositionEnd: (id: string) => void;
}
