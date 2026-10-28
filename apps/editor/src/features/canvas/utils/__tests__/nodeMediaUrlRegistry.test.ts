import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { MediaAsset, ProjectMediaAssets } from '@iart/contracts';
import type {
  AssetNodeData,
  AudioInputNodeData,
  GraphNode,
  GroupNodeData,
  ImageInputNodeData,
  VideoInputNodeData,
} from '../../types/node';

const mockCanvasStoreState: { mediaAssets: ProjectMediaAssets } = {
  mediaAssets: {},
};

vi.mock('../../store', () => {
  const useCanvasStore = <T,>(
    selector: (state: typeof mockCanvasStoreState) => T,
  ) => selector(mockCanvasStoreState);
  useCanvasStore.getState = () => mockCanvasStoreState;
  return { useCanvasStore };
});

vi.mock('../../services/resultAreaMediaSlots', () => ({
  resolveMediaSlotValue: vi.fn(() => null),
}));

import { getNodeMediaUrlForReveal } from '../nodeMediaUrlRegistry';

const buildMediaAsset = (
  id: string,
  url: string | undefined,
): MediaAsset => ({
  id,
  mediaType: 'image',
  original: {
    url: url ?? '',
    projectRef: null,
    fileKey: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
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

const buildAssetNode = (
  assetId: string | undefined,
): GraphNode<AssetNodeData> => ({
  id: 'asset-1',
  type: 'asset',
  position: { x: 0, y: 0 },
  data: {
    label: '资产节点',
    sourceBatchId: 'batch-1',
    sourceTaskId: 'task-1',
    sourceModelId: 'mock-model',
    mediaType: 'image',
    assetId: assetId ?? '',
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe('nodeMediaUrlRegistry asset 提取器', () => {
  beforeEach(() => {
    mockCanvasStoreState.mediaAssets = {};
  });

  it('按 assetId 从 mediaAssets 解析 original.url', () => {
    mockCanvasStoreState.mediaAssets = {
      'asset-1': buildMediaAsset('asset-1', 'local-media://prj_0123456789abcdef0123456789abcdef/a.png'),
    };
    expect(getNodeMediaUrlForReveal(buildAssetNode('asset-1'))).toBe(
      'local-media://prj_0123456789abcdef0123456789abcdef/a.png',
    );
  });

  it('视频与音频资产走同一 assetId 解析路径', () => {
    mockCanvasStoreState.mediaAssets = {
      'asset-v': buildMediaAsset('asset-v', 'local-media://prj_0123456789abcdef0123456789abcdef/a.mp4'),
      'asset-a': buildMediaAsset('asset-a', 'local-media://prj_0123456789abcdef0123456789abcdef/a.wav'),
    };
    const videoNode = {
      ...buildAssetNode('asset-v'),
      data: { ...buildAssetNode('asset-v').data, mediaType: 'video' as const },
    };
    const audioNode = {
      ...buildAssetNode('asset-a'),
      data: { ...buildAssetNode('asset-a').data, mediaType: 'audio' as const },
    };
    expect(getNodeMediaUrlForReveal(videoNode)).toBe(
      'local-media://prj_0123456789abcdef0123456789abcdef/a.mp4',
    );
    expect(getNodeMediaUrlForReveal(audioNode)).toBe(
      'local-media://prj_0123456789abcdef0123456789abcdef/a.wav',
    );
  });

  it('assetId 缺失或资产不在 store 中返回 null', () => {
    expect(getNodeMediaUrlForReveal(buildAssetNode(undefined))).toBeNull();
    expect(getNodeMediaUrlForReveal(buildAssetNode('missing-id'))).toBeNull();
  });

  it('original.url 为空或空白时返回 null，非空白 URL 去首尾空白', () => {
    mockCanvasStoreState.mediaAssets = {
      'asset-1': buildMediaAsset('asset-1', '   '),
    };
    expect(getNodeMediaUrlForReveal(buildAssetNode('asset-1'))).toBeNull();
    mockCanvasStoreState.mediaAssets = {
      'asset-1': buildMediaAsset('asset-1', '  local-media://k/b.png  '),
    };
    expect(getNodeMediaUrlForReveal(buildAssetNode('asset-1'))).toBe(
      'local-media://k/b.png',
    );
  });
});

describe('nodeMediaUrlRegistry 素材节点提取器', () => {
  const buildMaterialNode = <T extends GraphNode['data']>(
    type: GraphNode['type'],
    data: T,
  ): GraphNode => ({
    id: 'n-1',
    type,
    position: { x: 0, y: 0 },
    data,
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  });

  const buildGroupData = (name: string): GroupNodeData => ({
    label: '节点组',
    description: undefined,
    runtimeRef: undefined,
    name,
    collapsed: false,
    color: undefined,
  });

  const buildImageInputData = (imageUrl: string): ImageInputNodeData => ({
    label: '图片素材',
    description: undefined,
    runtimeRef: undefined,
    assetId: undefined,
    imageUrl,
    imageMeta: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    valueSource: undefined,
    mediaError: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
  });

  const buildVideoInputData = (videoUrl: string): VideoInputNodeData => ({
    label: '视频素材',
    description: undefined,
    runtimeRef: undefined,
    assetId: undefined,
    videoUrl,
    videoMeta: undefined,
    valueSource: undefined,
    mediaError: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
  });

  const buildAudioInputData = (audioUrl: string): AudioInputNodeData => ({
    label: '音频素材',
    description: undefined,
    runtimeRef: undefined,
    assetId: undefined,
    audioUrl,
    valueSource: undefined,
    mediaError: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    taskInfo: undefined,
    cachedContent: undefined,
    duration: undefined,
    segments: undefined,
    segmentModeEnabled: undefined,
  });

  it('imageInput/videoInput/audioInput 分别读自身 URL 字段', () => {
    expect(
      getNodeMediaUrlForReveal(
        buildMaterialNode('imageInput', buildImageInputData('local-media://k/i.png')),
      ),
    ).toBe('local-media://k/i.png');
    expect(
      getNodeMediaUrlForReveal(
        buildMaterialNode('videoInput', buildVideoInputData('local-media://k/v.mp4')),
      ),
    ).toBe('local-media://k/v.mp4');
    expect(
      getNodeMediaUrlForReveal(
        buildMaterialNode('audioInput', buildAudioInputData('local-media://k/a.wav')),
      ),
    ).toBe('local-media://k/a.wav');
  });

  it('未注册类型（group）返回 null', () => {
    const groupNode = buildMaterialNode('group', buildGroupData('组一'));
    expect(getNodeMediaUrlForReveal(groupNode)).toBeNull();
  });
});
