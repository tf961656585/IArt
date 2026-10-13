import { describe, expect, it } from 'vitest';
import mediaConstantsModule from '@iart/utils/media-constants';
const { buildLocalMediaUrl, buildLocalMediaUrlV2, isLocalMediaUrlV2, LOCAL_MEDIA_SCHEME } = mediaConstantsModule;

describe('buildLocalMediaUrl', () => {
  it('preserves slashes in fileKey (processed/foo.png)', () => {
    const url = buildLocalMediaUrl('prj_1', 'processed/foo.png');
    expect(url).not.toBeNull();
    expect(url).toContain('processed/foo.png');
    expect(url).not.toContain('processed%2Ffoo.png');
  });

  it('handles fileKey without slashes (thumb-abc.webp)', () => {
    const url = buildLocalMediaUrl('prj_1', 'thumb-abc.webp');
    expect(url).toBe(`${LOCAL_MEDIA_SCHEME}prj_1/thumb-abc.webp`);
  });

  it('returns null when projectRef is null', () => {
    expect(buildLocalMediaUrl(null, 'foo.png')).toBeNull();
  });

  it('returns null when fileKey is null', () => {
    expect(buildLocalMediaUrl('prj_1', null)).toBeNull();
  });

  it('returns null when both projectRef and fileKey are null', () => {
    expect(buildLocalMediaUrl(null, null)).toBeNull();
  });

  it('returns null when projectRef is undefined', () => {
    expect(buildLocalMediaUrl(undefined, 'foo.png')).toBeNull();
  });

  it('returns null when fileKey is undefined', () => {
    expect(buildLocalMediaUrl('prj_1', undefined)).toBeNull();
  });

  it('returns null when both projectRef and fileKey are undefined', () => {
    expect(buildLocalMediaUrl(undefined, undefined)).toBeNull();
  });

  it('returns null when projectRef is empty string', () => {
    expect(buildLocalMediaUrl('', 'foo.png')).toBeNull();
  });

  it('returns null when fileKey is empty string', () => {
    expect(buildLocalMediaUrl('prj_1', '')).toBeNull();
  });

  it('encodes special characters in projectRef and fileKey', () => {
    const url = buildLocalMediaUrl('prj space', 'file name.png');
    expect(url).toBe(`${LOCAL_MEDIA_SCHEME}prj%20space/file%20name.png`);
  });
});

describe('buildLocalMediaUrlV2', () => {
  it('returns valid V2 URL for stableProjectId + fileKey', () => {
    const url = buildLocalMediaUrlV2('spid_abc123', 'processed/foo.png');
    expect(url).not.toBeNull();
    expect(url).toContain('spid_abc123');
    expect(url).toContain('processed/foo.png');
  });

  it('preserves slashes in fileKey (processed/foo.png)', () => {
    const url = buildLocalMediaUrlV2('spid_abc123', 'processed/foo.png');
    expect(url).not.toBeNull();
    expect(url).toContain('processed/foo.png');
    expect(url).not.toContain('processed%2Ffoo.png');
  });

  it('returns null when stableProjectId is null', () => {
    expect(buildLocalMediaUrlV2(null, 'foo.png')).toBeNull();
  });

  it('returns null when stableProjectId is undefined', () => {
    expect(buildLocalMediaUrlV2(undefined, 'foo.png')).toBeNull();
  });

  it('returns null when stableProjectId is empty string', () => {
    expect(buildLocalMediaUrlV2('', 'foo.png')).toBeNull();
  });

  it('returns null when fileKey is null', () => {
    expect(buildLocalMediaUrlV2('spid_abc123', null)).toBeNull();
  });

  it('returns null when fileKey is undefined', () => {
    expect(buildLocalMediaUrlV2('spid_abc123', undefined)).toBeNull();
  });

  it('returns null when fileKey is empty string', () => {
    expect(buildLocalMediaUrlV2('spid_abc123', '')).toBeNull();
  });

  it('encodes special characters in stableProjectId and fileKey', () => {
    const url = buildLocalMediaUrlV2('spid space', 'file name.png');
    expect(url).toBe(`${LOCAL_MEDIA_SCHEME}spid%20space/file%20name.png`);
  });
});

describe('isLocalMediaUrlV2', () => {
  it('returns true for a V2 URL with spid_ prefix', () => {
    const url = buildLocalMediaUrlV2('spid_abc123', 'foo.png');
    expect(url).not.toBeNull();
    expect(isLocalMediaUrlV2(url)).toBe(true);
  });

  it('returns false for a V1 URL with prj_ prefix', () => {
    const url = buildLocalMediaUrl('prj_1', 'foo.png');
    expect(url).not.toBeNull();
    expect(isLocalMediaUrlV2(url)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLocalMediaUrlV2(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isLocalMediaUrlV2(undefined)).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isLocalMediaUrlV2(123)).toBe(false);
  });

  it('returns false for non-local-media URLs', () => {
    expect(isLocalMediaUrlV2('https://example.com/file.png')).toBe(false);
  });

  it('returns false for __global__ URL', () => {
    const url = `${LOCAL_MEDIA_SCHEME}${encodeURIComponent('__global__')}/foo.png`;
    expect(isLocalMediaUrlV2(url)).toBe(false);
  });
});
