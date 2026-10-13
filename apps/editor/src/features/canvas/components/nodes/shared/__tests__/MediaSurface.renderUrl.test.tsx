import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const useImageThumbnailMock = vi.fn<(...args: unknown[]) => unknown>();
const useVideoThumbnailMock = vi.fn<(...args: unknown[]) => unknown>();
const useMediaLifecycleMock = vi.fn<(...args: unknown[]) => unknown>();
const reportThumbnailRenderFailureMock = vi.fn<(...args: unknown[]) => unknown>();

const imageSurfaceRequiredProps = () => ({
  lifecycleKey: 'test-image',
  imageUrl: null,
  presentation: undefined,
  backgroundImageUrl: undefined,
  alt: 'image',
  aspectRatio: undefined,
  defaultAspectRatio: undefined,
  allowDrop: undefined,
  disabled: undefined,
  disableNativeDrag: undefined,
  isLoading: undefined,
  loading: undefined,
  decoding: undefined,
  placeholder: <div>placeholder</div>,
  overlay: undefined,
  objectFit: undefined,
  backgroundClassName: undefined,
  backgroundOverlayClassName: undefined,
  className: undefined,
  onDropFile: () => undefined,
  onImageLoad: () => undefined,
});

const videoSurfaceRequiredProps = () => ({
  lifecycleKey: 'test-video',
  videoUrl: undefined,
  aspectRatio: undefined,
  defaultAspectRatio: undefined,
  allowDrop: undefined,
  disabled: undefined,
  isLoading: undefined,
  preload: undefined,
  placeholder: <div>placeholder</div>,
  overlay: undefined,
  objectFit: undefined,
  controlsVisibility: undefined,
  controlsActive: undefined,
  showControls: undefined,
  className: undefined,
  onDropFile: () => undefined,
  onLoadedMeta: () => undefined,
  presentation: undefined,
});

vi.mock('../../../../store/canvasStore', () => {
  type MockCanvasState = {
    nodeGraph: { viewport: { zoom: number } };
    isCanvasInteracting: boolean;
    ui: { preLayoutMeasuring: boolean };
  };
  const state: MockCanvasState = {
    nodeGraph: { viewport: { zoom: 1 } },
    isCanvasInteracting: false,
    ui: { preLayoutMeasuring: false },
  };
  const useCanvasStore = <T,>(selector: (state: MockCanvasState) => T): T => selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});

vi.mock('../useMediaLifecycle', () => ({
  useMediaLifecycle: (...args: unknown[]) => useMediaLifecycleMock(...args),
}));

vi.mock('../useDeferredHoverActivation', () => ({
  useDeferredHoverActivation: () => ({
    isHovered: false,
    onPointerEnter: vi.fn(),
    onPointerLeave: vi.fn(),
  }),
}));

vi.mock('../useImageThumbnail', () => ({
  useImageThumbnail: (...args: unknown[]) => useImageThumbnailMock(...args),
}));

vi.mock('../useVideoThumbnail', () => ({
  useVideoThumbnail: (...args: unknown[]) => useVideoThumbnailMock(...args),
}));

vi.mock('../../../../services/thumbnailHealthReporter', () => ({
  reportThumbnailRenderFailure: (...args: unknown[]) => reportThumbnailRenderFailureMock(...args),
}));

describe('media surface render url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMediaLifecycleMock.mockImplementation(() => ({
      isActive: false,
      isDormant: true,
      onHoverEnter: vi.fn(),
      onHoverLeave: vi.fn(),
      setPlaying: vi.fn(),
    }));
    reportThumbnailRenderFailureMock.mockResolvedValue(null);
  });

  it('ImageNodeSurface 渲染 local-media thumbnail 时原样透出', async () => {
    useImageThumbnailMock.mockReturnValue({
      kind: 'thumbnail',
      url: 'local-media://prj_demo/thumbnails/thumb-image.webp',
      sourceMeta: null,
    });

    const { ImageNodeSurface } = await import('../ImageNodeSurface');

    render(
      <ImageNodeSurface
        {...imageSurfaceRequiredProps()}
        imageUrl="local-media://prj_demo/original-image.png"
        alt="image preview"
        placeholder={<div>placeholder</div>}
      />,
    );

    expect(screen.getByAltText('image preview').getAttribute('src')).toBe(
      'local-media://prj_demo/thumbnails/thumb-image.webp',
    );
  });

  it('VideoNodeSurface 渲染 local-media thumbnail 时原样透出', async () => {
    useVideoThumbnailMock.mockReturnValue({
      kind: 'thumbnail',
      url: 'local-media://prj_demo/thumbnails/thumb-video.jpg',
    });

    const { VideoNodeSurface } = await import('../VideoNodeSurface');

    const { container } = render(
      <VideoNodeSurface
        {...videoSurfaceRequiredProps()}
        videoUrl="local-media://prj_demo/original-video.mp4"
        placeholder={<div>placeholder</div>}
      />,
    );

    const thumbnail = container.querySelector('img');
    expect(thumbnail).not.toBeNull();
    if (!thumbnail) {
      throw new Error('未找到视频缩略图元素');
    }
    expect(thumbnail.getAttribute('src')).toBe(
      'local-media://prj_demo/thumbnails/thumb-video.jpg',
    );
  });

  it('ImageNodeSurface 缩略图加载失败时会回退到原图 render URL', async () => {
    useImageThumbnailMock.mockReturnValue({
      kind: 'thumbnail',
      url: 'local-media://prj_demo/thumbnails/thumb-image.webp',
      sourceMeta: null,
    });

    const { ImageNodeSurface } = await import('../ImageNodeSurface');

    render(
      <ImageNodeSurface
        {...imageSurfaceRequiredProps()}
        imageUrl="local-media://prj_demo/original-image.png"
        alt="fallback preview"
        placeholder={<div>placeholder</div>}
      />,
    );

    const image = screen.getByAltText('fallback preview');
    fireEvent.error(image);

    expect(image.getAttribute('src')).toBe(
      'local-media://prj_demo/original-image.png',
    );
  });

  it('ImageNodeSurface hover 激活后会切回原图 render URL', async () => {
    useImageThumbnailMock.mockReturnValue({
      kind: 'thumbnail',
      url: 'local-media://prj_demo/thumbnails/thumb-image.webp',
      sourceMeta: { width: 2048, height: 1024, aspectRatio: 2 },
    });
    useMediaLifecycleMock.mockImplementation(() => {
      const [isActive, setIsActive] = React.useState(false);
      return {
        isActive,
        isDormant: !isActive,
        onHoverEnter: () => setIsActive(true),
        onHoverLeave: () => setIsActive(false),
        setPlaying: vi.fn(),
      };
    });

    const { ImageNodeSurface } = await import('../ImageNodeSurface');

    render(
      <ImageNodeSurface
        {...imageSurfaceRequiredProps()}
        imageUrl="local-media://prj_demo/original-image.png"
        alt="hover preview"
        placeholder={<div>placeholder</div>}
      />,
    );

    const image = screen.getByAltText('hover preview');
    expect(image.getAttribute('src')).toBe(
      'local-media://prj_demo/thumbnails/thumb-image.webp',
    );

    fireEvent.pointerEnter(image.parentElement as HTMLElement);

    expect(screen.getByAltText('hover preview').getAttribute('src')).toBe(
      'local-media://prj_demo/original-image.png',
    );
  });

  it('ImageNodeSurface 在缩略图态加载时仍回填原图尺寸', async () => {
    const onImageLoad = vi.fn();
    useImageThumbnailMock.mockReturnValue({
      kind: 'thumbnail',
      url: 'local-media://prj_demo/thumbnails/thumb-image.webp',
      sourceMeta: { width: 2048, height: 1024, aspectRatio: 2 },
    });

    const { ImageNodeSurface } = await import('../ImageNodeSurface');

    render(
      <ImageNodeSurface
        {...imageSurfaceRequiredProps()}
        imageUrl="local-media://prj_demo/original-image.png"
        alt="dimension preview"
        placeholder={<div>placeholder</div>}
        onImageLoad={onImageLoad}
      />,
    );

    const image = screen.getByAltText('dimension preview');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 512 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 256 });

    fireEvent.load(image);

    expect(onImageLoad).toHaveBeenCalledWith({
      width: 2048,
      height: 1024,
      aspectRatio: 2,
    });
  });

  it('ImageNodeSurface presentation thumbnail 失败时只上报后端自愈信号', async () => {
    const { ImageNodeSurface } = await import('../ImageNodeSurface');

    render(
      <ImageNodeSurface
        {...imageSurfaceRequiredProps()}
        imageUrl="local-media://prj_demo/original.png"
        presentation={{
          assetId: 'asset-image-report',
          mediaType: 'image',
          contentState: 'asset-ready',
          dormant: { kind: 'thumbnail', url: 'local-media://prj_demo/thumbnails/missing.webp' },
          active: {
            kind: 'source',
            url: 'local-media://prj_demo/original.png',
            message: '查看原图',
          },
          originalFormalUrl: 'local-media://prj_demo/original.png',
          originalRenderUrl: 'local-media://prj_demo/original.png',
          thumbnailFormalUrl: 'local-media://prj_demo/thumbnails/missing.webp',
          thumbnailRenderUrl: 'local-media://prj_demo/thumbnails/missing.webp',
          dormantDisplayUrl: 'local-media://prj_demo/thumbnails/missing.webp',
          activeDisplayUrl: 'local-media://prj_demo/original.png',
          downloadUrl: 'local-media://prj_demo/original.png',
          previewUrl: 'local-media://prj_demo/original.png',
          hoverMeta: null,
          thumbnailStatus: 'ready',
          thumbnailError: null,
        }}
        alt="presentation image"
        placeholder={<div>placeholder</div>}
      />,
    );

    fireEvent.error(screen.getByAltText('presentation image'));

    expect(reportThumbnailRenderFailureMock).toHaveBeenCalledWith({
      assetId: 'asset-image-report',
      mediaType: 'image',
      failedUrl: 'local-media://prj_demo/thumbnails/missing.webp',
    });
  });
});
