import { describe, expect, it } from 'vitest';
import {
  CLIPBOARD_IPC_CHANNELS,
  ClipboardWriteTextRequestSchema,
  ClipboardWriteTextResponseSchema,
  ClipboardWriteTextFailureReasonSchema,
  ClipboardWriteImageRequestSchema,
  ClipboardWriteImageResponseSchema,
  ClipboardWriteImageFailureReasonSchema,
} from '../src/clipboard-ipc';

describe('CLIPBOARD_IPC_CHANNELS', () => {
  it('exposes write-text channel name', () => {
    expect(CLIPBOARD_IPC_CHANNELS.WRITE_TEXT).toBe('clipboard:write-text');
  });

  it('exposes write-image-from-url channel name', () => {
    expect(CLIPBOARD_IPC_CHANNELS.WRITE_IMAGE_FROM_URL).toBe('clipboard:write-image-from-url');
  });
});

describe('ClipboardWriteTextRequestSchema', () => {
  it('accepts non-empty text', () => {
    expect(ClipboardWriteTextRequestSchema.parse({ text: 'hello' })).toEqual({ text: 'hello' });
  });

  it('rejects empty text', () => {
    expect(() => ClipboardWriteTextRequestSchema.parse({ text: '' })).toThrow();
  });

  it('rejects missing text field', () => {
    expect(() => ClipboardWriteTextRequestSchema.parse({})).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() => ClipboardWriteTextRequestSchema.parse({ text: 'a', extra: 1 })).toThrow();
  });
});

describe('ClipboardWriteTextResponseSchema', () => {
  it('accepts success response', () => {
    expect(ClipboardWriteTextResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it.each([
    'not-in-browser',
    'not-in-electron',
    'empty-text',
    'write-failed',
    'invoke-failed',
  ] as const)('accepts failure response with reason=%s', (reason) => {
    expect(ClipboardWriteTextResponseSchema.parse({ ok: false, reason })).toEqual({
      ok: false,
      reason,
    });
  });

  it('rejects failure response with invalid reason', () => {
    expect(() =>
      ClipboardWriteTextResponseSchema.parse({ ok: false, reason: 'random' }),
    ).toThrow();
  });

  it('rejects response missing reason on failure', () => {
    expect(() => ClipboardWriteTextResponseSchema.parse({ ok: false })).toThrow();
  });

  it('rejects success response with extra fields', () => {
    expect(() => ClipboardWriteTextResponseSchema.parse({ ok: true, extra: 1 })).toThrow();
  });
});

describe('ClipboardWriteTextFailureReasonSchema', () => {
  it('contains exactly 5 reasons', () => {
    const reasons = [
      'not-in-browser',
      'not-in-electron',
      'empty-text',
      'write-failed',
      'invoke-failed',
    ] as const;
    for (const r of reasons) {
      expect(ClipboardWriteTextFailureReasonSchema.parse(r)).toBe(r);
    }
    expect(reasons.length).toBe(5);
  });
});

describe('ClipboardWriteImageRequestSchema', () => {
  it('accepts valid url + non-null projectPath', () => {
    expect(
      ClipboardWriteImageRequestSchema.parse({
        url: 'local-media://__global__/abc.png',
        projectPath: '/tmp/proj',
      }),
    ).toEqual({ url: 'local-media://__global__/abc.png', projectPath: '/tmp/proj' });
  });

  it('accepts null projectPath', () => {
    expect(
      ClipboardWriteImageRequestSchema.parse({
        url: 'local-media://__global__/abc.png',
        projectPath: null,
      }),
    ).toEqual({ url: 'local-media://__global__/abc.png', projectPath: null });
  });

  it('rejects empty url', () => {
    expect(() =>
      ClipboardWriteImageRequestSchema.parse({ url: '', projectPath: null }),
    ).toThrow();
  });

  it('rejects missing url', () => {
    expect(() => ClipboardWriteImageRequestSchema.parse({ projectPath: null })).toThrow();
  });

  it('rejects missing projectPath', () => {
    expect(() =>
      ClipboardWriteImageRequestSchema.parse({ url: 'local-media://__global__/abc.png' }),
    ).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    expect(() =>
      ClipboardWriteImageRequestSchema.parse({
        url: 'local-media://__global__/abc.png',
        projectPath: null,
        extra: 1,
      }),
    ).toThrow();
  });
});

describe('ClipboardWriteImageResponseSchema', () => {
  it('accepts success response with filePath', () => {
    expect(
      ClipboardWriteImageResponseSchema.parse({ ok: true, filePath: '/tmp/x.png' }),
    ).toEqual({ ok: true, filePath: '/tmp/x.png' });
  });

  it('rejects success response missing filePath', () => {
    expect(() => ClipboardWriteImageResponseSchema.parse({ ok: true })).toThrow();
  });

  it('rejects success response with empty filePath', () => {
    expect(() =>
      ClipboardWriteImageResponseSchema.parse({ ok: true, filePath: '' }),
    ).toThrow();
  });

  const imageFailureReasons = [
    'missing-url',
    'missing-project-path',
    'not-files-url',
    'resolve-failed',
    'invalid-file-key',
    'unsafe-file-key',
    'missing-media-dir',
    'path-outside-media',
    'not-found',
    'read-failed',
    'invoke-failed',
    'not-in-browser',
    'not-in-electron',
  ] as const;

  it.each(imageFailureReasons)('accepts failure response with reason=%s', (reason) => {
    expect(ClipboardWriteImageResponseSchema.parse({ ok: false, reason })).toEqual({
      ok: false,
      reason,
    });
  });

  it('rejects failure response with invalid reason', () => {
    expect(() =>
      ClipboardWriteImageResponseSchema.parse({ ok: false, reason: 'random' }),
    ).toThrow();
  });
});

describe('ClipboardWriteImageFailureReasonSchema', () => {
  it('contains exactly 13 reasons', () => {
    const reasons = [
      'missing-url',
      'missing-project-path',
      'not-files-url',
      'resolve-failed',
      'invalid-file-key',
      'unsafe-file-key',
      'missing-media-dir',
      'path-outside-media',
      'not-found',
      'read-failed',
      'invoke-failed',
      'not-in-browser',
      'not-in-electron',
    ] as const;
    for (const r of reasons) {
      expect(ClipboardWriteImageFailureReasonSchema.parse(r)).toBe(r);
    }
    expect(reasons.length).toBe(13);
  });
});
