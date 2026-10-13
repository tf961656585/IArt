import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '../../../store/canvasStore';
import { useCanvasFileDropImportController } from '../useCanvasFileDropImportController';

const importLocalFileMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../../services/localMediaImport', () => ({
  importLocalFile: (...args: unknown[]) => importLocalFileMock(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

type ControllerArgs = Parameters<typeof useCanvasFileDropImportController>[0];

const CanvasDropTarget = ({ addNode }: { addNode: ControllerArgs['addNode'] }) => {
  const { onDrop } = useCanvasFileDropImportController({
    screenToFlowPosition: ({ x, y }) => ({ x, y }),
    addNode,
  });

  return <div data-testid="canvas-drop-target" onDrop={onDrop} />;
};

describe('useCanvasFileDropImportController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCanvasStore.setState((state) => {
      state.nodeGraph = null;
      state.mediaAssets = {};
      state.selectedNodeIds = [];
    });
  });

  it('拖拽导入 image/video 创建节点时写入 assetId', async () => {
    importLocalFileMock
      .mockResolvedValueOnce({
        persistentUrl: 'local-media://image/dropped.png',
        assetId: 'asset-image-1',
      })
      .mockResolvedValueOnce({
        persistentUrl: 'local-media://video/dropped.mp4',
        assetId: 'asset-video-1',
      });

    const addNode = vi
      .fn<ControllerArgs['addNode']>()
      .mockReturnValueOnce({ id: 'image-node-1' })
      .mockReturnValueOnce({ id: 'video-node-1' });

    const { getByTestId } = render(<CanvasDropTarget addNode={addNode} />);

    fireEvent.drop(getByTestId('canvas-drop-target'), {
      clientX: 240,
      clientY: 160,
      dataTransfer: {
        files: [
          new File(['image'], 'dropped.png', { type: 'image/png' }),
          new File(['video'], 'dropped.mp4', { type: 'video/mp4' }),
        ],
        dropEffect: '',
        getData: vi.fn(() => ''),
      },
    });

    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(2));
    expect(addNode).toHaveBeenNthCalledWith(
      1,
      'imageInput',
      expect.any(Object),
      expect.objectContaining({
        imageUrl: 'local-media://image/dropped.png',
        assetId: 'asset-image-1',
      }),
    );
    expect(addNode).toHaveBeenNthCalledWith(
      2,
      'videoInput',
      expect.any(Object),
      expect.objectContaining({
        videoUrl: 'local-media://video/dropped.mp4',
        assetId: 'asset-video-1',
      }),
    );
  });
});
