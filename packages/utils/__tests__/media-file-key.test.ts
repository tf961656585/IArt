import { describe, expect, it } from 'vitest';
import mediaFileKeyModule from '@iart/utils/media-file-key';
import mediaConstantsModule from '@iart/utils/media-constants';

const { isLocalMediaScope, parseLocalMediaUrl, extractMediaFileKey } = mediaFileKeyModule;
const { buildLocalMediaUrl, buildLocalMediaUrlV2 } = mediaConstantsModule;

// 合规前缀值（与 utils 谓词同源）
const V1_REF = 'prj_0123456789abcdef0123456789abcdef';
const V2_ID = 'spid_0123456789abcdef01234567';
const GLOBAL = '__global__';

describe('isLocalMediaScope', () => {
  it('recognizes V1 projectRef (prj_ + 32 hex)', () => {
    expect(isLocalMediaScope(V1_REF)).toBe(true);
  });

  it('recognizes V2 stableProjectId (spid_ + 24 hex)', () => {
    expect(isLocalMediaScope(V2_ID)).toBe(true);
  });

  it('recognizes global scope', () => {
    expect(isLocalMediaScope(GLOBAL)).toBe(true);
  });

  it('rejects spid_ with too few hex digits', () => {
    expect(isLocalMediaScope('spid_short')).toBe(false);
  });

  it('rejects prj_ with non-hex chars', () => {
    expect(isLocalMediaScope('prj_xyz' + '0'.repeat(29))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLocalMediaScope('')).toBe(false);
  });

  it('rejects arbitrary random string', () => {
    expect(isLocalMediaScope('random')).toBe(false);
  });
});

describe('parseLocalMediaUrl', () => {
  it('parses V1 URL (prj_)', () => {
    const parsed = parseLocalMediaUrl(`local-media://${V1_REF}/processed/x.png`);
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBe(V1_REF);
    expect(parsed.fileKey).toBe('processed/x.png');
  });

  it('parses V2 URL (spid_)', () => {
    const parsed = parseLocalMediaUrl(`local-media://${V2_ID}/processed/x.png`);
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBe(V2_ID);
    expect(parsed.fileKey).toBe('processed/x.png');
  });

  it('parses global URL', () => {
    const parsed = parseLocalMediaUrl(`local-media://${GLOBAL}/x.png`);
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBe(GLOBAL);
    expect(parsed.fileKey).toBe('x.png');
  });

  it('treats no-scope URL (first segment not a valid scope) as pure fileKey', () => {
    // local-media://processed/x.png — "processed" is not a valid scope
    const parsed = parseLocalMediaUrl('local-media://processed/x.png');
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBeNull();
    expect(parsed.fileKey).toBe('processed/x.png');
  });

  it('decodes percent-encoded fileKey', () => {
    const parsed = parseLocalMediaUrl(`local-media://${V2_ID}/processed/a%20b.png`);
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.fileKey).toBe('processed/a b.png');
  });

  it('returns null for non-local-media URL', () => {
    expect(parseLocalMediaUrl('http://example.com/x.png')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseLocalMediaUrl('')).toBeNull();
  });

  it('returns null for only scheme (no fileKey)', () => {
    expect(parseLocalMediaUrl('local-media://')).toBeNull();
  });

  it('returns null for scope with no fileKey (trailing slash)', () => {
    expect(parseLocalMediaUrl(`local-media://${V2_ID}/`)).toBeNull();
  });

  it('parses bare fileKey without slash (no scope)', () => {
    const parsed = parseLocalMediaUrl('local-media://bare-file.png');
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBeNull();
    expect(parsed.fileKey).toBe('bare-file.png');
  });
});

describe('extractMediaFileKey (thin wrapper)', () => {
  it('returns fileKey from V2 URL without scope segment (regression: this bug fix)', () => {
    // 本次 bug 的直接回归断言：V2 URL 的 fileKey 不应包含 scope 段
    const key = extractMediaFileKey(`local-media://${V2_ID}/processed/abc.png`);
    expect(key).toBe('processed/abc.png');
  });

  it('returns fileKey from V1 URL (compat)', () => {
    const key = extractMediaFileKey(`local-media://${V1_REF}/processed/abc.png`);
    expect(key).toBe('processed/abc.png');
  });

  it('returns null for non-local-media URL', () => {
    expect(extractMediaFileKey('http://example.com/x.png')).toBeNull();
  });

  it('returns fileKey for bare URL (no scope)', () => {
    expect(extractMediaFileKey('local-media://bare.png')).toBe('bare.png');
  });
});

describe('round-trip', () => {
  it('V2: buildLocalMediaUrlV2 → parseLocalMediaUrl → scope/fileKey preserved', () => {
    const url = buildLocalMediaUrlV2(V2_ID, 'processed/abc.png');
    if (url === null) { expect.fail('expected url'); return; }
    const parsed = parseLocalMediaUrl(url);
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBe(V2_ID);
    expect(parsed.fileKey).toBe('processed/abc.png');
  });

  it('V1: buildLocalMediaUrl → parseLocalMediaUrl → scope/fileKey preserved', () => {
    const url = buildLocalMediaUrl(V1_REF, 'processed/abc.png');
    if (url === null) { expect.fail('expected url'); return; }
    const parsed = parseLocalMediaUrl(url);
    if (parsed === null) { expect.fail('expected parsed'); return; }
    expect(parsed.scope).toBe(V1_REF);
    expect(parsed.fileKey).toBe('processed/abc.png');
  });
});
