import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeGraph } from '../../types/nodeGraph';
import { useCanvasStore } from '../../store/canvasStore';
import { createDerivedImageInputNode } from '../imageDerivation';
import { createDerivedVideoInputNode } from '../videoDerivation';
import type { GraphNode, ImageInputNodeData, NodeGraph, VideoInputNodeData } from '../../types';
import type { MediaAsset } from '@iart/contracts';
import {
  createMediaAssetFixture,
  createTestNodeGraphParams,
} from '../../components/__tests__/fixtures/canvasTestBuilders';

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
  });
};

const requireValue = <T>(value: T | null | undefined, message: string): T => {
  expect(value).toBeTruthy();
  if (value == null) {
    throw new Error(message);
  }
  return value;
};

const requireGraph = (): NodeGraph =>
  requireValue(useCanvasStore.getState().nodeGraph, 'nodeGraph 为空');

const isVideoInputNode = (node: GraphNode): node is GraphNode<VideoInputNodeData> =>
  node.type === 'videoInput';

const isImageInputNode = (node: GraphNode): node is GraphNode<ImageInputNodeData> =>
  node.type === 'imageInput';

const requireVideoInputNode = (graph: NodeGraph, nodeId: string): GraphNode<VideoInputNodeData> => {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  expect(node).toBeDefined();
  if (!node || !isVideoInputNode(node)) {
    throw new Error(`未找到 videoInput 节点: ${nodeId}`);
  }
  return node;
};

const requireImageInputNode = (graph: NodeGraph, nodeId: string): GraphNode<ImageInputNodeData> => {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  expect(node).toBeDefined();
  if (!node || !isImageInputNode(node)) {
    throw new Error(`未找到 imageInput 节点: ${nodeId}`);
  }
  return node;
};

const createVideoMediaAsset = (id: string, url: string): MediaAsset => createMediaAssetFixture({
  id,
  mediaType: 'video',
  original: {
    url,
    projectRef: 'prj_demo',
    fileKey: url.replace('/project-media/prj_demo/', ''),
    sourceUrl: '/project-media/prj_demo/source.mp4',
    sourceFileName: null,
    mimeType: 'video/mp4',
    sizeBytes: null,
    width: 1920,
    height: 1080,
    durationMs: null,
    fps: null,
  },
});

const createSelectionRecorder = () => {
  const calls: Array<{ nodeIds: string[]; reason: string }> = [];
  return {
    calls,
    selectNodes: (nodeIds: string[], reason: string) => {
      calls.push({ nodeIds, reason });
    },
  };
};

describe('createDerivedVideoInputNode', () => {
  beforeEach(() => {
    resetStore();
  });

  it('视频裁切应当创建派生 videoInput 节点并写入血缘（源节点不变）', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const source = requireValue(
      useCanvasStore.getState().addNode(
        'videoInput',
        { x: 0, y: 0 },
        { videoUrl: '/files/source.mp4', valueSource: 'upload' }
      ),
      'source 节点创建失败'
    );

    const selection = createSelectionRecorder();
    const trimOp = {
      type: 'videoTrim' as const,
      startTime: 1.5,
      endTime: 4,
      withAudio: true,
      sourceAssetId: 'asset-source',
      sourceSlotId: undefined,
    };
    const created = requireValue(
      createDerivedVideoInputNode({
        sourceNodeId: source.id,
        resultUrl: '/project-media/prj_demo/clips/derived.mp4',
        assetId: 'asset-derived-video',
        mediaAsset: createVideoMediaAsset('asset-derived-video', '/project-media/prj_demo/clips/derived.mp4'),
        derivedOp: trimOp,
        videoMeta: null,
        selectNodes: selection.selectNodes,
      }),
      '派生视频节点创建失败'
    );

    const stored = requireGraph();
    const derivedNode = requireVideoInputNode(stored, created.id);
    expect(derivedNode.data.videoUrl).toBe('/project-media/prj_demo/clips/derived.mp4');
    expect(derivedNode.data.assetId).toBe('asset-derived-video');
    expect(derivedNode.data.valueSource).toBe('processed');
    expect(derivedNode.data.derivedFromNodeId).toBe(source.id);
    expect(derivedNode.data.derivedOp).toEqual(trimOp);

    // 素材节点不持有输入端口：血缘由节点 data 承载

    // 非破坏：源节点内容与数据保持不变
    const sourceAfter = requireVideoInputNode(stored, source.id);
    expect(sourceAfter.data.videoUrl).toBe('/files/source.mp4');
    expect(sourceAfter.data.valueSource).toBe('upload');
    expect(sourceAfter.data.derivedFromNodeId).toBeUndefined();
    expect(sourceAfter.data.derivedOp).toBeUndefined();

    // 产出资产注册进项目媒体资产表
    expect(stored.nodes.length).toBe(2);
    expect(selection.calls).toEqual([{ nodeIds: [created.id], reason: 'video-derivation' }]);
  });

  it('源节点不存在或缺少结果资产时不创建节点', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const missingSource = createDerivedVideoInputNode({
      sourceNodeId: 'not-exists',
      resultUrl: '/project-media/prj_demo/clips/x.mp4',
      assetId: 'asset-x',
      mediaAsset: undefined,
      derivedOp: {
        type: 'videoTrim',
        startTime: 0,
        endTime: 1,
        withAudio: true,
        sourceAssetId: undefined,
        sourceSlotId: undefined,
      },
      videoMeta: null,
    });
    expect(missingSource).toBeNull();

    const source = requireValue(
      useCanvasStore.getState().addNode(
        'videoInput',
        { x: 0, y: 0 },
        { videoUrl: '/files/source.mp4', valueSource: 'upload' }
      ),
      'source 节点创建失败'
    );

    const missingAsset = createDerivedVideoInputNode({
      sourceNodeId: source.id,
      resultUrl: '/project-media/prj_demo/clips/x.mp4',
      assetId: '',
      mediaAsset: undefined,
      derivedOp: {
        type: 'videoTrim',
        startTime: 0,
        endTime: 1,
        withAudio: true,
        sourceAssetId: undefined,
        sourceSlotId: undefined,
      },
      videoMeta: null,
    });
    expect(missingAsset).toBeNull();
    expect(requireGraph().nodes.length).toBe(1);
  });
});

describe('视频截帧派生（createDerivedImageInputNode + videoFrameCapture）', () => {
  beforeEach(() => {
    resetStore();
  });

  it('视频截帧应当创建派生 imageInput 节点并写入血缘（源节点不变）', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const source = requireValue(
      useCanvasStore.getState().addNode(
        'videoInput',
        { x: 0, y: 0 },
        { videoUrl: '/files/source.mp4', valueSource: 'upload' }
      ),
      'source 节点创建失败'
    );

    const captureOp = {
      type: 'videoFrameCapture' as const,
      timeSec: 2.5,
      sourceAssetId: 'asset-source',
      sourceSlotId: undefined,
    };
    const created = requireValue(
      createDerivedImageInputNode({
        sourceNodeId: source.id,
        resultUrl: '/project-media/prj_demo/processed/frame.png',
        assetId: 'asset-frame',
        mediaAsset: createMediaAssetFixture({ id: 'asset-frame' }),
        derivedOp: captureOp,
      }),
      '截帧派生节点创建失败'
    );

    const stored = requireGraph();
    const derivedNode = requireImageInputNode(stored, created.id);
    expect(derivedNode.data.imageUrl).toBe('/project-media/prj_demo/processed/frame.png');
    expect(derivedNode.data.valueSource).toBe('processed');
    expect(derivedNode.data.derivedFromNodeId).toBe(source.id);
    expect(derivedNode.data.derivedOp).toEqual(captureOp);

    const sourceAfter = requireVideoInputNode(stored, source.id);
    expect(sourceAfter.data.videoUrl).toBe('/files/source.mp4');
    expect(sourceAfter.data.valueSource).toBe('upload');
  });
});
