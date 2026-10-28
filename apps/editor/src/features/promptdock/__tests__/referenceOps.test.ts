import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { GraphNode } from '@/features/canvas/types/node';
import type {
  ImageInputNodeData,
  TextInputNodeData,
} from '@/features/canvas/types/nodeDataTypes';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import {
  addAssetIdsToReferences,
  addNodesToReferences,
  isAssetInReferences,
  mergeReferences,
  removeAssetsFromReferences,
  resolveReferenceAdmission,
  resolveReferenceCandidate,
  type AddReferencesResult,
} from '../referenceOps';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { usePromptDockStore } from '../promptDockStore';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
  createTestNodeGraph,
} from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { createCatalogEntryWithSlots } from './fixtures/promptDockCatalogEntry';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const assetNode = (
  id: string,
  overrides: Partial<AssetNodeData> = {},
): GraphNode => ({
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

const mediaAssetsFixture = (...ids: string[]): ReturnType<typeof createMediaAssetMapFixture> =>
  createMediaAssetMapFixture(ids.map((id) => createMediaAssetFixture({ id })));

describe('resolveReferenceCandidate（资产可访问性 + 媒体身份；来源无关）', () => {
  const mediaAssets = createMediaAssetMapFixture([
    createMediaAssetFixture({ id: 'asset-a1' }),
    createMediaAssetFixture({ id: 'asset-i1' }),
    createMediaAssetFixture({ id: 'asset-v1', mediaType: 'video' }),
    createMediaAssetFixture({ id: 'asset-u1', mediaType: 'audio' }),
  ]);

  it('图片资产节点 → ok', () => {
    const c = resolveReferenceCandidate(assetNode('a1'), mediaAssets);
    expect(c).toEqual({ ok: true, assetId: 'asset-a1', mediaType: 'image', label: '资产 a1' });
  });

  it('视频/音频资产节点 → 同样 ok（参考准入不再按媒体类型划界）', () => {
    expect(resolveReferenceCandidate(
      assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' }),
      mediaAssets,
    )).toEqual({ ok: true, assetId: 'asset-v1', mediaType: 'video', label: '资产 v1' });
    expect(resolveReferenceCandidate(
      assetNode('u1', { mediaType: 'audio', assetId: 'asset-u1' }),
      mediaAssets,
    )).toEqual({ ok: true, assetId: 'asset-u1', mediaType: 'audio', label: '资产 u1' });
  });

  it('资产已被删除（未注册/无 url）→ 可定位原因（PD-MR-004；kind = asset-unavailable）', () => {
    const missing = resolveReferenceCandidate(
      assetNode('a9', { assetId: 'asset-missing' }),
      mediaAssets,
    );
    expect(!missing.ok && missing.reason).toContain('素材已被删除');
    expect(!missing.ok && missing.kind).toBe('asset-unavailable');
  });

  it('imageInput 素材节点 → ok（与资产节点同一判定）；textInput → 拒绝（不是媒体对象）', () => {
    const imgData: ImageInputNodeData = {
      label: '素材',
      description: undefined,
      runtimeRef: undefined,
      assetId: 'asset-i1',
      imageUrl: '/files/i1.png',
      imageMeta: undefined,
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      valueSource: 'upload',
      mediaError: undefined,
      cachedContent: undefined,
      taskInfo: undefined,
    };
    expect(
      resolveReferenceCandidate(
        { ...assetNode('i1'), type: 'imageInput', data: imgData },
        mediaAssets,
      ).ok,
    ).toBe(true);
    const textData: TextInputNodeData = {
      label: '文本',
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: 'comma',
      customSeparator: undefined,
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    };
    expect(
      !resolveReferenceCandidate(
        { ...assetNode('t9'), type: 'textInput', data: textData },
        mediaAssets,
      ).ok,
    ).toBe(true);
  });
});

describe('mergeReferences（去重，PD-MR-003）', () => {
  it('重复资产不产生重复引用，计入 alreadyInRefs；新增引用带 label', () => {
    const existing = [
      { refId: 'x1', assetId: 'x1', mediaType: 'image' as const, label: '旧引用' },
    ];
    const { outcome, next } = mergeReferences(existing, [
      { label: '资产 n1', candidate: { ok: true, assetId: 'x1', mediaType: 'image', label: '资产 n1' } },
      { label: '资产 n1', candidate: { ok: true, assetId: 'x2', mediaType: 'image', label: '资产 n1' } },
    ]);
    expect(outcome.alreadyInRefs).toEqual(['x1']);
    expect(outcome.added.map((r) => r.assetId)).toEqual(['x2']);
    expect(outcome.added[0]?.label).toBe('资产 n1');
    expect(next).toHaveLength(2);
  });

  it('拒绝项带可定位 label + reason + kind', () => {
    const { outcome } = mergeReferences([], [
      {
        label: '资产 v1',
        candidate: {
          ok: false,
          reason: '当前模型不支持视频参考',
          kind: 'media-unsupported',
        },
      },
    ]);
    expect(outcome.rejected[0]?.label).toBe('资产 v1');
    expect(outcome.rejected[0]?.reason).toContain('当前模型不支持');
    expect(outcome.rejected[0]?.kind).toBe('media-unsupported');
  });
});

describe('加入参考：按用途余量落位（设计 §4.3 / §4.7）', () => {
  type MediaSlots = Parameters<typeof createCatalogEntryWithSlots>[0];

  const setCatalog = (slots: MediaSlots): void => {
    usePromptDockStore.setState({
      catalog: [createCatalogEntryWithSlots(slots)],
      draft: {
        modelId: 'model-a',
        modelVersion: '1.0.0',
        prompt: '',
        arguments: {},
        references: [],
        promptPresetSnapshots: undefined,
        taskCount: 1,
      },
    });
  };

  const resetCanvas = (ids: string[]): void => {
    useCanvasStore.setState((state) => {
      state.mediaAssets = mediaAssetsFixture(...ids);
      state.nodeGraph = null;
      state.selectedNodeIds = [];
    });
  };

  it('同批超过上限 → 只加入余量内的，其余按容量拒绝（堆草稿与静默丢弃都不允许）', () => {
    setCatalog([
      { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 2, mediaKind: 'image', label: '参考图' },
    ]);
    resetCanvas(['asset-a1', 'asset-a2', 'asset-a3']);

    const result = addNodesToReferences([assetNode('a1'), assetNode('a2'), assetNode('a3')]);

    expect(result.kind).toBe('added');
    if (result.kind !== 'added') throw new Error(`预期 kind=added，实际 ${result.kind}`);
    expect(result.addedCount).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kind).toBe('slot-capacity-exceeded');
    expect(result.rejected[0]?.reason).toBe(
      '当前模型的图片参考最多 2 张，参考区已经放满，先移除一张再加入',
    );
    const refs = usePromptDockStore.getState().draft.references;
    expect(refs.map((r) => r.assetId)).toEqual(['asset-a1', 'asset-a2']);
    expect(refs.every((r) => r.slotId === 'reference_image')).toBe(true);
  });

  it('单张位模型加入第二张 → 拒绝，不产生同一用途的双占', () => {
    setCatalog([
      { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: false, maxFiles: 1, mediaKind: 'image', label: '首帧' },
    ]);
    resetCanvas(['asset-a1', 'asset-a2']);

    addNodesToReferences([assetNode('a1')]);
    const second = addNodesToReferences([assetNode('a2')]);

    expect(second.kind).toBe('rejected');
    expect(second.rejected[0]?.kind).toBe('slot-capacity-exceeded');
    expect(usePromptDockStore.getState().draft.references).toHaveLength(1);
  });

  it('默认多张位放满、单张位还有余量 → 新图落未指定，等用户点徽章指定', () => {
    setCatalog([
      { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: false, maxFiles: 1, mediaKind: 'image', label: '首帧' },
      { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 2, mediaKind: 'image', label: '参考图' },
    ]);
    resetCanvas(['asset-a1', 'asset-a2', 'asset-a3']);

    addNodesToReferences([assetNode('a1'), assetNode('a2')]);
    const third = addNodesToReferences([assetNode('a3')]);

    expect(third.kind).toBe('added');
    expect(usePromptDockStore.getState().draft.references.map((r) => r.slotId)).toEqual([
      'reference_image',
      'reference_image',
      null,
    ]);
  });
});

describe('参考准入按当前模型能力判定（来源无关，PD-MR-001/004）', () => {
  type MediaSlots = Parameters<typeof createCatalogEntryWithSlots>[0];

  const imageOnlySlots: MediaSlots = [
    { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 2, mediaKind: 'image', label: '参考图' },
  ];
  const videoRefSlots: MediaSlots = [
    { slotId: 'reference_video', fieldKey: 'referenceVideo', required: false, maxFiles: 2, mediaKind: 'video', label: '参考视频' },
  ];

  const setModel = (slots: MediaSlots): void => {
    usePromptDockStore.setState({
      catalog: [createCatalogEntryWithSlots(slots)],
      draft: {
        modelId: 'model-a',
        modelVersion: '1.0.0',
        prompt: '',
        arguments: {},
        references: [],
        promptPresetSnapshots: undefined,
        taskCount: 1,
      },
    });
  };

  const canvasWith = (...assets: ReturnType<typeof createMediaAssetFixture>[]): void => {
    useCanvasStore.setState((state) => {
      state.mediaAssets = createMediaAssetMapFixture(assets);
      state.nodeGraph = null;
      state.selectedNodeIds = [];
    });
  };

  const videoAsset = (id: string): ReturnType<typeof createMediaAssetFixture> =>
    createMediaAssetFixture({ id, mediaType: 'video' });
  const refs = (): ReturnType<typeof usePromptDockStore.getState>['draft']['references'] =>
    usePromptDockStore.getState().draft.references;

  /** 导入视频 = 视频素材节点（与生成视频的资产节点走同一判定）。 */
  const videoInputNode = (id: string, assetId: string): GraphNode => ({
    id,
    type: 'videoInput',
    position: { x: 0, y: 0 },
    data: {
      label: `视频 ${id}`,
      description: undefined,
      runtimeRef: undefined,
      assetId,
      videoUrl: '/files/v.mp4',
      videoMeta: undefined,
      valueSource: 'upload',
      mediaError: undefined,
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      taskInfo: undefined,
      cachedContent: undefined,
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  });

  it('生成视频 + 支持视频的模型 → 可加入（按视频参考位落位）', () => {
    setModel(videoRefSlots);
    canvasWith(videoAsset('asset-v1'));

    const result = addNodesToReferences([
      assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' }),
    ]);

    expect(result.kind).toBe('added');
    expect(refs().map((r) => ({ assetId: r.assetId, mediaType: r.mediaType, slotId: r.slotId })))
      .toEqual([{ assetId: 'asset-v1', mediaType: 'video', slotId: 'reference_video' }]);
  });

  it('不支持视频的模型 → 拒绝且 kind=media-unsupported（不写参考区）', () => {
    setModel(imageOnlySlots);
    canvasWith(videoAsset('asset-v1'));

    const result = addNodesToReferences([
      assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' }),
    ]);

    expect(result.kind).toBe('rejected');
    expect(result.rejected[0]).toMatchObject({
      kind: 'media-unsupported',
      reason: '当前模型不支持视频参考',
    });
    expect(refs()).toEqual([]);
  });

  it('导入视频与生成视频在准入上结果一致（来源无关）', () => {
    const entry = createCatalogEntryWithSlots(videoRefSlots);
    setModel(videoRefSlots);
    canvasWith(videoAsset('asset-v1'));
    const mediaAssets = useCanvasStore.getState().mediaAssets;
    const references: Parameters<typeof resolveReferenceAdmission>[0]['references'] = [];

    const generated = resolveReferenceAdmission({
      node: assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' }),
      mediaAssets,
      entry,
      references,
    });
    const imported = resolveReferenceAdmission({
      node: videoInputNode('n1', 'asset-v1'),
      mediaAssets,
      entry,
      references,
    });
    expect(imported).toEqual(generated);
    expect(generated).toEqual({ ok: true });

    // 换到不支持视频的模型：两者同样被拒，且理由一致。
    const imageOnlyEntry = createCatalogEntryWithSlots(imageOnlySlots);
    for (const node of [
      assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' }),
      videoInputNode('n1', 'asset-v1'),
    ]) {
      expect(
        resolveReferenceAdmission({ node, mediaAssets, entry: imageOnlyEntry, references }),
      ).toEqual({ ok: false, kind: 'media-unsupported', reason: '当前模型不支持视频参考' });
    }
  });

  it('无 media_slots 的模型 → 沿用允许加入，引用落未指定', () => {
    setModel([]);
    canvasWith(videoAsset('asset-v1'));

    const result = addNodesToReferences([
      assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' }),
    ]);

    expect(result.kind).toBe('added');
    expect(refs()[0]?.mediaType).toBe('video');
    expect(refs()[0]?.slotId).toBeNull();
  });

  it('该类型参考位已放满 → 拒绝且 kind=slot-capacity-exceeded（按媒体类型量词）', () => {
    setModel([
      { slotId: 'reference_video', fieldKey: 'referenceVideo', required: false, maxFiles: 1, mediaKind: 'video', label: '参考视频' },
    ]);
    canvasWith(videoAsset('asset-v1'), videoAsset('asset-v2'));

    addNodesToReferences([assetNode('v1', { mediaType: 'video', assetId: 'asset-v1' })]);
    const second = addNodesToReferences([
      assetNode('v2', { mediaType: 'video', assetId: 'asset-v2' }),
    ]);

    expect(second.kind).toBe('rejected');
    expect(second.rejected[0]).toMatchObject({
      kind: 'slot-capacity-exceeded',
      reason: '当前模型的视频参考最多 1 段，参考区已经放满，先移除一段再加入',
    });
    expect(refs().map((r) => r.assetId)).toEqual(['asset-v1']);
  });

  it('资产不存在 → 拒绝且 kind=asset-unavailable（模型支持视频也拦下）', () => {
    setModel(videoRefSlots);
    canvasWith();

    const result = addNodesToReferences([
      assetNode('v9', { mediaType: 'video', assetId: 'asset-missing' }),
    ]);

    expect(result.kind).toBe('rejected');
    expect(result.rejected[0]).toMatchObject({
      kind: 'asset-unavailable',
      reason: '素材已被删除，无法加入参考',
    });
    expect(refs()).toEqual([]);
  });
});

describe('store 接线（addNodesToReferences / removeAssetsFromReferences）', () => {
  /** 断言结果种类并收窄到对应变体（收窄优于断言） */
  const asAdded = (result: AddReferencesResult): Extract<AddReferencesResult, { kind: 'added' }> => {
    if (result.kind !== 'added') throw new Error(`预期 kind=added，实际 ${result.kind}`);
    return result;
  };
  const asDuplicate = (
    result: AddReferencesResult,
  ): Extract<AddReferencesResult, { kind: 'duplicate' }> => {
    if (result.kind !== 'duplicate') throw new Error(`预期 kind=duplicate，实际 ${result.kind}`);
    return result;
  };
  const asRejected = (
    result: AddReferencesResult,
  ): Extract<AddReferencesResult, { kind: 'rejected' }> => {
    if (result.kind !== 'rejected') throw new Error(`预期 kind=rejected，实际 ${result.kind}`);
    return result;
  };

  beforeEach(() => {
    usePromptDockStore.setState({
      catalog: [],
      draft: {
        modelId: null,
        modelVersion: null,
        prompt: '',
        arguments: {},
        references: [],
        promptPresetSnapshots: undefined,
        taskCount: 1,
      },
    });
    useCanvasStore.setState((state) => {
      state.mediaAssets = createMediaAssetMapFixture([
        createMediaAssetFixture({ id: 'asset-a1' }),
        createMediaAssetFixture({ id: 'asset-a2', mediaType: 'video' }),
      ]);
    });
  });

  /** 当前模型只声明图片参考位（用于验证视频被模型能力拦下）。 */
  const setImageOnlyModel = (): void => {
    usePromptDockStore.setState({
      catalog: [
        createCatalogEntryWithSlots([
          { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 2, mediaKind: 'image', label: '参考图' },
        ]),
      ],
      draft: {
        ...usePromptDockStore.getState().draft,
        modelId: 'model-a',
        modelVersion: '1.0.0',
      },
    });
  };

  it('加入后 isAssetInReferences 为真；重复加入不翻倍', () => {
    addNodesToReferences([assetNode('a1')]);
    let refs = usePromptDockStore.getState().draft.references;
    expect(isAssetInReferences(refs, 'asset-a1')).toBe(true);
    addNodesToReferences([assetNode('a1')]);
    refs = usePromptDockStore.getState().draft.references;
    expect(refs.filter((r) => r.assetId === 'asset-a1')).toHaveLength(1);
  });

  it('多选混合：图片加入、视频因模型不支持而不加入（PD-MR-004；结果 kind = added）', () => {
    setImageOnlyModel();
    const result = asAdded(
      addNodesToReferences([
        assetNode('a1'),
        assetNode('a2', { mediaType: 'video', assetId: 'asset-a2' }),
      ]),
    );
    expect(result.addedCount).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      kind: 'media-unsupported',
      reason: '当前模型不支持视频参考',
    });
    expect(usePromptDockStore.getState().draft.references.map((r) => r.assetId)).toEqual([
      'asset-a1',
    ]);
  });

  it('全部重复 → kind = duplicate，不翻倍；操作层不弹 toast（呈现收口到呈现面）', () => {
    addNodesToReferences([assetNode('a1')]);
    const result = asDuplicate(addNodesToReferences([assetNode('a1')]));
    expect(result.duplicates).toBe(1);
    expect(usePromptDockStore.getState().draft.references).toHaveLength(1);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('全部不符准入 → kind = rejected（模型不支持 / 资产不可访问各自带 kind）', () => {
    setImageOnlyModel();
    const unsupported = asRejected(
      addNodesToReferences([assetNode('a2', { mediaType: 'video', assetId: 'asset-a2' })]),
    );
    expect(unsupported.rejected[0]?.kind).toBe('media-unsupported');
    const unavailable = asRejected(
      addNodesToReferences([assetNode('a9', { assetId: 'asset-missing' })]),
    );
    expect(unavailable.rejected[0]?.kind).toBe('asset-unavailable');
    expect(usePromptDockStore.getState().draft.references).toHaveLength(0);
  });

  it('removeAssetsFromReferences 精确移除', () => {
    addNodesToReferences([assetNode('a1'), assetNode('a2')]);
    removeAssetsFromReferences(['asset-a1']);
    const refs = usePromptDockStore.getState().draft.references;
    expect(refs.map((r) => r.assetId)).toEqual(['asset-a2']);
  });
});

describe('addAssetIdsToReferences（按素材 ID 直加；spec docs/agent/04 · AG-EX-002）', () => {
  const emptyDraft = (): void => {
    usePromptDockStore.setState({
      catalog: [],
      draft: {
        modelId: null,
        modelVersion: null,
        prompt: '',
        arguments: {},
        references: [],
        promptPresetSnapshots: undefined,
        taskCount: 1,
      },
    });
  };
  const referenceAssetIds = (): string[] =>
    usePromptDockStore.getState().draft.references.map((r) => r.assetId);
  const asDuplicateOf = (
    result: AddReferencesResult,
  ): Extract<AddReferencesResult, { kind: 'duplicate' }> => {
    if (result.kind !== 'duplicate') throw new Error(`预期 kind=duplicate，实际 ${result.kind}`);
    return result;
  };

  beforeEach(() => {
    emptyDraft();
    // 关键前提：画布上没有任何持有该素材的节点（存量会话产物 / 跨空间引用）。
    useCanvasStore.setState({
      mediaAssets: createMediaAssetMapFixture([
        createMediaAssetFixture({ id: 'asset-a1' }),
        createMediaAssetFixture({ id: 'asset-a2' }),
        createMediaAssetFixture({ id: 'asset-video', mediaType: 'video' }),
      ]),
      nodeGraph: null,
    });
  });

  // @spec: AG-EX-002
  it('画布上不存在持有该素材的节点，也能按素材 ID 加入参考区（资产身份即可）', () => {
    const result = addAssetIdsToReferences(['asset-a1']);

    expect(result.kind).toBe('added');
    expect(referenceAssetIds()).toEqual(['asset-a1']);
    // 标签退 assetId（画布上没有节点标签可取，与 assetReuse 的快照回填同口径）
    expect(usePromptDockStore.getState().draft.references[0]?.label).toBe('asset-a1');
  });

  it('有持有节点时标签沿用节点标签（与节点路径的加入结果等价）', () => {
    useCanvasStore.setState((state) => {
      state.nodeGraph = createTestNodeGraph({ nodes: [assetNode('a1')] });
    });

    addAssetIdsToReferences(['asset-a1']);

    const reference = usePromptDockStore.getState().draft.references[0];
    expect(reference?.assetId).toBe('asset-a1');
    expect(reference?.label).toBe('资产 a1');
    expect(reference?.mediaType).toBe('image');
  });

  it('视频素材：当前模型不支持视频 → 拒绝（与节点路径同一套准入），不写参考区', () => {
    usePromptDockStore.setState({
      catalog: [
        createCatalogEntryWithSlots([
          { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 2, mediaKind: 'image', label: '参考图' },
        ]),
      ],
      draft: {
        ...usePromptDockStore.getState().draft,
        modelId: 'model-a',
        modelVersion: '1.0.0',
      },
    });

    const result = addAssetIdsToReferences(['asset-video']);

    expect(result.kind).toBe('rejected');
    expect(result.rejected[0]).toMatchObject({
      kind: 'media-unsupported',
      reason: '当前模型不支持视频参考',
    });
    expect(referenceAssetIds()).toEqual([]);
  });

  it('视频素材：当前模型支持视频 → 可加入（与资产节点/素材节点来源无关）', () => {
    usePromptDockStore.setState({
      catalog: [
        createCatalogEntryWithSlots([
          { slotId: 'reference_video', fieldKey: 'referenceVideo', required: false, maxFiles: 2, mediaKind: 'video', label: '参考视频' },
        ]),
      ],
      draft: {
        ...usePromptDockStore.getState().draft,
        modelId: 'model-a',
        modelVersion: '1.0.0',
      },
    });

    const result = addAssetIdsToReferences(['asset-video']);

    expect(result.kind).toBe('added');
    expect(referenceAssetIds()).toEqual(['asset-video']);
    expect(usePromptDockStore.getState().draft.references[0]?.mediaType).toBe('video');
  });

  it('无 media_slots 的模型 → 视频素材沿用允许加入，引用落未指定', () => {
    const result = addAssetIdsToReferences(['asset-video']);

    expect(result.kind).toBe('added');
    expect(usePromptDockStore.getState().draft.references[0]?.slotId).toBeNull();
  });

  it('注册表查不到该素材 → 拒绝（素材已被删除），不写参考区', () => {
    const result = addAssetIdsToReferences(['asset-missing']);

    expect(result.kind).toBe('rejected');
    expect(result.rejected[0]?.kind).toBe('asset-unavailable');
    expect(result.rejected[0]?.reason).toContain('素材已被删除');
    expect(referenceAssetIds()).toEqual([]);
  });

  it('已在参考区 → kind = duplicate（不静默重复添加），混合批次仍加入有效项', () => {
    addAssetIdsToReferences(['asset-a1']);
    expect(asDuplicateOf(addAssetIdsToReferences(['asset-a1'])).duplicates).toBe(1);
    expect(referenceAssetIds()).toEqual(['asset-a1']);

    const mixed = addAssetIdsToReferences(['asset-a1', 'asset-a2']);
    expect(mixed.kind).toBe('added');
    expect(referenceAssetIds()).toEqual(['asset-a1', 'asset-a2']);
  });
});
