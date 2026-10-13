import { describe, expect, it } from 'vitest';
import {
  extractFileKeyFromRuntimeMediaUrl,
  normalizeLocalFileUrl,
  resolveLocalRenderableMediaSource,
  resolveRenderableMediaUrl,
} from '../mediaUrl';
import mediaConstantsModule from '@iart/utils/media-constants';
const { buildLocalMediaUrl } = mediaConstantsModule;
import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';

describe('normalizeLocalFileUrl', () => {
  it('识别 local-media:// URL 并原样返回', () => {
    expect(normalizeLocalFileUrl('local-media://prj_0123456789abcdef0123456789abcdef/asset.png')).toBe('local-media://prj_0123456789abcdef0123456789abcdef/asset.png');
    expect(normalizeLocalFileUrl('local-media://abc123.png')).toBe('local-media://abc123.png');
  });

  it('非 local-media:// URL 返回 null', () => {
    expect(normalizeLocalFileUrl('/files/abc.png')).toBeNull();
    expect(normalizeLocalFileUrl('/project-media/prj_0123456789abcdef0123456789abcdef/abc.png')).toBeNull();
    expect(normalizeLocalFileUrl('https://example.com/image.png')).toBeNull();
    expect(normalizeLocalFileUrl('data:image/png;base64,AAA')).toBeNull();
    expect(normalizeLocalFileUrl(null)).toBeNull();
    expect(normalizeLocalFileUrl(undefined)).toBeNull();
    expect(normalizeLocalFileUrl('')).toBeNull();
  });
});

describe('project-media URL', () => {
  it('由 projectRef + fileKey 派生 local-media:// URL', () => {
    expect(buildLocalMediaUrl('prj_0123456789abcdef0123456789abcdef', 'asset 1.png')).toBe('local-media://prj_0123456789abcdef0123456789abcdef/asset%201.png');
  });

  it('无效输入返回 null', () => {
    expect(buildLocalMediaUrl(null, 'asset.png')).toBeNull();
    expect(buildLocalMediaUrl('prj_0123456789abcdef0123456789abcdef', null)).toBeNull();
    expect(buildLocalMediaUrl('', 'asset.png')).toBeNull();
  });

  it('可从 local-media:// URL 提取 fileKey', () => {
    expect(extractFileKeyFromRuntimeMediaUrl('local-media://prj_0123456789abcdef0123456789abcdef/asset%201.png')).toBe('asset 1.png');
    expect(extractFileKeyFromRuntimeMediaUrl('local-media://abc123.png')).toBe('abc123.png');
  });

  it('旧格式 URL 不再能提取 fileKey', () => {
    expect(extractFileKeyFromRuntimeMediaUrl('/project-media/prj_0123456789abcdef0123456789abcdef/asset%201.png')).toBeNull();
    expect(extractFileKeyFromRuntimeMediaUrl('/files/legacy%201.png')).toBeNull();
  });
});

describe('isLocalMediaUrl (via classifyMediaUrl)', () => {
  it('识别 local-media:// URL', () => {
    expect(classifyMediaUrl('local-media://abc123.png').kind).toBe('local-media');
    expect(classifyMediaUrl('local-media://def456.mp4').kind).toBe('local-media');
  });

  it('拒绝非 local-media:// URL', () => {
    expect(classifyMediaUrl('/files/abc.png').kind === 'local-media').toBe(false);
    expect(classifyMediaUrl('https://example.com/image.png').kind === 'local-media').toBe(false);
    expect(classifyMediaUrl('blob:http://localhost/demo').kind === 'local-media').toBe(false);
    expect(classifyMediaUrl('').kind === 'local-media').toBe(false);
  });
});

describe('local-media:// 与 resolveRenderableMediaUrl', () => {
  it('local-media:// URL 直接透传', () => {
    expect(resolveRenderableMediaUrl('local-media://abc123.png')).toBe(
      'local-media://abc123.png'
    );
  });
});

describe('local-media:// 与 resolveLocalRenderableMediaSource', () => {
  it('local-media:// URL 返回有效的渲染源，无错误', () => {
    expect(resolveLocalRenderableMediaSource('local-media://abc123.png')).toEqual({
      formalUrl: 'local-media://abc123.png',
      renderUrl: 'local-media://abc123.png',
      error: null,
    });
  });
});
