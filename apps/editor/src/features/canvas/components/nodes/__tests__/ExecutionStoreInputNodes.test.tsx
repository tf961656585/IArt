import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GraphNode } from '@/features/canvas/types';
import type {
  AudioInputNodeData,
  ImageInputNodeData,
  NodeTaskInfo,
  TextInputNodeData,
  VideoInputNodeData,
} from '@/features/canvas/types/node';
import {
  createGraphNodeFixture,
  createNodeTaskInfoFixture,
  createTextInputDataFixture,
} from '../../__tests__/fixtures/canvasTestBuilders';

let mockCanvasState: Record<string, unknown>;
let mockExecutionState: Record<string, unknown>;
let mockNodeFromStoreResult: Record<string, unknown>;

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ setCenter: vi.fn() }),
  useUpdateNodeInternals: () => () => undefined,
  useStore: (
    selector: (state: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => unknown,
  ) => selector({ nodes: [], edges: [] }),
}));

vi.mock('../ContentNodeCard', () => ({
  ContentNodeCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../store/canvasStore', () => {
  const useCanvasStore = (selector: (state: Record<string, unknown>) => unknown) => selector(mockCanvasState);
  useCanvasStore.getState = () => mockCanvasState;
  return { useCanvasStore };
});

vi.mock('../../../store/executionStore', () => ({
  useExecutionStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockExecutionState),
}));

vi.mock('../../../hooks/useNodeFromStore', () => ({
  createFallbackGraphNode: ({ nodeId, type }: { nodeId: string; type: string }) => ({
    id: nodeId,
    type,
    position: { x: 0, y: 0 },
    data: {},
    inputs: [],
    outputs: [],
  }),
  resolveFallbackGraphNodeFromNodePropsData: ({ nodeId, type, nodePropsData }: { nodeId: string; type: string; nodePropsData?: Record<string, unknown> }) => ({
    id: nodeId,
    type,
    position: { x: 0, y: 0 },
    data: nodePropsData ?? {},
    inputs: [],
    outputs: [],
  }),
  useNodeFromStore: () => mockNodeFromStoreResult,
}));

vi.mock('../shared/ImageNodeSurface', () => ({
  DEFAULT_IMAGE_ASPECT_RATIO: 1,
  ImageNodeSurface: ({ overlay, placeholder }: { overlay?: React.ReactNode; placeholder?: React.ReactNode }) => (
    <div>
      <div data-testid="image-surface" />
      {overlay}
      {placeholder}
    </div>
  ),
}));

vi.mock('../shared/VideoNodeSurface', () => ({
  DEFAULT_VIDEO_ASPECT_RATIO: 16 / 9,
  VideoNodeSurface: ({ overlay, placeholder }: { overlay?: React.ReactNode; placeholder?: React.ReactNode }) => (
    <div>
      <div data-testid="video-surface" />
      {overlay}
      {placeholder}
    </div>
  ),
}));

vi.mock('../shared/TaskStatusBadge', () => ({
  TaskStatusBadge: ({ status }: { status: string }) => <div>{status}</div>,
}));

vi.mock('../shared/PromptPresetSlashPopover', () => ({
  PromptPresetSlashPopover: () => null,
}));

vi.mock('../shared/PromptPresetTokenEditor', () => ({
  PromptPresetTokenEditor: ({
    value = '',
    onChange,
  }: {
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <textarea value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

vi.mock('../TextInputNodeToolbar', () => ({
  TextInputNodeToolbar: () => null,
}));

vi.mock('../../dialogs/ImageResizeDialog', () => ({
  ImageResizeDialog: () => null,
}));

vi.mock('../../dialogs/ImageCropDialog', () => ({
  ImageCropDialog: () => null,
}));

vi.mock('../../dialogs/ImageSplitDialog', () => ({
  ImageSplitDialog: () => null,
}));

vi.mock('../../dialogs/ImageAnnotateDialog', () => ({
  ImageAnnotateDialog: () => null,
}));

vi.mock('../../dialogs/ImageEdgeDetectDialog', () => ({
  ImageEdgeDetectDialog: () => null,
}));

vi.mock('../../dialogs/ImageChromaKeyDialog', () => ({
  ImageChromaKeyDialog: () => null,
}));

vi.mock('../../dialogs/ImageDifferenceKeyDialog', () => ({
  ImageDifferenceKeyDialog: () => null,
}));

vi.mock('../../dialogs/ImageSmartSplitDialog', () => ({
  ImageSmartSplitDialog: () => null,
}));

vi.mock('../../dialogs/ImageOutpaintDialog', () => ({
  ImageOutpaintDialog: () => null,
}));

vi.mock('../../dialogs/AudioSegmentDialog', () => ({
  AudioSegmentDialog: () => null,
}));

vi.mock('../../dialogs/TextInputAiEditDialog', () => ({
  TextInputAiEditDialog: () => null,
}));

vi.mock('../../dialogs/TextInputExpandEditDialog', () => ({
  TextInputExpandEditDialog: () => null,
}));

vi.mock('../audio/SegmentList', () => ({
  SegmentList: () => null,
}));

vi.mock('@/client/components/file-upload/imageConstraints', () => ({
  computeFittedSize: (width: number, height: number) => ({ width, height }),
}));

vi.mock('@/client/utils/download', () => ({
  downloadMedia: vi.fn(),
}));

vi.mock('../../../hooks/useNonPassiveWheel', () => ({
  useNonPassiveWheel: vi.fn(),
}));

vi.mock('../../../services/contentCacheManager', () => ({
  ContentCacheManager: {
    getTask: vi.fn(() => null),
    enqueue: vi.fn(),
  },
}));

vi.mock('@/client/api/upload', () => ({
  uploadImageFile: vi.fn(),
  uploadMediaBlob: vi.fn(),
}));

vi.mock('@/client/api/imageEdgeDetect', () => ({
  edgeDetectImage: vi.fn(),
}));

vi.mock('@/client/api/imageCrop', () => ({
  cropImage: vi.fn(),
}));

vi.mock('@/client/api/imageResize', () => ({
  resizeImage: vi.fn(),
}));

vi.mock('@/client/api/imageSplit', () => ({
  splitImage: vi.fn(),
}));

vi.mock('../../../utils/imageDerivation', () => ({
  createDerivedImageInputNode: vi.fn(),
  createDerivedImageInputNodesGrid: vi.fn(),
}));

vi.mock('../../../utils/mediaUtils', () => ({
  ensureLocalFilesImageUrl: (value: string) => value,
}));

vi.mock('../../../utils/mediaUrl', () => ({
  normalizeLocalFileUrlWithQuery: (value: string | null | undefined) =>
    typeof value === 'string' && value.startsWith('/files/') ? value : null,
  resolveLocalRenderableMediaSource: (value: string | null | undefined) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    const formalUrl =
      trimmed.startsWith('local-media://') || trimmed.startsWith('/files/') ? trimmed : null;
    return {
      formalUrl,
      renderUrl: formalUrl,
      error: trimmed && !formalUrl ? '输出未落盘，无法预览' : null,
    };
  },
}));

vi.mock('../../../utils/mediaSize', () => ({
  formatBytesCompact: () => '1 KB',
  getMediaSizeBytes: vi.fn(async () => null),
}));

vi.mock('../../../utils/taskStatusMeta', () => ({
  getTaskStatusOverlayText: () => null,
}));

vi.mock('../../../storage', () => ({
  clearNodeOutput: vi.fn(),
}));

vi.mock('@/client/utils/electronBridge', () => ({
  revealRequestLog: vi.fn(async () => ({ ok: true })),
  revealTaskRequestLog: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../services/imageOutpaint', () => ({
  outpaintImageWithModel: vi.fn(),
}));

vi.mock('@/features/models/shared/imageGenerationOptions', () => ({
  parseAspectRatio: vi.fn(() => ({ width: 1, height: 1 })),
}));

vi.mock('@/client/utils/revealFilesUrlWithToast', () => ({
  revealFilesUrlWithToast: vi.fn(),
}));

vi.mock('../imageOutpaintTaskSubmission', () => ({
  bindOutpaintTaskInfo: vi.fn(),
  createOutpaintTaskInfo: vi.fn(),
}));

vi.mock('../../../nodes/audio/AudioNodeFactory', () => ({
  generateAudioOutputPorts: () => [],
}));

vi.mock('../../../nodes/textInput/enhancedTextNode', () => ({
  composeEnhancedTextInput: ({ data }: { data?: { segments?: Array<{ kind: string; text?: string }> } }) => {
    const segments = data?.segments ?? [];
    return segments
      .map((segment: { kind: string; text?: string }) => segment.text ?? '')
      .join('');
  },
  createLocalTextSegment: (text = '') => ({ kind: 'local', id: 'local-1', text, enabled: true }),
  prunePromptPresetSnapshots: ({ promptPresetSnapshots }: { promptPresetSnapshots?: unknown }) => promptPresetSnapshots,
}));

vi.mock('../../../engine/StaticOutputProvider', () => ({
  deriveStaticOutputs: () => undefined,
}));

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { ImageInputNode } from '../ImageInputNode';
import { VideoInputNode } from '../VideoInputNode';
import { AudioInputNode } from '../AudioInputNode';
import { TextInputNode } from '../TextInputNode';

const createFailedTaskInfo = (): NodeTaskInfo => ({
  ...createNodeTaskInfoFixture(),
  taskId: 'task-1',
  modelId: 'mock-model',
  status: 'failed',
  error: '生成失败',
  createdAt: 1,
  updatedAt: 1,
});

const createImageInputData = (taskInfo: NodeTaskInfo): ImageInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: null,
  imageUrl: null,
  imageMeta: null,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  valueSource: undefined,
  mediaError: undefined,
  derivedFromNodeId: undefined,
  derivedOp: undefined,
  taskInfo,
  cachedContent: undefined,
  originalImageMeta: null,
  resizePercent: undefined,
  outpaintModelId: undefined,
});

const createVideoInputData = (taskInfo: NodeTaskInfo): VideoInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: null,
  videoUrl: null,
  videoMeta: null,
  valueSource: undefined,
  mediaError: undefined,
  derivedFromNodeId: undefined,
  derivedOp: undefined,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  taskInfo,
  cachedContent: undefined,
});

const createAudioInputData = (taskInfo: NodeTaskInfo): AudioInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: undefined,
  audioUrl: null,
  valueSource: undefined,
  mediaError: undefined,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  taskInfo,
  cachedContent: undefined,
  duration: undefined,
  segments: undefined,
  segmentModeEnabled: undefined,
});

const renderNode = (element: React.ReactElement, node: GraphNode) => {
  mockCanvasState = {
    ...mockCanvasState,
    nodeGraph: {
      id: 'graph-1',
      nodes: [node],
      edges: [],
    },
  };
  return render(element);
};

describe('executionStore 输入节点诊断边界', () => {
  beforeEach(() => {
    mockCanvasState = {
      nodeGraph: {
        id: 'graph-1',
        nodes: [],
        edges: [],
      },
      updateNodeData: vi.fn(),
      selectedNodeIds: ['node-1'],
    };
    mockExecutionState = {
      getNodeDiagnosticInfo: () => ({ backendMessage: '后端调试详情' }),
    };
    mockNodeFromStoreResult = {
      node: null,
      data: {},
      inputs: [],
      outputs: [],
    };
  });

  it('ImageInputNode 通过诊断 accessor 展示 backendMessage', () => {
    const node: GraphNode<ImageInputNodeData> = createGraphNodeFixture({
      id: 'node-1',
      type: 'imageInput',
      data: createImageInputData(createFailedTaskInfo()),
    });
    mockNodeFromStoreResult = { node, data: node.data, inputs: [], outputs: [] };

    renderNode(
      <ImageInputNode
        id="node-1"
        type="imageInput"
        data={{ ...node.data }}
        selected={false}
        draggable={true}
        dragging={false}
        zIndex={0}
        selectable={true}
        deletable={true}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
      node,
    );

    expect(screen.getByText('后端调试详情')).toBeInTheDocument();
  });

  it('VideoInputNode 通过诊断 accessor 展示 backendMessage', () => {
    const node: GraphNode<VideoInputNodeData> = createGraphNodeFixture({
      id: 'node-1',
      type: 'videoInput',
      data: createVideoInputData(createFailedTaskInfo()),
    });
    mockNodeFromStoreResult = { node, data: node.data, inputs: [], outputs: [] };

    renderNode(
      <VideoInputNode
        id="node-1"
        type="videoInput"
        data={{ ...node.data }}
        selected={false}
        draggable={true}
        dragging={false}
        zIndex={0}
        selectable={true}
        deletable={true}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
      node,
    );

    expect(screen.getByText('后端调试详情')).toBeInTheDocument();
  });

  it('AudioInputNode 通过诊断 accessor 展示 backendMessage', () => {
    const node: GraphNode<AudioInputNodeData> = createGraphNodeFixture({
      id: 'node-1',
      type: 'audioInput',
      data: createAudioInputData(createFailedTaskInfo()),
    });
    mockNodeFromStoreResult = { node, data: node.data, inputs: [], outputs: [] };

    renderNode(
      <AudioInputNode
        id="node-1"
        type="audioInput"
        data={{ ...node.data }}
        selected={false}
        draggable={true}
        dragging={false}
        zIndex={0}
        selectable={true}
        deletable={true}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
      node,
    );

    expect(screen.getByText('后端调试详情')).toBeInTheDocument();
  });

  it('TextInputNode 通过诊断 accessor 展示 backendMessage', () => {
    const node: GraphNode<TextInputNodeData> = createGraphNodeFixture({
      id: 'node-1',
      type: 'textInput',
      data: createTextInputDataFixture({
        segments: [{ kind: 'local', id: 'local-1', text: 'hello', enabled: true }],
        taskInfo: createFailedTaskInfo(),
      }),
    });
    mockNodeFromStoreResult = { node, data: node.data, inputs: [], outputs: [] };

    renderNode(
      <TextInputNode
        id="node-1"
        type="textInput"
        data={{ ...node.data }}
        selected={false}
        draggable={true}
        dragging={false}
        zIndex={0}
        selectable={true}
        deletable={true}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
      node,
    );

    expect(screen.getByText('后端调试详情')).toBeInTheDocument();
  });
});
