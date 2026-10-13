import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../../../types/node';
import type { AssetNodeData } from '../../../types/taskNode';
import {
  buildBottomBarView,
  resolveAssetChromeSelection,
  topToolGroupsFor,
} from '../chromeModel';
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

const nodeOfType = (id: string, type: GraphNode['type']): GraphNode => ({
  ...assetNode(id),
  type,
});

const asMap = (nodes: GraphNode[]) =>
  new Map(nodes.map((n) => [n.id, n] as const));

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

describe('resolveAssetChromeSelection（选中集 → chrome 呈现判定）', () => {
  it('单选资产 → active 且 single 指向该节点', () => {
    const nodes = asMap([assetNode('a1')]);
    const sel = resolveAssetChromeSelection(['a1'], nodes);
    expect(sel.active).toBe(true);
    expect(sel.multi).toBe(false);
    expect(sel.single?.id).toBe('a1');
  });

  it('多选资产 → active 且 multi（顶栏隐藏由消费端处理）', () => {
    const nodes = asMap([assetNode('a1'), assetNode('a2')]);
    const sel = resolveAssetChromeSelection(['a1', 'a2'], nodes);
    expect(sel.active).toBe(true);
    expect(sel.multi).toBe(true);
    expect(sel.single).toBeNull();
  });

  it('混合选中（资产 + 任务/素材）→ 不呈现（与原型 isSelectable 口径一致）', () => {
    const nodes = asMap([assetNode('a1'), nodeOfType('t1', 'task')]);
    const sel = resolveAssetChromeSelection(['a1', 't1'], nodes);
    expect(sel.active).toBe(false);
    expect(sel.assetNodes).toEqual([]);
  });

  it('空选中 / 非资产选中 → 不呈现', () => {
    expect(resolveAssetChromeSelection([], asMap([assetNode('a1')])).active).toBe(false);
    const nodes = asMap([nodeOfType('i1', 'imageInput')]);
    expect(resolveAssetChromeSelection(['i1'], nodes).active).toBe(false);
  });
});

describe('buildBottomBarView（D21 底栏可见性 + PD-MR 参考判定）', () => {
  const mediaAssets = createMediaAssetMapFixture([
    createMediaAssetFixture({ id: 'asset-a1' }),
    createMediaAssetFixture({ id: 'asset-a2', mediaType: 'video' }),
    createMediaAssetFixture({ id: 'asset-a3', mediaType: 'audio' }),
  ]);

  it('生成资产（sourceModelId 非空）→ 显示复用；导入/派生资产不显示', () => {
    const gen = asMap([assetNode('a1', { sourceModelId: 'gpt-image-2', sourceTaskId: 't-1' })]);
    expect(
      buildBottomBarView({
        selection: resolveAssetChromeSelection(['a1'], gen),
        referenceAssetIds: new Set(),
        mediaAssets,
      }).showReuse,
    ).toBe(true);

    const derived = asMap([
      assetNode('a1', { derivedFrom: { sourceAssetId: 'x', tool: 'crop' } }),
    ]);
    expect(
      buildBottomBarView({
        selection: resolveAssetChromeSelection(['a1'], derived),
        referenceAssetIds: new Set(),
        mediaAssets,
      }).showReuse,
    ).toBe(false);
  });

  it('参考态：全部可加入项已在参考区 → refsActive；部分在 → false', () => {
    const sel = resolveAssetChromeSelection(['a1'], asMap([assetNode('a1')]));
    expect(
      buildBottomBarView({ selection: sel, referenceAssetIds: new Set(['asset-a1']), mediaAssets })
        .refsActive,
    ).toBe(true);
    expect(
      buildBottomBarView({ selection: sel, referenceAssetIds: new Set(), mediaAssets }).refsActive,
    ).toBe(false);
  });

  it('多选含非图片资产：candidates 中视频项 ok=false（只支持图片加入，O5/D21）', () => {
    const nodes = asMap([assetNode('a1'), assetNode('a2', { mediaType: 'video' })]);
    const view = buildBottomBarView({
      selection: resolveAssetChromeSelection(['a1', 'a2'], nodes),
      referenceAssetIds: new Set(),
      mediaAssets,
    });
    const reasons = view.refCandidates.map((c) => c.candidate.ok);
    expect(reasons).toEqual([true, false]);
    const rejected = view.refCandidates.find((c) => !c.candidate.ok);
    expect(rejected && !rejected.candidate.ok ? rejected.candidate.reason : '').toContain('参考素材只支持图片');
  });
});
