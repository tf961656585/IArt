'use client';

import { useMemo } from 'react';
import type { AssetMentionCandidate } from '../../../engine/promptAssetMentions';

const EMPTY_CANDIDATES: AssetMentionCandidate[] = [];
const EMPTY_DISPLAY: ReadonlyMap<string, { label: string }> = new Map();

/**
 * 文本输入节点「@ 上下文」hook（Todo 6 模型节点退役迁移）。
 *
 * 旧语义是「文本节点 → @能力模型节点」的连线提及；模型节点已退出画布（打开阶段拒绝旧
 * 数据），因此文本节点不再存在 @ 能力消费节点，本 hook 固定返回禁用空态。
 * @ 资产提及的现役承载已迁到 PromptDock 参考区（features/promptdock）。
 */

export const useTextNodeMentionContext = (
  _textNodeId: string | null | undefined,
): {
  mentionEnabled: boolean;
  candidates: AssetMentionCandidate[];
  mentionDisplay: ReadonlyMap<string, { label: string }>;
} => {
  const mentionEnabled = false;
  const candidates = useMemo(() => EMPTY_CANDIDATES, []);
  const mentionDisplay = useMemo(() => EMPTY_DISPLAY, []);

  return {
    mentionEnabled,
    candidates,
    mentionDisplay,
  };
};
