import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../../../types/node';
import type { AssetNodeData } from '../../../types/taskNode';
import type { AudioInputNodeData, ImageInputNodeData, VideoInputNodeData } from '../../../types/nodeDataTypes';
import {
  buildBottomBarView,
  resolveMediaChromeSelection,
  topToolGroupsFor,
} from '../chromeModel';
import { resolveChromeSubject } from '../mediaNodeModel';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';

const assetNode = (id: string, overrides: Partial<AssetNodeData> = {}): GraphNode => ({
  id,
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label: `资产 ${id}`,
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: 'image',
    assetId: `asset-${id}`,
    ...overrides,
  } as AssetNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const imageInputNode = (id: string, overrides: Partial<ImageInputNodeData> = {}): GraphNode => ({
  id,
  type: 'imageInput',
  position: { x: 0, y: 0 },
  data: {
    label: `图片素材 ${id}`,
    assetId: `asset-${id}`,
    imageUrl: `/local/${id}.png`,
    imageMeta: null,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: 'upload',
    mediaError: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    ...overrides,
  } as ImageInputNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const videoInputNode = (id: string, overrides: Partial<VideoInputNodeData> = {}): GraphNode => ({
  id,
  type: 'videoInput',
  position: { x: 0, y: 0 },
  data: {
    label: `视频素材 ${id}`,
    assetId: `asset-${id}`,
    videoUrl: `/local/${id}.mp4`,
    videoMeta: null,
    valueSource: 'upload',
    mediaError: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    ...overrides,
  } as VideoInputNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const audioInputNode = (id: string): GraphNode => ({
  id,
  type: 'audioInput',
  position: { x: 0, y: 0 },
  data: {
    label: `音频素材 ${id}`,
    assetId: `asset-${id}`,
    audioUrl: `/local/${id}.mp3`,
    valueSource: 'upload',
    mediaError: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    duration: 3,
    segments: undefined,
    segmentModeEnabled: false,
  } as AudioInputNodeData,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const taskNode = (id: string): GraphNode => ({
  ...assetNode(id),
  type: 'task',
});

const asMap = (nodes: GraphNode[]) =>
  new Map(nodes.map((n) => [n.id, n] as const));

const mediaAssets = createMediaAssetMapFixture([
  createMediaAssetFixture({ id: 'asset-a1' }),
  createMediaAssetFixture({ id: 'asset-a2', mediaType: 'video' }),
  createMediaAssetFixture({ id: 'asset-a3', mediaType: 'audio' }),
  createMediaAssetFixture({ id: 'asset-i1' }),
  createMediaAssetFixture({ id: 'asset-i2' }),
  createMediaAssetFixture({ id: 'asset-v1', mediaType: 'video' }),
]);

describe('topToolGroupsFor（D19 图片 12 工具 / 视频 3 工具 / 音频无顶栏）', () => {
  it('图片顶栏 = A 组 3 直接变换 + B 组 9 弹窗工具，共 12（D19）', () => {
    const groups = topToolGroupsFor('image');
    expect(groups).toHaveLength(2);
    const [direct, dialog] = groups;
    expect(direct?.map((t) => t.id)).toEqual(['mirrorX', 'mirrorY', 'rotate90']);
    expect(dialog?.map((t) => t.id)).toEqual([
      'crop',
      'resize',
      'split',
      'smartSplit',
      'outpaint',
      'edgeDetect',
      'chromaKey',
      'diffKey',
      'annotate',
    ]);
    expect(direct?.every((t) => t.kind === 'direct')).toBe(true);
    expect(dialog?.every((t) => t.kind === 'dialog')).toBe(true);
  });

  it('视频顶栏 = 3 工具单组；音频无顶栏（O1 如实呈现）', () => {
    expect(topToolGroupsFor('video')[0]?.map((t) => t.id)).toEqual([
      'trim',
      'frameCapture',
      'spriteSheet',
    ]);
    expect(topToolGroupsFor('video')).toHaveLength(1);
    expect(topToolGroupsFor('audio')).toEqual([]);
  });

  it('扩图图标走 outpaint（arrows-diagonal，D20 去歧义不撞放大预览）', () => {
    const imageTools = topToolGroupsFor('image').flat();
    expect(imageTools.find((t) => t.id === 'outpaint')?.icon).toBe('outpaint');
    expect(imageTools.find((t) => t.id === 'outpaint')?.label).toBe('扩图');
  });
});

describe('resolveChromeSubject（节点家族 → 统一媒体主体）', () => {
  it('导入图片素材与资产节点投影出同一形状，来源分档不同', () => {
    const asset = resolveChromeSubject(assetNode('a1'), mediaAssets);
    const imported = resolveChromeSubject(imageInputNode('i1'), mediaAssets);
    expect(asset).not.toBeNull();
    expect(imported).not.toBeNull();
    expect(asset?.mediaType).toBe('image');
    expect(imported?.mediaType).toBe('image');
    expect(asset?.origin).toBe('generated');
    expect(imported?.origin).toBe('imported');
    expect(asset?.available).toBe(true);
    expect(imported?.available).toBe(true);
    expect(imported?.sourceUrl).toBe(mediaAssets['asset-i1']?.original.url);
  });

  it('素材节点未登记资产身份（历史角色坞路径）→ available=false，源地址回落节点自持 URL', () => {
    const subject = resolveChromeSubject(
      imageInputNode('legacy', { assetId: null, imageUrl: '/local/legacy.png' }),
      mediaAssets,
    );
    expect(subject?.available).toBe(false);
    expect(subject?.sourceUrl).toBe('/local/legacy.png');
  });

  it('非媒体节点（task/agent/text）→ null', () => {
    expect(resolveChromeSubject(taskNode('t1'), mediaAssets)).toBeNull();
    expect(resolveChromeSubject({ ...assetNode('x1'), type: 'agent' }, mediaAssets)).toBeNull();
  });
});

describe('resolveMediaChromeSelection（选中集 → chrome 呈现判定）', () => {
  it('单选资产 → active 且 single 指向该主体', () => {
    const nodes = asMap([assetNode('a1')]);
    const sel = resolveMediaChromeSelection(['a1'], nodes, mediaAssets);
    expect(sel.active).toBe(true);
    expect(sel.multi).toBe(false);
    expect(sel.single?.node.id).toBe('a1');
  });

  it('单选导入图片素材 → active（D27：同一套 chrome）', () => {
    const nodes = asMap([imageInputNode('i1')]);
    const sel = resolveMediaChromeSelection(['i1'], nodes, mediaAssets);
    expect(sel.active).toBe(true);
    expect(sel.single?.family).toBe('imageInput');
    expect(sel.single?.mediaType).toBe('image');
  });

  it('导入视频/音频素材单选 → active 且媒体类型正确', () => {
    const video = resolveMediaChromeSelection(['v1'], asMap([videoInputNode('v1')]), mediaAssets);
    expect(video.active).toBe(true);
    expect(video.single?.mediaType).toBe('video');
    const audio = resolveMediaChromeSelection(['s1'], asMap([audioInputNode('s1')]), mediaAssets);
    expect(audio.active).toBe(true);
    expect(audio.single?.mediaType).toBe('audio');
  });

  it('资产 + 导入素材混选 → active 且 multi（不再整体消失）', () => {
    const nodes = asMap([assetNode('a1'), imageInputNode('i1')]);
    const sel = resolveMediaChromeSelection(['a1', 'i1'], nodes, mediaAssets);
    expect(sel.active).toBe(true);
    expect(sel.multi).toBe(true);
    expect(sel.single).toBeNull();
    expect(sel.subjects.map((s) => s.node.id)).toEqual(['a1', 'i1']);
  });

  it('混入非媒体节点（task/agent/text）→ 不呈现', () => {
    const nodes = asMap([assetNode('a1'), taskNode('t1')]);
    expect(resolveMediaChromeSelection(['a1', 't1'], nodes, mediaAssets).active).toBe(false);
    expect(resolveMediaChromeSelection(['a1', 't1'], nodes, mediaAssets).subjects).toEqual([]);
  });

  it('空选中 / 未知节点 id → 不呈现', () => {
    expect(resolveMediaChromeSelection([], asMap([assetNode('a1')]), mediaAssets).active).toBe(false);
    expect(resolveMediaChromeSelection(['missing'], asMap([]), mediaAssets).active).toBe(false);
  });
});

describe('buildBottomBarView（D21 底栏可见性 + PD-MR 参考判定）', () => {
  const selectionOf = (ids: string[], nodes: GraphNode[]) =>
    resolveMediaChromeSelection(ids, asMap(nodes), mediaAssets);

  it('生成资产（sourceModelId 非空）→ 显示复用；加工派生资产不显示', () => {
    const gen = selectionOf(['a1'], [
      assetNode('a1', { sourceModelId: 'gpt-image-2', sourceTaskId: 't-1' }),
    ]);
    expect(
      buildBottomBarView({ selection: gen, referenceAssetIds: new Set(), mediaAssets }).showReuse,
    ).toBe(true);

    const derived = selectionOf(['a1'], [
      assetNode('a1', { derivedFrom: { sourceAssetId: 'x', tool: 'crop' } }),
    ]);
    expect(
      buildBottomBarView({ selection: derived, referenceAssetIds: new Set(), mediaAssets }).showReuse,
    ).toBe(false);
  });

  it('导入素材（含 assetId 与生成字段为空）→ 不显示复用（D21 仅生成资产）', () => {
    const imported = selectionOf(['i1'], [imageInputNode('i1')]);
    expect(
      buildBottomBarView({ selection: imported, referenceAssetIds: new Set(), mediaAssets }).showReuse,
    ).toBe(false);
  });

  it('参考态：全部可加入项已在参考区 → refsActive；部分在 → false', () => {
    const sel = selectionOf(['a1'], [assetNode('a1')]);
    expect(
      buildBottomBarView({ selection: sel, referenceAssetIds: new Set(['asset-a1']), mediaAssets })
        .refsActive,
    ).toBe(true);
    expect(
      buildBottomBarView({ selection: sel, referenceAssetIds: new Set(), mediaAssets }).refsActive,
    ).toBe(false);
  });

  it('导入素材也参与参考判定（同一准入规则，不再按节点类型分叉入口）', () => {
    const imported = selectionOf(['i1'], [imageInputNode('i1')]);
    const view = buildBottomBarView({
      selection: imported,
      referenceAssetIds: new Set(['asset-i1']),
      mediaAssets,
    });
    expect(view.refCandidates.map((c) => c.candidate.ok)).toEqual([true]);
    expect(view.refsActive).toBe(true);
  });

  it('多选含生成视频资产：候选一律放行（模型能力由准入层判定，不再按媒体类型拒绝）', () => {
    const nodes = [assetNode('a1'), assetNode('a2', { mediaType: 'video' })];
    const view = buildBottomBarView({
      selection: selectionOf(['a1', 'a2'], nodes),
      referenceAssetIds: new Set(),
      mediaAssets,
    });
    expect(view.refCandidates.map((c) => c.candidate.ok)).toEqual([true, true]);
  });

  it('导入视频素材仍可加入参考（O5：素材节点维持现状，不扩大也不收窄）', () => {
    const view = buildBottomBarView({
      selection: selectionOf(['v1'], [videoInputNode('v1')]),
      referenceAssetIds: new Set(),
      mediaAssets,
    });
    expect(view.refCandidates.map((c) => c.candidate.ok)).toEqual([true]);
  });
});
