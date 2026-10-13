import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistModelMediaValueForField,
  persistUploadItemsForModelField,
} from '../modelMediaPersistence';
import { importLocalFile } from '../localMediaImport';

vi.mock('../localMediaImport', () => ({
  importLocalFile: vi.fn(),
}));

describe('modelMediaPersistence 模型字段媒体引用', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importLocalFile).mockResolvedValue({
      blobUrl: 'blob:preview',
      persistentUrl: 'local-media://persisted.png',
      mediaType: 'image',
      sizeBytes: 1024,
      isNew: true,
      assetId: 'asset_persisted',
      asset: {
        id: 'asset_persisted',
        mediaType: 'image',
        original: {
          url: 'local-media://persisted.png',
          projectRef: null,
          fileKey: 'persisted.png',
          sourceUrl: null,
          sourceFileName: null,
          mimeType: 'image/png',
          sizeBytes: 1024,
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
        lifecycle: {
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
  });

  it('远端字符串媒体字段保留为远端 URL，不预先落成 /files 分叉事实源', async () => {
    const result = await persistModelMediaValueForField({
      fieldKey: 'imageUrl',
      value: 'https://example.com/out.png',
      maxFiles: undefined,
    });

    expect(result).toEqual({
      value: 'https://example.com/out.png',
      issues: [],
    });
    expect(vi.mocked(importLocalFile)).not.toHaveBeenCalled();
  });

  it('Blob 上传项通过本地导入主链落成 local-media 引用', async () => {
    const result = await persistUploadItemsForModelField({
      fieldKey: 'images',
      value: [{ id: 'item_1', src: '', file: new Blob(['demo'], { type: 'image/png' }) }],
      maxFiles: undefined,
    });

    expect(result).toEqual({
      items: [{ id: 'item_1', src: 'local-media://persisted.png' }],
      issues: [],
    });
    expect(vi.mocked(importLocalFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(importLocalFile).mock.calls[0]?.[0]).toBeInstanceOf(File);
  });

  it('已存在 local-media 引用直接保留，不重新导入', async () => {
    const result = await persistUploadItemsForModelField({
      fieldKey: 'images',
      value: [{ id: 'item_1', src: 'local-media://existing.png' }],
      maxFiles: undefined,
    });

    expect(result).toEqual({
      items: [{ id: 'item_1', src: 'local-media://existing.png' }],
      issues: [],
    });
    expect(vi.mocked(importLocalFile)).not.toHaveBeenCalled();
  });
});
