import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '@/features/canvas/types/node';

const startupConfigMock = {
  getResolvedExpandInlineParamsOnStartup: vi.fn(),
  peekResolvedExpandInlineParamsOnStartup: vi.fn(),
};

vi.mock('@/client/utils/hubCanvasStartupConfig', () => startupConfigMock);

const buildBundleFile = async (inlineControlsCollapsed: boolean) => {
  const zip = new JSZip();
  const nodeGraph = {
    id: 'graph-import-bundle-inline-test',
    name: 'bundle import inline test',
    nodes: [
      {
        id: 'model-1',
        type: 'model',
        position: { x: 0, y: 0 },
        data: {
          modelId: '__test-bundle-inline-model__',
          formValues: {},
          portMapping: {},
          inlineControlsCollapsed,
        },
        inputs: [],
        outputs: [],
      },
    ],
  };
  zip.file(
    'manifest.json',
    JSON.stringify({
      version: 2,
      format: 'iarts-bundle',
      exportedAt: new Date().toISOString(),
      appVersion: 'test',
      compression: 'deflate',
      mediaManifest: {},
      mediaStats: {
        totalCount: 0,
        totalSizeBytes: 0,
        deduplicatedSizeBytes: 0,
      },
    })
  );
  zip.file(
    'project.json',
    JSON.stringify({
      nodeGraph,
      mediaAssets: {},
    })
  );

  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'inline-startup.iarts', { type: 'application/zip' });
};

const loadImporter = async (expandInlineParamsOnStartup: boolean) => {
  vi.resetModules();
  startupConfigMock.getResolvedExpandInlineParamsOnStartup.mockResolvedValue(expandInlineParamsOnStartup);
  startupConfigMock.peekResolvedExpandInlineParamsOnStartup.mockReturnValue(expandInlineParamsOnStartup);

  const [{ importNodeGraphFromBundle }, { nodeRegistry }] = await Promise.all([
    import('@/features/canvas/export/importBundle'),
    import('@/features/canvas/nodes/registry'),
  ]);

  const modelKey = '__test-bundle-inline-model__';
  if (!nodeRegistry.get(modelKey)) {
    nodeRegistry.register({
      type: 'model',
      modelId: modelKey,
      providerId: 'test',
      label: 'Bundle 导入启动规则测试模型',
      category: 'model',
      inputs: [],
      outputs: [],
      defaultSize: { width: 420, height: 360 },
      defaultData: {
        label: 'Bundle 导入启动规则测试模型',
        modelId: modelKey,
        formValues: {},
        portMapping: {},
        inlineControlsCollapsed: false,
      },
    });
  }

  return { importNodeGraphFromBundle };
};

const readInlineControlsCollapsed = (node: GraphNode | undefined): boolean => {
  if (!node) {
    throw new Error('Expected imported node');
  }
  const data = node.data;
  if (!('inlineControlsCollapsed' in data) || typeof data.inlineControlsCollapsed !== 'boolean') {
    throw new Error('Expected inlineControlsCollapsed flag');
  }
  return data.inlineControlsCollapsed;
};

describe('importNodeGraphFromBundle - Hub 首屏开关', () => {
  it('Hub 关闭时，导入历史展开项目后首屏仍应收起', async () => {
    const { importNodeGraphFromBundle } = await loadImporter(false);
    const file = await buildBundleFile(false);

    const imported = await importNodeGraphFromBundle(file);

    expect(imported.valid).toBe(true);
    expect(readInlineControlsCollapsed(imported.nodeGraph?.nodes[0])).toBe(true);
  });

  it('Hub 开启时，导入历史收起项目后首屏仍应展开', async () => {
    const { importNodeGraphFromBundle } = await loadImporter(true);
    const file = await buildBundleFile(true);

    const imported = await importNodeGraphFromBundle(file);

    expect(imported.valid).toBe(true);
    expect(readInlineControlsCollapsed(imported.nodeGraph?.nodes[0])).toBe(false);
  });

  it('首次读不到 Hub 配置时，应直接导入失败，而不是偷偷按 false 收起', async () => {
    vi.resetModules();
    startupConfigMock.getResolvedExpandInlineParamsOnStartup.mockRejectedValue(
      new Error('无法读取 Hub 中“启动时展开节点参数区域”的可信配置')
    );
    startupConfigMock.peekResolvedExpandInlineParamsOnStartup.mockReturnValue(false);

    const [{ importNodeGraphFromBundle }, { nodeRegistry }] = await Promise.all([
      import('@/features/canvas/export/importBundle'),
      import('@/features/canvas/nodes/registry'),
    ]);

    const modelKey = '__test-bundle-inline-model__';
    if (!nodeRegistry.get(modelKey)) {
      nodeRegistry.register({
        type: 'model',
        modelId: modelKey,
        providerId: 'test',
        label: 'Bundle 导入启动规则测试模型',
        category: 'model',
        inputs: [],
        outputs: [],
        defaultSize: { width: 420, height: 360 },
        defaultData: {
          label: 'Bundle 导入启动规则测试模型',
          modelId: modelKey,
          formValues: {},
          portMapping: {},
          inlineControlsCollapsed: false,
        },
      });
    }

    const file = await buildBundleFile(true);
    const imported = await importNodeGraphFromBundle(file);

    expect(imported.valid).toBe(false);
    expect(imported.errors[0]).toContain('读取导入设置失败，请重新打开项目后再试');
  });
});
