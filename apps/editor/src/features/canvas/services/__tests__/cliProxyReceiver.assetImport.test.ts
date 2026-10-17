// @vitest-environment jsdom
// @spec: CLI-047
//
// CLI 素材导入接缝测试（spec §5.3 asset import；契约 packages/contracts/src/cli-asset-import-contract.ts）：
// 输入从真实链路源头产生（真实 CliProxyCommandSchema 构造命令 → 真实接收器
// executeCliProxyCommand → 真实导入链内层 static importMediaBytes → 真实 addNode 落图），
// 只在最外层挡掉 storage IPC（假 read-file-bytes / 假 import-local-media / 假 upsert-media-asset）
// 与缩略图服务（网络/ffmpeg 边界）。
// 断言覆盖：单文件成功链（媒体节点类型正确 + 图片尺寸对齐界面语义 + imported 回传 + 一步撤销 +
// 选中态不变）、多文件合批一步撤销、前置校验原子性（任一文件不可读 → file_not_found 整体拒绝；
// 任一文件类型不支持 → unsupported_file_type 整体拒绝；两种拒绝均零副作用）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRuntimeProjectPathMock = vi.fn(() => '/tmp/iart-cli-asset-import-test');
vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => getRuntimeProjectPathMock(),
}));

const ensureImageThumbnailMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../imageThumbnailService', () => ({
  ensureImageThumbnail: (...args: unknown[]) => ensureImageThumbnailMock(...args),
}));

const ensureVideoThumbnailMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../videoThumbnailService', () => ({
  ensureVideoThumbnail: (...args: unknown[]) => ensureVideoThumbnailMock(...args),
}));

import { CliProxyCommandResponseSchema, CliProxyCommandSchema } from '@iart/contracts';
import type { CliProxyCommandResponse, MediaAsset } from '@iart/contracts';
import type {
  StorageImportLocalMediaParams,
  StorageImportLocalMediaResult,
  StorageReadFileBytesParams,
  StorageReadFileBytesResult,
  StorageUpsertMediaAssetParams,
  StorageUpsertMediaAssetResult,
} from '@iart/contracts/editor-storage-contract';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AudioInputNodeData, ImageInputNodeData, VideoInputNodeData } from '../../types/node';
import { executeCliProxyCommand } from '../cliProxyReceiver';

// ---------------------------------------------------------------------------
// 假 storage IPC（沿 localMediaImport.test.ts 惯例：window.electron.storage 通道替身）
// ---------------------------------------------------------------------------

type ReadFileBytesInvoke = (args: StorageReadFileBytesParams) => Promise<StorageReadFileBytesResult>;
type ImportLocalMediaInvoke = (args: StorageImportLocalMediaParams) => Promise<StorageImportLocalMediaResult>;
type UpsertMediaAssetInvoke = (args: StorageUpsertMediaAssetParams) => Promise<StorageUpsertMediaAssetResult>;

const readFileBytesMock = vi.fn<ReadFileBytesInvoke>();
const importLocalMediaMock = vi.fn<ImportLocalMediaInvoke>();
const upsertMediaAssetMock = vi.fn<UpsertMediaAssetInvoke>();

const installElectronStorage = () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      storage: {
        'storage:read-file-bytes': (args: StorageReadFileBytesParams) => readFileBytesMock(args),
        'storage:import-local-media': (args: StorageImportLocalMediaParams) => importLocalMediaMock(args),
        'storage:upsert-media-asset': (args: StorageUpsertMediaAssetParams) => upsertMediaAssetMock(args),
      },
    },
  });
};

const makeAsset = (overrides: {
  id: string;
  mediaType: MediaAsset['mediaType'];
  url: string;
  width?: number | null;
  height?: number | null;
}): MediaAsset => ({
  id: overrides.id,
  mediaType: overrides.mediaType,
  original: {
    url: overrides.url,
    fileKey: overrides.url.startsWith('local-media://') ? overrides.url.slice('local-media://'.length) : null,
    projectRef: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: overrides.mediaType === 'video' ? 'video/mp4' : 'image/png',
    sizeBytes: 3,
    width: overrides.width ?? null,
    height: overrides.height ?? null,
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
});

const bytesResult = (dataBase64: string): StorageReadFileBytesResult => ({
  dataBase64,
  sizeBytes: 3,
});

// ---------------------------------------------------------------------------
// store 种床（沿 cliProxyReceiver.generateGroup.test.ts 惯例：真实 store + setState 种数据）
// ---------------------------------------------------------------------------

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-asset-import-seam-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.ui.canvasContainerSize = null;
  });
};

const loadTestGraph = async (): Promise<void> => {
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
  useCanvasStore.setState((state) => {
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
  // 落一条基线历史：载图留下的是 deferredHistoryBaseline（首次 saveToHistory 时会与
  // 新条目一并入栈），先收口基线才能以「基线 + 1」断言导入合批的撤销步数。
  useCanvasStore.getState().saveToHistory();
};

const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

const nodes = () => useCanvasStore.getState().nodeGraph?.nodes ?? [];

const findNode = (nodeId: string) => nodes().find((node) => node.id === nodeId) ?? null;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('Image', class MockImage {
    naturalWidth = 800;
    naturalHeight = 600;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:cli-asset-import-test'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  // 载图会经 isHubRuntime()（window.electron 存在即判 Hub 运行时）拉取启动设置：
  // 每个用例先清掉上一个用例残留的桥再载图，载图完成后才挂假 storage 桥。
  Object.defineProperty(window, 'electron', { configurable: true, value: undefined });
  getRuntimeProjectPathMock.mockReturnValue('/tmp/iart-cli-asset-import-test');
  ensureImageThumbnailMock.mockResolvedValue(undefined);
  ensureVideoThumbnailMock.mockResolvedValue(undefined);
  resetStore();
  await loadTestGraph();
  installElectronStorage();
});

describe('CLI 素材导入（CLI-047）', () => {
  it('单文件成功链：经既有导入链写盘登记 → 图片素材节点落图 → imported 回传 → 一步撤销且选中态不变', async () => {
    readFileBytesMock.mockResolvedValue(bytesResult('AQID'));
    importLocalMediaMock.mockResolvedValue({
      url: 'local-media://image/cli-photo.png',
      fileName: 'cli-photo.png',
      isNew: true,
      sizeBytes: 3,
    });
    upsertMediaAssetMock.mockResolvedValue({
      assetId: 'asset_cli_1',
      asset: makeAsset({
        id: 'asset_cli_1',
        mediaType: 'image',
        url: 'local-media://image/cli-photo.png',
        width: 800,
        height: 600,
      }),
    });
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['keep-selected'];
    });
    const historyBefore = useCanvasStore.getState().history.length;
    const nodesBefore = nodes().length;

    const command = CliProxyCommandSchema.parse({
      command: 'asset.import',
      request_id: 'req-asset-1',
      file: ['/tmp/iart-cli/cli-photo.png'],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('imported' in response)) throw new Error('expected asset import success response');
    // 回传：原始文件名 + 资产标识 + 画布节点标识 + 媒体类型（按输入顺序对应）
    expect(response.imported).toHaveLength(1);
    const entry = response.imported[0];
    if (entry === undefined) throw new Error('expected one imported entry');
    expect(entry.file_name).toBe('cli-photo.png');
    expect(entry.asset_id).toBe('asset_cli_1');
    expect(entry.media_type).toBe('image');

    // 节点创建：类型正确 + 持有 assetId 与持久化 URL（与界面拖入同一 data 形状）
    expect(nodes().length).toBe(nodesBefore + 1);
    const node = findNode(entry.node_id);
    expect(node).not.toBeNull();
    expect(node?.type).toBe('imageInput');
    const imageData = node?.data as ImageInputNodeData | undefined;
    expect(imageData?.assetId).toBe('asset_cli_1');
    expect(imageData?.imageUrl).toBe('local-media://image/cli-photo.png');
    expect(imageData?.valueSource).toBe('upload');

    // 写盘登记沿既有通道载荷口径（原始文件名 + 字节 + MIME）
    expect(readFileBytesMock).toHaveBeenCalledWith({ filePath: '/tmp/iart-cli/cli-photo.png' });
    const importCall = importLocalMediaMock.mock.calls[0]?.[0];
    expect(importCall?.projectPath).toBe('/tmp/iart-cli-asset-import-test');
    expect(importCall?.fileDataBase64).toBe('AQID');
    expect(importCall?.mimeType).toBe('image/png');
    expect(importCall?.originalFileName).toBe('cli-photo.png');
    // 图片尺寸对齐界面语义（读回字节 → blob URL → Image 取宽高）
    const upsertCall = upsertMediaAssetMock.mock.calls[0]?.[0];
    expect(upsertCall?.params).toMatchObject({
      mediaType: 'image',
      url: 'local-media://image/cli-photo.png',
      sourceFileName: 'cli-photo.png',
      width: 800,
      height: 600,
    });

    // 撤销：多文件/单文件导入收口为一条历史
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
    expect(useCanvasStore.getState().historyBatchActive).toBe(false);
    useCanvasStore.getState().undo();
    expect(findNode(entry.node_id)).toBeNull();
  });

  it('单文件成功链不触碰选中态（程序化导入不选中新节点）', async () => {
    readFileBytesMock.mockResolvedValue(bytesResult('AQID'));
    importLocalMediaMock.mockResolvedValue({
      url: 'local-media://image/cli-photo.png',
      fileName: 'cli-photo.png',
      isNew: true,
      sizeBytes: 3,
    });
    upsertMediaAssetMock.mockResolvedValue({
      assetId: 'asset_cli_1',
      asset: makeAsset({ id: 'asset_cli_1', mediaType: 'image', url: 'local-media://image/cli-photo.png', width: 800, height: 600 }),
    });
    useCanvasStore.setState((state) => {
      state.selectedNodeIds = ['keep-selected'];
      state.selectedAnnotationIds = ['keep-annotation'];
    });

    const command = CliProxyCommandSchema.parse({
      command: 'asset.import',
      request_id: 'req-asset-2',
      file: ['/tmp/iart-cli/cli-photo.png'],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('imported' in response)) throw new Error('expected asset import success response');
    expect(response.imported).toHaveLength(1);
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['keep-selected']);
    expect(useCanvasStore.getState().selectedAnnotationIds).toEqual(['keep-annotation']);
  });

  it('多文件成功链：整批排成一块、逐文件建对应类型素材节点、一步撤销回到导入前', async () => {
    readFileBytesMock.mockImplementation(async (args) => {
      if (args.filePath === '/tmp/iart-cli/cli-photo.png') return bytesResult('AQID');
      if (args.filePath === '/tmp/iart-cli/cli-clip.mp4') return bytesResult('BAUG');
      if (args.filePath === '/tmp/iart-cli/cli-voice.mp3') return bytesResult('BwgJ');
      throw new Error(`unexpected path: ${args.filePath}`);
    });
    importLocalMediaMock.mockImplementation(async (args) => ({
      url: `local-media://${args.originalFileName}`,
      fileName: args.originalFileName,
      isNew: true,
      sizeBytes: 3,
    }));
    upsertMediaAssetMock.mockImplementation(async (args) => ({
      assetId: `asset_${args.params.mediaType}`,
      asset: makeAsset({
        id: `asset_${args.params.mediaType}`,
        mediaType: args.params.mediaType,
        url: args.params.url,
      }),
    }));
    const historyBefore = useCanvasStore.getState().history.length;

    const command = CliProxyCommandSchema.parse({
      command: 'asset.import',
      request_id: 'req-asset-3',
      file: ['/tmp/iart-cli/cli-photo.png', '/tmp/iart-cli/cli-clip.mp4', '/tmp/iart-cli/cli-voice.mp3'],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('imported' in response)) throw new Error('expected asset import success response');
    expect(response.imported.map((entry) => [entry.file_name, entry.media_type])).toEqual([
      ['cli-photo.png', 'image'],
      ['cli-clip.mp4', 'video'],
      ['cli-voice.mp3', 'audio'],
    ]);

    const createdNodes = response.imported.map((entry) => findNode(entry.node_id));
    expect(createdNodes.map((node) => node?.type)).toEqual(['imageInput', 'videoInput', 'audioInput']);
    const videoData = createdNodes[1]?.data as VideoInputNodeData | undefined;
    expect(videoData?.videoUrl).toBe('local-media://cli-clip.mp4');
    const audioData = createdNodes[2]?.data as AudioInputNodeData | undefined;
    expect(audioData?.audioUrl).toBe('local-media://cli-voice.mp3');

    // 整批一块：网格行列排布（同行 y 相同、逐格横向步进且互不重叠）
    const positions = createdNodes.map((node) => node?.position);
    expect(positions[0]?.y).toBe(positions[1]?.y);
    expect(positions[1]?.x ?? 0).toBeGreaterThan(positions[0]?.x ?? 0);
    expect(positions[2]?.x ?? 0).toBeGreaterThan(positions[1]?.x ?? 0);

    // 一步撤销包含全部节点
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore + 1);
    useCanvasStore.getState().undo();
    for (const entry of response.imported) {
      expect(findNode(entry.node_id)).toBeNull();
    }
  });

  it('前置校验原子性：任一文件不可读 → file_not_found 整体拒绝、零副作用（不写盘、不建节点）', async () => {
    readFileBytesMock.mockImplementation(async (args) => {
      if (args.filePath === '/tmp/iart-cli/cli-photo.png') return bytesResult('AQID');
      throw new Error(`ENOENT: no such file or directory, open '${args.filePath}'`);
    });
    const historyBefore = useCanvasStore.getState().history.length;
    const nodesBefore = nodes().length;

    const command = CliProxyCommandSchema.parse({
      command: 'asset.import',
      request_id: 'req-asset-4',
      file: ['/tmp/iart-cli/cli-photo.png', '/tmp/iart-cli/missing.png'],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('error' in response)) throw new Error('expected asset import error response');
    expect(response.error.code).toBe('file_not_found');
    expect(response.error.message).toContain('/tmp/iart-cli/missing.png');
    expect(importLocalMediaMock).not.toHaveBeenCalled();
    expect(upsertMediaAssetMock).not.toHaveBeenCalled();
    expect(nodes().length).toBe(nodesBefore);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore);
    expect(useCanvasStore.getState().historyBatchActive).toBe(false);
  });

  it('前置校验原子性：任一文件类型不支持 → unsupported_file_type 整体拒绝、零副作用', async () => {
    readFileBytesMock.mockResolvedValue(bytesResult('AQID'));
    const historyBefore = useCanvasStore.getState().history.length;
    const nodesBefore = nodes().length;

    const command = CliProxyCommandSchema.parse({
      command: 'asset.import',
      request_id: 'req-asset-5',
      file: ['/tmp/iart-cli/cli-photo.png', '/tmp/iart-cli/notes.txt'],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('error' in response)) throw new Error('expected asset import error response');
    expect(response.error.code).toBe('unsupported_file_type');
    expect(response.error.message).toContain('notes.txt');
    expect(importLocalMediaMock).not.toHaveBeenCalled();
    expect(upsertMediaAssetMock).not.toHaveBeenCalled();
    expect(nodes().length).toBe(nodesBefore);
    expect(useCanvasStore.getState().history).toHaveLength(historyBefore);
  });

  it('项目未打开（nodeGraph 未载入）拒绝为 project_not_open，不读文件', async () => {
    useCanvasStore.setState((state) => {
      state.nodeGraph = null;
    });

    const command = CliProxyCommandSchema.parse({
      command: 'asset.import',
      request_id: 'req-asset-6',
      file: ['/tmp/iart-cli/cli-photo.png'],
    });
    const response = parseResponse(await executeCliProxyCommand(command));

    if (!('error' in response)) throw new Error('expected asset import error response');
    expect(response.error.code).toBe('project_not_open');
    expect(readFileBytesMock).not.toHaveBeenCalled();
  });
});
