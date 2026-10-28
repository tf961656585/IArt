import type { ProjectMediaAssets } from '@iart/contracts';

import type { GraphNode } from '../../types/node';
import {
  resolveReferenceCandidate,
  type ReferenceCandidate,
} from '@/features/promptdock/referenceOps';
import { resolveChromeSubject, type ChromeSubject, type ChromeMediaType } from './mediaNodeModel';

/**
 * 媒体节点选中态双层 chrome 的纯模型（设计层 prototypes/shared/node-chrome.js D17–D27）。
 *
 * 主体口径（D27）：导入素材节点与生成资产节点共用同一套 chrome，选区按「媒体主体」而非
 * 节点类型判定；差异只按来源分档——复用仅生成资产、替换仅本地导入（替换在节点 hover，
 * 不进 chrome）。
 *
 * 工具清单与分组是「真实 Editor 工具集事实」（D19/D20）：
 * - 图片：A 组直接变换（水平镜像/垂直镜像/旋转 90°）｜hairline｜B 组弹窗工具
 *   （裁剪/调整尺寸/分割/智能切图/扩图/边缘检测/色度抠图/差异抠图/画笔标注）；
 * - 视频：裁切视频 / 截取帧 / 序列帧图集；
 * - 音频：无注册媒体工具 → 顶栏不渲染（O1 如实呈现）。
 */

export type MediaChromeToolId =
  | 'mirrorX'
  | 'mirrorY'
  | 'rotate90'
  | 'crop'
  | 'resize'
  | 'split'
  | 'smartSplit'
  | 'outpaint'
  | 'edgeDetect'
  | 'chromaKey'
  | 'diffKey'
  | 'annotate'
  | 'trim'
  | 'frameCapture'
  | 'spriteSheet';

export type MediaChromeDirectToolId = 'mirrorX' | 'mirrorY' | 'rotate90';

/** 工具 id 是否为直接变换（注册表事实：direct 组仅此三值）。 */
export const isDirectToolId = (id: MediaChromeToolId): id is MediaChromeDirectToolId =>
  id === 'mirrorX' || id === 'mirrorY' || id === 'rotate90';

/** 直接变换（点即执行产出）与弹窗承载工具的判别联合（消费端按 kind 收窄，无需断言）。 */
export type MediaChromeToolBase = {
  label: string;
  icon:
    | 'flipH'
    | 'flipV'
    | 'rotate'
    | 'crop'
    | 'resize'
    | 'grid'
    | 'scissors'
    | 'outpaint'
    | 'borderOuter'
    | 'colorFilter'
    | 'contrast'
    | 'pencil'
    | 'photo';
};

export type MediaChromeDirectTool = MediaChromeToolBase & {
  id: MediaChromeDirectToolId;
  kind: 'direct';
};

export type MediaChromeDialogTool = MediaChromeToolBase & {
  id: Exclude<MediaChromeToolId, MediaChromeDirectToolId>;
  kind: 'dialog';
};

export type MediaChromeTool = MediaChromeDirectTool | MediaChromeDialogTool;

const IMAGE_DIRECT: readonly MediaChromeDirectTool[] = [
  { id: 'mirrorX', label: '水平镜像', icon: 'flipH', kind: 'direct' },
  { id: 'mirrorY', label: '垂直镜像', icon: 'flipV', kind: 'direct' },
  { id: 'rotate90', label: '旋转 90°', icon: 'rotate', kind: 'direct' },
];

const IMAGE_DIALOG: readonly MediaChromeDialogTool[] = [
  { id: 'crop', label: '裁剪图片', icon: 'crop', kind: 'dialog' },
  { id: 'resize', label: '调整尺寸', icon: 'resize', kind: 'dialog' },
  { id: 'split', label: '图片分割', icon: 'grid', kind: 'dialog' },
  { id: 'smartSplit', label: '智能切图', icon: 'scissors', kind: 'dialog' },
  // D20 去歧义：扩图用 arrows-diagonal（IconMaximize 与「放大预览」撞图标）
  { id: 'outpaint', label: '扩图', icon: 'outpaint', kind: 'dialog' },
  { id: 'edgeDetect', label: '边缘检测', icon: 'borderOuter', kind: 'dialog' },
  { id: 'chromaKey', label: '色度抠图', icon: 'colorFilter', kind: 'dialog' },
  { id: 'diffKey', label: '差异抠图', icon: 'contrast', kind: 'dialog' },
  { id: 'annotate', label: '画笔标注', icon: 'pencil', kind: 'dialog' },
];

const VIDEO_TOOLS: readonly MediaChromeDialogTool[] = [
  { id: 'trim', label: '裁切视频', icon: 'scissors', kind: 'dialog' },
  { id: 'frameCapture', label: '截取帧', icon: 'photo', kind: 'dialog' },
  { id: 'spriteSheet', label: '序列帧图集', icon: 'grid', kind: 'dialog' },
];

/** 顶栏工具分组：图片为 A｜sep｜B 两组；视频/音频为单组（无工具则不渲染顶栏）。 */
export const topToolGroupsFor = (mediaType: ChromeMediaType): MediaChromeTool[][] => {
  if (mediaType === 'image') return [[...IMAGE_DIRECT], [...IMAGE_DIALOG]];
  if (mediaType === 'video') return [[...VIDEO_TOOLS]];
  return [];
};

export type MediaChromeSelection = {
  /** 选中的媒体主体（保持 selectedNodeIds 顺序） */
  subjects: ChromeSubject[];
  /** 是否呈现 chrome：选中集非空且全部为媒体节点（素材节点与资产节点可混选） */
  active: boolean;
  multi: boolean;
  /** 单选时该媒体主体（多选为 null） */
  single: ChromeSubject | null;
};

/**
 * 选中集 → chrome 选择态：仅当全部选中对象都是媒体节点（资产节点或素材节点）时呈现。
 * 混选两类媒体节点仍呈现（早期按「全部为资产节点」判定会让混选整体消失）。
 */
export const resolveMediaChromeSelection = (
  selectedNodeIds: readonly string[],
  nodesById: ReadonlyMap<string, GraphNode>,
  mediaAssets: ProjectMediaAssets,
): MediaChromeSelection => {
  const subjects: ChromeSubject[] = [];
  let nonMedia = false;
  for (const id of selectedNodeIds) {
    const node = nodesById.get(id);
    if (!node) continue;
    const subject = resolveChromeSubject(node, mediaAssets);
    if (subject) {
      subjects.push(subject);
    } else {
      nonMedia = true;
    }
  }
  const active = subjects.length > 0 && !nonMedia;
  return {
    subjects: active ? subjects : [],
    active,
    multi: subjects.length > 1,
    single: subjects.length === 1 ? (subjects[0] ?? null) : null,
  };
};

export type BottomBarView = {
  /** 用作参考：toggle 目标态（当前选中是否全部已在参考区） */
  refsActive: boolean;
  /** 已在参考区的可加入项数 */
  inRefsCount: number;
  /** 「复用」可见性（D21：仅任务生成资产；多选隐藏） */
  showReuse: boolean;
  /** 参考动作可加入项数与跳过数（PD-MR-004 反馈用） */
  refCandidates: { subject: ChromeSubject; candidate: ReferenceCandidate }[];
};

export const buildBottomBarView = (params: {
  selection: MediaChromeSelection;
  referenceAssetIds: ReadonlySet<string>;
  mediaAssets: ProjectMediaAssets;
}): BottomBarView => {
  const { selection, referenceAssetIds, mediaAssets } = params;
  const refCandidates = selection.subjects.map((subject) => ({
    subject,
    candidate: resolveReferenceCandidate(subject.node, mediaAssets),
  }));
  const okCandidates = refCandidates.filter(
    (c): c is { subject: ChromeSubject; candidate: Extract<ReferenceCandidate, { ok: true }> } =>
      c.candidate.ok,
  );
  const inRefsCount = okCandidates.filter((c) =>
    referenceAssetIds.has(c.candidate.assetId),
  ).length;
  const refsActive = okCandidates.length > 0 && inRefsCount === okCandidates.length;
  const single = selection.single;
  return {
    refsActive,
    inRefsCount,
    showReuse:
      single !== null &&
      single.origin === 'generated' &&
      (single.sourceModelId !== '' || single.sourceTaskId !== ''),
    refCandidates,
  };
};
