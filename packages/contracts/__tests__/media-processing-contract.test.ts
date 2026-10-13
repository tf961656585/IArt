import { describe, expect, it } from 'vitest';
import {
  ImageProcessingOperationSchema,
  ImageProcessingRequestSchema,
  ImageProcessingResultSchema,
  VideoSpriteSheetOperationSchema,
  VideoSpriteSheetRequestSchema,
  VideoSpriteSheetResultSchema,
} from '../src/media-processing-contract';

const mediaAsset = (assetId: string, url: string) => ({
  id: assetId,
  mediaType: 'image',
  original: {
    url,
    projectRef: 'prj_demo',
    fileKey: url.replace('local-media://prj_demo/', ''),
    sourceUrl: 'local-media://prj_demo/source.png',
    mimeType: 'image/png',
    sizeBytes: null,
    width: 512,
    height: 512,
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

describe('media processing contract schemas', () => {
  it('parses every supported operation variant', () => {
    expect(ImageProcessingOperationSchema.parse({ type: 'resize', percent: 50 })).toEqual({
      type: 'resize',
      percent: 50,
      kernel: 'lanczos3',
    });
    expect(ImageProcessingOperationSchema.parse({ type: 'crop', x: 0, y: 0, width: 20, height: 30 }).type).toBe('crop');
    expect(ImageProcessingOperationSchema.parse({ type: 'split', horizontalPercents: [50], verticalPercents: [25, 75] }).type).toBe('split');
    expect(ImageProcessingOperationSchema.parse({ type: 'edgeDetect', mode: 'sobel', threshold: 128 }).type).toBe('edgeDetect');
    expect(ImageProcessingOperationSchema.parse({ type: 'transform', ops: [{ type: 'mirrorX' }, { type: 'rotate', deg: 90 }] }).type).toBe('transform');
  });

  it('parses chromaKey and differenceKey operations and rejects malformed inputs', () => {
    // chromaKey 正例
    const chromaKey = ImageProcessingOperationSchema.parse({
      type: 'chromaKey',
      targetColor: { r: 0, g: 255, b: 0 },
      tolerance: 30,
      feather: 2,
    });
    expect(chromaKey.type).toBe('chromaKey');
    // chromaKey 反例:tolerance 越界
    expect(() =>
      ImageProcessingOperationSchema.parse({
        type: 'chromaKey',
        targetColor: { r: 0, g: 255, b: 0 },
        tolerance: 200,
        feather: 2,
      }),
    ).toThrow();
    // chromaKey 反例:unknown 字段
    expect(() =>
      ImageProcessingOperationSchema.parse({
        type: 'chromaKey',
        targetColor: { r: 0, g: 255, b: 0 },
        tolerance: 30,
        feather: 2,
        unknown: true,
      }),
    ).toThrow();

    // differenceKey 正例
    const differenceKey = ImageProcessingOperationSchema.parse({
      type: 'differenceKey',
      secondSource: { type: 'media-url', url: 'local-media://prj_demo/bg-b.png' },
      threshold: 24,
      softness: 18,
    });
    expect(differenceKey.type).toBe('differenceKey');
    if (differenceKey.type !== 'differenceKey') throw new Error('unexpected');
    expect(differenceKey.secondSource.url).toBe('local-media://prj_demo/bg-b.png');
    // differenceKey 反例:缺 secondSource
    expect(() =>
      ImageProcessingOperationSchema.parse({
        type: 'differenceKey',
        threshold: 24,
        softness: 18,
      }),
    ).toThrow();
    // differenceKey 反例:secondSource.url 为空字符串
    expect(() =>
      ImageProcessingOperationSchema.parse({
        type: 'differenceKey',
        secondSource: { type: 'media-url', url: '' },
        threshold: 24,
        softness: 18,
      }),
    ).toThrow();
    // differenceKey 反例:threshold 越界
    expect(() =>
      ImageProcessingOperationSchema.parse({
        type: 'differenceKey',
        secondSource: { type: 'media-url', url: 'local-media://prj_demo/bg-b.png' },
        threshold: 200,
        softness: 18,
      }),
    ).toThrow();
    // differenceKey 反例:unknown 字段
    expect(() =>
      ImageProcessingOperationSchema.parse({
        type: 'differenceKey',
        secondSource: { type: 'media-url', url: 'local-media://prj_demo/bg-b.png' },
        threshold: 24,
        softness: 18,
        unknown: true,
      }),
    ).toThrow();
  });

  it('keeps resize kernel default compatible while rejecting unknown operation fields', () => {
    expect(ImageProcessingOperationSchema.parse({ type: 'resize', percent: 50 }).kernel).toBe('lanczos3');
    expect(ImageProcessingOperationSchema.parse({ type: 'resize', percent: 50, kernel: 'nearest' }).kernel).toBe('nearest');
    expect(() => ImageProcessingOperationSchema.parse({ type: 'resize', percent: 50, unknown: true })).toThrow();
  });

  it('rejects missing required operation and media asset fields', () => {
    expect(() =>
      ImageProcessingRequestSchema.parse({
        source: { type: 'media-url', url: 'local-media://prj_demo/source.png' },
        operation: { type: 'resize' },
      }),
    ).toThrow();

    expect(() =>
      ImageProcessingResultSchema.parse({
        resultType: 'single',
        operationType: 'edgeDetect',
        success: true,
        assetId: 'asset-edge',
        mediaAsset: {
          id: 'asset-edge',
          mediaType: 'image',
          original: { url: 'local-media://prj_demo/edge.png' },
          thumbnail: { url: null, status: 'missing', error: null },
          lifecycle: { createdAt: 1, updatedAt: 1 },
        },
        url: 'local-media://prj_demo/edge.png',
        width: 512,
        height: 512,
        mode: 'sobel',
        threshold: 128,
      }),
    ).toThrow();
  });

  it('parses single and split result discriminants with assetId-bearing media assets', () => {
    const single = ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'edgeDetect',
      success: true,
      assetId: 'asset-edge',
      mediaAsset: mediaAsset('asset-edge', 'local-media://prj_demo/edge.png'),
      url: 'local-media://prj_demo/edge.png',
      width: 512,
      height: 512,
      mode: 'sobel',
      threshold: 128,
    });
    expect(single.resultType).toBe('single');
    if (single.resultType !== 'single') throw new Error('unexpected');
    expect(single.assetId).toBe('asset-edge');

    const split = ImageProcessingResultSchema.parse({
      resultType: 'split',
      operationType: 'split',
      success: true,
      rows: 1,
      cols: 2,
      originalWidth: 512,
      originalHeight: 512,
      horizontalPercents: [],
      verticalPercents: [50],
      tiles: [
        {
          index: 0,
          row: 0,
          col: 0,
          assetId: 'asset-tile-0',
          mediaAsset: mediaAsset('asset-tile-0', 'local-media://prj_demo/tile-0.png'),
          url: 'local-media://prj_demo/tile-0.png',
          width: 256,
          height: 512,
          x: 0,
          y: 0,
        },
      ],
    });
    expect(split.resultType).toBe('split');
    expect(split).toEqual(
      expect.objectContaining({
        tiles: [expect.objectContaining({ assetId: 'asset-tile-0' })],
      }),
    );
  });

  it('parses chromaKey and differenceKey single results with assetId-bearing media assets', () => {
    const chromaKey = ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'chromaKey',
      success: true,
      assetId: 'asset-chroma',
      mediaAsset: mediaAsset('asset-chroma', 'local-media://prj_demo/chroma.png'),
      url: 'local-media://prj_demo/chroma.png',
      width: 512,
      height: 512,
      targetColor: { r: 0, g: 255, b: 0 },
      tolerance: 30,
      feather: 2,
    });
    expect(chromaKey.resultType).toBe('single');
    if (chromaKey.operationType !== 'chromaKey') throw new Error('unexpected');
    expect(chromaKey.assetId).toBe('asset-chroma');

    const differenceKey = ImageProcessingResultSchema.parse({
      resultType: 'single',
      operationType: 'differenceKey',
      success: true,
      assetId: 'asset-diff',
      mediaAsset: mediaAsset('asset-diff', 'local-media://prj_demo/diff.png'),
      url: 'local-media://prj_demo/diff.png',
      width: 512,
      height: 512,
      threshold: 24,
      softness: 18,
    });
    expect(differenceKey.resultType).toBe('single');
    if (differenceKey.operationType !== 'differenceKey') throw new Error('unexpected');
    expect(differenceKey.assetId).toBe('asset-diff');
    expect(differenceKey.threshold).toBe(24);
    expect(differenceKey.softness).toBe(18);
  });
});

describe('video sprite sheet contract schemas', () => {
  describe('VideoSpriteSheetOperationSchema', () => {
    it('accepts valid operation', () => {
      const result = VideoSpriteSheetOperationSchema.parse({
        startTime: 0,
        endTime: 10,
        fpsMultiplier: 0.5,
      });
      expect(result.startTime).toBe(0);
      expect(result.endTime).toBe(10);
      expect(result.fpsMultiplier).toBe(0.5);
    });

    it('rejects negative startTime', () => {
      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: -1,
          endTime: 5,
          fpsMultiplier: 0.5,
        }),
      ).toThrow();
    });

    it('rejects negative endTime', () => {
      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: 0,
          endTime: -1,
          fpsMultiplier: 0.5,
        }),
      ).toThrow();
    });

    it('rejects fpsMultiplier above 1', () => {
      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: 0,
          endTime: 5,
          fpsMultiplier: 1.5,
        }),
      ).toThrow();
    });

    it('rejects fpsMultiplier below 0', () => {
      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: 0,
          endTime: 5,
          fpsMultiplier: -0.1,
        }),
      ).toThrow();
    });

    it('accepts boundary fpsMultiplier values 0 and 1', () => {
      const atZero = VideoSpriteSheetOperationSchema.parse({
        startTime: 0,
        endTime: 5,
        fpsMultiplier: 0,
      });
      expect(atZero.fpsMultiplier).toBe(0);

      const atOne = VideoSpriteSheetOperationSchema.parse({
        startTime: 0,
        endTime: 5,
        fpsMultiplier: 1,
      });
      expect(atOne.fpsMultiplier).toBe(1);
    });

    it('rejects startTime >= endTime', () => {
      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: 5,
          endTime: 5,
          fpsMultiplier: 0.5,
        }),
      ).toThrow();

      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: 10,
          endTime: 5,
          fpsMultiplier: 0.5,
        }),
      ).toThrow();
    });

    it('rejects extra fields', () => {
      expect(() =>
        VideoSpriteSheetOperationSchema.parse({
          startTime: 0,
          endTime: 5,
          fpsMultiplier: 0.5,
          extraField: 'not allowed',
        }),
      ).toThrow();
    });
  });

  describe('VideoSpriteSheetRequestSchema', () => {
    it('accepts valid request with source and operation', () => {
      const result = VideoSpriteSheetRequestSchema.parse({
        source: { type: 'media-url', url: 'local-media://prj_demo/video.mp4' },
        operation: {
          startTime: 0,
          endTime: 10,
          fpsMultiplier: 0.5,
        },
      });
      expect(result.source.url).toBe('local-media://prj_demo/video.mp4');
      expect(result.operation.fpsMultiplier).toBe(0.5);
    });

    it('rejects invalid source type', () => {
      expect(() =>
        VideoSpriteSheetRequestSchema.parse({
          source: { type: 'file-path', path: '/tmp/video.mp4' },
          operation: {
            startTime: 0,
            endTime: 10,
            fpsMultiplier: 0.5,
          },
        }),
      ).toThrow();
    });

    it('rejects missing source url', () => {
      expect(() =>
        VideoSpriteSheetRequestSchema.parse({
          source: { type: 'media-url', url: '' },
          operation: {
            startTime: 0,
            endTime: 10,
            fpsMultiplier: 0.5,
          },
        }),
      ).toThrow();
    });
  });

  describe('VideoSpriteSheetResultSchema', () => {
    const validResult = {
      frameCount: 30,
      rows: 5,
      cols: 6,
      frameWidth: 320,
      frameHeight: 240,
      atlasWidth: 1920,
      atlasHeight: 1200,
      outputUrl: 'local-media://prj_demo/spritesheet.png',
      assetId: 'asset-spritesheet',
      mediaAsset: mediaAsset('asset-spritesheet', 'local-media://prj_demo/spritesheet.png'),
    };

    it('accepts valid result with assetId and mediaAsset', () => {
      const result = VideoSpriteSheetResultSchema.parse(validResult);
      expect(result.frameCount).toBe(30);
      expect(result.rows).toBe(5);
      expect(result.cols).toBe(6);
      expect(result.outputUrl).toBe('local-media://prj_demo/spritesheet.png');
      expect(result.assetId).toBe('asset-spritesheet');
      expect(result.mediaAsset.id).toBe('asset-spritesheet');
    });

    it('rejects missing outputUrl', () => {
      expect(() =>
        VideoSpriteSheetResultSchema.parse({
          ...validResult,
          outputUrl: undefined,
        }),
      ).toThrow();
    });

    it('rejects missing assetId', () => {
      expect(() =>
        VideoSpriteSheetResultSchema.parse({
          ...validResult,
          assetId: undefined,
        }),
      ).toThrow();
    });

    it('rejects missing mediaAsset', () => {
      expect(() =>
        VideoSpriteSheetResultSchema.parse({
          ...validResult,
          mediaAsset: undefined,
        }),
      ).toThrow();
    });

    it('rejects extra fields', () => {
      expect(() =>
        VideoSpriteSheetResultSchema.parse({
          ...validResult,
          extraField: 'not allowed',
        }),
      ).toThrow();
    });

    it('rejects non-number fields', () => {
      expect(() =>
        VideoSpriteSheetResultSchema.parse({
          ...validResult,
          frameCount: '30',
        }),
      ).toThrow();
    });
  });
});
