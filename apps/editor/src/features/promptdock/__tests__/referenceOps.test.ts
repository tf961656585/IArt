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

describe('resolveReferenceCandidate（PD-MR 媒体边界：资产只图片；素材维持现状）', () => {
  const mediaAssets = mediaAssetsFixture('asset-a1', 'asset-i1');

  it('图片资产节点 → ok', () => {
    const c = resolveReferenceCandidate(assetNode('a1'), mediaAssets);
    expect(c).toEqual({ ok: true, assetId: 'asset-a1', mediaType: 'image', label: '资产 a1' });
  });

  it('视频/音频资产节点 → 拒绝（参考素材只支持图片，O5；kind = media-unsupported）', () => {
    const video = resolveReferenceCandidate(
      assetNode('a2', { mediaType: 'video', assetId: 'asset-a2' }),
      mediaAssets,
    );
    expect(!video.ok && video.reason).toContain('参考素材只支持图片');
    expect(!video.ok && video.kind).toBe('media-unsupported');
    const audio = resolveReferenceCandidate(
      assetNode('a3', { mediaType: 'audio', assetId: 'asset-a3' }),
      mediaAssets,
    );
    expect(!audio.ok && audio.reason).toContain('参考素材只支持图片');
    expect(!audio.ok && audio.kind).toBe('media-unsupported');
  });

  it('资产已被删除（未注册/无 url）→ 可定位原因（PD-MR-004；kind = asset-unavailable）', () => {
    const missing = resolveReferenceCandidate(
      assetNode('a9', { assetId: 'asset-missing' }),
      mediaAssets,
    );
    expect(!missing.ok && missing.reason).toContain('素材已被删除');
    expect(!missing.ok && missing.kind).toBe('asset-unavailable');
  });

  it('imageInput 素材节点 → ok（现状维持）；textInput → 拒绝', () => {
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
      derivedFromNodeId: undefined,
      derivedOp: undefined,
      cachedContent: undefined,
      originalImageMeta: undefined,
      resizePercent: undefined,
      taskInfo: undefined,
      outpaintModelId: undefined,
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
          reason: '仅图片可用作参考（当前为视频资产）',
          kind: 'media-unsupported',
        },
      },
    ]);
    expect(outcome.rejected[0]?.label).toBe('资产 v1');
    expect(outcome.rejected[0]?.reason).toContain('仅图片');
    expect(outcome.rejected[0]?.kind).toBe('media-unsupported');
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
      state.mediaAssets = mediaAssetsFixture('asset-a1', 'asset-a2');
    });
  });

  it('加入后 isAssetInReferences 为真；重复加入不翻倍', () => {
    addNodesToReferences([assetNode('a1')]);
    let refs = usePromptDockStore.getState().draft.references;
    expect(isAssetInReferences(refs, 'asset-a1')).toBe(true);
    addNodesToReferences([assetNode('a1')]);
    refs = usePromptDockStore.getState().draft.references;
    expect(refs.filter((r) => r.assetId === 'asset-a1')).toHaveLength(1);
  });

  it('多选混合：图片加入、视频不加入但图片仍成功（PD-MR-004；结果 kind = added）', () => {
    const result = asAdded(
      addNodesToReferences([
        assetNode('a1'),
        assetNode('a2', { mediaType: 'video', assetId: 'asset-a2' }),
      ]),
    );
    expect(result.addedCount).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kind).toBe('media-unsupported');
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

  it('全部不符准入 → kind = rejected（媒体类型不符 / 资产不可访问各自带 kind）', () => {
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

  it('视频素材 → 拒绝（与资产节点路径同一套准入：参考素材只支持图片），不写参考区', () => {
    const result = addAssetIdsToReferences(['asset-video']);

    expect(result.kind).toBe('rejected');
    expect(result.rejected[0]?.kind).toBe('media-unsupported');
    expect(result.rejected[0]?.reason).toContain('参考素材只支持图片');
    expect(referenceAssetIds()).toEqual([]);
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
