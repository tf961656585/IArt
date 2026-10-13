import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClipboardWriteImageResponse,
  ClipboardWriteTextResponse,
  MediaAsset,
  ProjectMediaAssets,
} from '@iart/contracts';
import type { GraphNode } from '../types';

// Mock bridge — 用 vi.hoisted 让 mock 在 vi.mock factory 内可引用且保留类型
const mocks = vi.hoisted(() => ({
  writeText: vi.fn<
    (text: string) => Promise<ClipboardWriteTextResponse>
  >(),
  writeImage: vi.fn<
    (
      url: string,
      projectPath: string | null,
    ) => Promise<ClipboardWriteImageResponse>
  >(),
  getRuntimeProjectPath: vi.fn<() => string | null>(),
}));

vi.mock('@/client/utils/electronBridge', () => ({
  writeTextToClipboard: (text: string) => mocks.writeText(text),
  writeImageFromUrlToClipboard: (url: string, projectPath: string | null) =>
    mocks.writeImage(url, projectPath),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => mocks.getRuntimeProjectPath(),
}));

import {
  resolveSystemClipboardPayload,
  syncNodeContentToSystemClipboard,
} from './systemClipboardSync';

// ---------------------------------------------------------------------------
// 测试数据工厂
// ---------------------------------------------------------------------------

const makeMediaAsset = (mediaType: 'image' | 'video' | 'audio', url = 'local-media://__global__/abc.png'): MediaAsset => ({
  id: 'asset-1',
  mediaType,
  original: {
    url,
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
  lifecycle: { createdAt: 0, updatedAt: 0 },
});

const makeMediaAssets = (overrides: Record<string, MediaAsset> = {}): ProjectMediaAssets => ({
  'asset-1': makeMediaAsset('image'),
  ...overrides,
});

/**
 * 构造测试用 GraphNode。data 来自具体工厂函数（makeTextInputNode 等），运行时业务侧
 * 按节点 type 强转读取，所以这里用 `unknown` 中转后断言为 GraphNode['data']。
 *
 * 双重断言仅在测试构造场景使用，业务代码禁止复用此模式。
 */
const makeNode = (
  type: GraphNode['type'],
  data: unknown,
  id = 'node-1',
): GraphNode => {
  const node: GraphNode = {
    id,
    type,
    position: { x: 0, y: 0 },
    // 测试构造用，data 形状由调用方负责匹配节点 type。
    // eslint-disable-next-line no-restricted-syntax
    data: data as unknown as GraphNode['data'],
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  return node;
};

const makeImageInputNode = (assetId: string | null): GraphNode =>
  makeNode('imageInput', { assetId, imageUrl: null });

const makeModelNode = (
  slots: Array<Record<string, unknown>>,
): GraphNode =>
  makeNode('model', {
    resultArea: { slots, outputSlotIds: [], collapsed: false, targetKeyId: 'tk' },
  });

// ---------------------------------------------------------------------------
// resolveSystemClipboardPayload 纯函数
// ---------------------------------------------------------------------------

describe('resolveSystemClipboardPayload', () => {
  describe('imageInput', () => {
    it('returns image when assetId resolves to image asset', () => {
      const node = makeImageInputNode('asset-1');
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'image', url: 'local-media://__global__/abc.png' });
    });

    it('returns no-content when assetId is null', () => {
      const node = makeImageInputNode(null);
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'skip', reason: 'no-content' });
    });

    it('returns no-content when asset not found in mediaAssets', () => {
      const node = makeImageInputNode('missing-asset');
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'skip', reason: 'no-content' });
    });
  });

  describe('model slot selection', () => {
    it('returns text when first slot is text with content', () => {
      const node = makeModelNode([
        { itemType: 'text', textValue: 'result text' },
      ]);
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'text', text: 'result text' });
    });

    it('returns image when first slot is image media', () => {
      const node = makeModelNode([
        { itemType: 'media', assetId: 'asset-1' },
      ]);
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'image', url: 'local-media://__global__/abc.png' });
    });

    it('returns media-not-image when first slot is video (does NOT cross to next slot)', () => {
      const mediaAssets = makeMediaAssets({
        'video-asset': makeMediaAsset('video'),
        'image-asset': makeMediaAsset('image', 'local-media://__global__/img.png'),
      });
      const node = makeModelNode([
        { itemType: 'media', assetId: 'video-asset' },
        { itemType: 'media', assetId: 'image-asset' },
      ]);
      const result = resolveSystemClipboardPayload(node, { mediaAssets });
      expect(result).toEqual({ kind: 'skip', reason: 'media-not-image' });
    });

    it('returns media-not-image when first slot is audio', () => {
      const mediaAssets = makeMediaAssets({
        'audio-asset': makeMediaAsset('audio'),
      });
      const node = makeModelNode([
        { itemType: 'media', assetId: 'audio-asset' },
      ]);
      const result = resolveSystemClipboardPayload(node, { mediaAssets });
      expect(result).toEqual({ kind: 'skip', reason: 'media-not-image' });
    });

    it('skips empty first slot and takes second text slot', () => {
      const node = makeModelNode([
        { itemType: undefined },
        { itemType: 'text', textValue: 'second slot text' },
      ]);
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'text', text: 'second slot text' });
    });

    it('returns no-content when all slots are empty', () => {
      const node = makeModelNode([
        { itemType: undefined },
        { itemType: 'text', textValue: '' },
        { itemType: 'media', assetId: null },
      ]);
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'skip', reason: 'no-content' });
    });
  });

  describe('video/audio input nodes (decision A: MVP excluded)', () => {
    it('videoInput returns media-not-image', () => {
      const node = makeNode('videoInput', {});
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'skip', reason: 'media-not-image' });
    });

    it('audioInput returns media-not-image', () => {
      const node = makeNode('audioInput', {});
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'skip', reason: 'media-not-image' });
    });
  });

  describe('unsupported node types', () => {
    it('group returns unsupported-node-type', () => {
      const node = makeNode('group', {});
      const result = resolveSystemClipboardPayload(node, { mediaAssets: makeMediaAssets() });
      expect(result).toEqual({ kind: 'skip', reason: 'unsupported-node-type' });
    });
  });
});

// ---------------------------------------------------------------------------
// syncNodeContentToSystemClipboard 异步
// ---------------------------------------------------------------------------

describe('syncNodeContentToSystemClipboard', () => {
  beforeEach(() => {
    mocks.writeText.mockReset();
    mocks.writeImage.mockReset();
    mocks.getRuntimeProjectPath.mockReset();
    mocks.getRuntimeProjectPath.mockReturnValue('/tmp/project');
  });

  it('text outcome calls writeTextToClipboard', async () => {
    const node = makeModelNode([{ itemType: 'text', textValue: 'hello' }]);
    mocks.writeText.mockResolvedValue({ ok: true });
    const result = await syncNodeContentToSystemClipboard(node, makeMediaAssets());
    expect(mocks.writeText).toHaveBeenCalledWith('hello');
    expect(mocks.writeImage).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, ok: true });
  });

  it('image outcome calls writeImageFromUrlToClipboard with runtime project path', async () => {
    const node = makeImageInputNode('asset-1');
    mocks.writeImage.mockResolvedValue({ ok: true, filePath: '/tmp/x.png' });
    const result = await syncNodeContentToSystemClipboard(node, makeMediaAssets());
    expect(mocks.writeImage).toHaveBeenCalledWith(
      'local-media://__global__/abc.png',
      '/tmp/project',
    );
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, ok: true, filePath: '/tmp/x.png' });
    expect(mocks.getRuntimeProjectPath).toHaveBeenCalled();
  });

  it('skip outcome does not call any bridge', async () => {
    const node = makeNode('group', {});
    const result = await syncNodeContentToSystemClipboard(node, makeMediaAssets());
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.writeImage).not.toHaveBeenCalled();
    expect(result).toEqual({
      skipped: true,
      ok: true,
      reason: 'unsupported-node-type',
    });
  });

  it('propagates bridge failure reason', async () => {
    const node = makeImageInputNode('asset-1');
    mocks.writeImage.mockResolvedValue({ ok: false, reason: 'not-found' });
    const result = await syncNodeContentToSystemClipboard(node, makeMediaAssets());
    expect(result).toEqual({ skipped: false, ok: false, reason: 'not-found' });
  });

  it('returns invoke-failed when bridge throws', async () => {
    const node = makeModelNode([{ itemType: 'text', textValue: 'hello' }]);
    mocks.writeText.mockRejectedValue(new Error('network down'));
    const result = await syncNodeContentToSystemClipboard(node, makeMediaAssets());
    expect(result).toEqual({ skipped: false, ok: false, reason: 'invoke-failed' });
  });

  it('returns invoke-failed when image bridge throws', async () => {
    const node = makeImageInputNode('asset-1');
    mocks.writeImage.mockRejectedValue(new Error('network down'));
    const result = await syncNodeContentToSystemClipboard(node, makeMediaAssets());
    expect(result).toEqual({ skipped: false, ok: false, reason: 'invoke-failed' });
  });
});
