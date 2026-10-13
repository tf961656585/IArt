import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BatchIntentSnapshot, ProjectMediaAssets } from '@iart/contracts';
import type { AssetNodeData } from '@/features/canvas/types/taskNode';
import { fetchBatchIntentSnapshot } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';
import { reuseAssetToDraft, restoreDraftFromBatchSnapshot } from '../assetReuse';

/**
 * 资产「复用」回填回归（产品 spec 00-产品定位与核心动作.md「复用」段）：
 * 复用读取资产生成来源中的模型、prompt、参数、参考和任务数回填创作面；
 * 不回填连接/凭证/部署/执行快照。
 *
 * 旧口径（只回填 model_id、prompt/参数/参考清空）由本文件封口：快照回填缺失或
 * 重新引入"复用清空草稿"都会使这里的首个用例失败。
 */

vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  fetchBatchIntentSnapshot: vi.fn(),
}));

const mediaAssetsFixture: ProjectMediaAssets = {
  asset_ref_1: {
    id: 'asset_ref_1',
    mediaType: 'image',
    original: {
      url: 'local-media://prj_0123456789abcdef0123456789abcdef/ref-1.file',
      projectRef: 'prj_0123456789abcdef0123456789abcdef',
      fileKey: 'ref-1.file',
      sourceUrl: null,
      sourceFileName: null,
      mimeType: 'image/png',
      sizeBytes: 1,
      width: 10,
      height: 10,
      durationMs: null,
      fps: null,
    },
    thumbnail: {
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: 'missing',
      generatedAt: null,
      error: null,
    },
    lifecycle: { createdAt: 1, updatedAt: 1 },
  },
};

vi.mock('@/features/canvas/store/canvasStore', () => ({
  useCanvasStore: {
    getState: () => ({
      mediaAssets: mediaAssetsFixture,
      nodeGraph: null,
    }),
  },
}));

const assetFixture = (overrides: Partial<AssetNodeData> = {}): AssetNodeData => ({
  label: 'gpt-image-2',
  sourceBatchId: 'batch_1',
  sourceTaskId: 'task_1',
  sourceModelId: 'gpt-image-2',
  mediaType: 'image',
  assetId: 'asset_generated_1',
  ...overrides,
});

const snapshotFixture = (overrides: Partial<BatchIntentSnapshot> = {}): BatchIntentSnapshot => ({
  batch_id: 'batch_1',
  model_id: 'gpt-image-2',
  model_version: '1.0.0',
  prompt: '一只在雨中弹吉他的柴犬',
  params: { size: 'auto', quality: 'high' },
  reference_asset_ids: ['asset_ref_1'],
  task_count: 2,
  task_ids: ['task_1', 'task_2'],
  created_at: '2026-09-09T00:00:00.000Z',
  ...overrides,
});

const seedStore = () => {
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
    catalog: [
      {
        model_id: 'gpt-image-2',
        model_version: '2.0.0',
        default_task_type: 'image',
        capability: { input_modalities: ['text'], output_modalities: ['image'] },
        parameter_schema: { fields: [], required_fields: [], default_values: {} },
        deployment: {
          has_active_deployment: true,
          active_deployment_id: 'dep_1',
          deployable: true,
          failure_code: 'none',
        },
      },
    ],
    catalogLoaded: true,
    submitting: false,
    preflightIssues: null,
  });
};

beforeEach(() => {
  vi.mocked(fetchBatchIntentSnapshot).mockReset();
  seedStore();
});

describe('资产「复用」回填（batch 快照恢复）', () => {
  it('快照命中：prompt/参数/参考/任务数按生成时快照回填，model_version 取当前目录', async () => {
    vi.mocked(fetchBatchIntentSnapshot).mockResolvedValue(snapshotFixture());

    reuseAssetToDraft(assetFixture());
    await vi.waitFor(() => {
      expect(usePromptDockStore.getState().draft.prompt).toBe('一只在雨中弹吉他的柴犬');
    });

    const draft = usePromptDockStore.getState().draft;
    expect(draft.modelId).toBe('gpt-image-2');
    expect(draft.modelVersion).toBe('2.0.0');
    expect(draft.prompt).toBe('一只在雨中弹吉他的柴犬');
    expect(draft.arguments).toEqual({ size: 'auto', quality: 'high' });
    expect(draft.references).toEqual([
      {
        refId: 'asset_ref_1',
        assetId: 'asset_ref_1',
        mediaType: 'image',
        label: 'asset_ref_1',
      },
    ]);
    expect(draft.taskCount).toBe(2);
    expect(fetchBatchIntentSnapshot).toHaveBeenCalledWith('batch_1');
  });

  it('旧快照无 reference_asset_ids：按 media_refs attachment fileKey 反查画布资产兜底', async () => {
    vi.mocked(fetchBatchIntentSnapshot).mockResolvedValue(
      snapshotFixture({
        reference_asset_ids: undefined,
        media_refs: [
          {
            media_kind: 'image',
            source_kind: 'attachment',
            value: 'local-media://prj_0123456789abcdef0123456789abcdef/ref-1.file',
            mime_type: 'image/png',
            filename: null,
          },
        ],
      }),
    );

    reuseAssetToDraft(assetFixture());
    await vi.waitFor(() => {
      expect(usePromptDockStore.getState().draft.references).toHaveLength(1);
    });
    expect(usePromptDockStore.getState().draft.references[0]?.assetId).toBe('asset_ref_1');
  });

  it('竞态守卫：快照返回前用户已编辑草稿，回填让位不覆盖', async () => {
    let resolveSnapshot: (value: BatchIntentSnapshot | null) => void = () => undefined;
    vi.mocked(fetchBatchIntentSnapshot).mockImplementation(
      () =>
        new Promise<BatchIntentSnapshot | null>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    reuseAssetToDraft(assetFixture());
    usePromptDockStore.getState().setDraft({ prompt: '用户此刻的新输入' });
    resolveSnapshot(snapshotFixture());
    await vi.waitFor(() => {
      expect(vi.mocked(fetchBatchIntentSnapshot).mock.calls.length).toBeGreaterThan(0);
    });

    expect(usePromptDockStore.getState().draft.prompt).toBe('用户此刻的新输入');
  });

  it('快照缺失：退化为仅模型身份回填（重置态），prompt 保持为空', async () => {
    vi.mocked(fetchBatchIntentSnapshot).mockResolvedValue(null);

    reuseAssetToDraft(assetFixture());
    await vi.waitFor(() => {
      expect(fetchBatchIntentSnapshot).toHaveBeenCalledTimes(1);
    });

    const draft = usePromptDockStore.getState().draft;
    expect(draft.modelId).toBe('gpt-image-2');
    expect(draft.prompt).toBe('');
    expect(draft.taskCount).toBe(1);
  });

  it('重试入口：沿用原任务配置回填，任务数固定 1 不回填原批次 N', async () => {
    vi.mocked(fetchBatchIntentSnapshot).mockResolvedValue(snapshotFixture({ task_count: 4 }));

    restoreDraftFromBatchSnapshot({
      batchId: 'batch_1',
      fallbackModelId: 'gpt-image-2',
      restoreTaskCount: false,
    });
    await vi.waitFor(() => {
      expect(usePromptDockStore.getState().draft.prompt).toBe('一只在雨中弹吉他的柴犬');
    });

    expect(usePromptDockStore.getState().draft.taskCount).toBe(1);
  });
});
