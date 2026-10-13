import { describe, expect, it } from 'vitest';
import {
  MediaRefSourceSchema,
  MediaRefPlaceholderSchema,
  isMediaRefPlaceholder,
} from '../src/editor-backend-contract';

describe('MediaRefSourceSchema', () => {
  it('parses inline_data variant', () => {
    const result = MediaRefSourceSchema.parse({
      kind: 'inline_data',
      data: 'base64data',
      mimeType: 'image/png',
    });
    expect(result.kind).toBe('inline_data');
    if (result.kind === 'inline_data') {
      expect(result.data).toBe('base64data');
      expect(result.mimeType).toBe('image/png');
    }
  });

  it('parses url variant', () => {
    const result = MediaRefSourceSchema.parse({
      kind: 'url',
      url: 'https://example.com/image.png',
    });
    expect(result.kind).toBe('url');
    if (result.kind === 'url') {
      expect(result.url).toBe('https://example.com/image.png');
    }
  });

  it('rejects object without kind', () => {
    expect(() => MediaRefSourceSchema.parse({ data: 'abc' })).toThrow();
  });

  it('rejects unknown kind value', () => {
    expect(() => MediaRefSourceSchema.parse({ kind: 'file', path: '/tmp/a.png' })).toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => MediaRefSourceSchema.parse('inline_data')).toThrow();
    expect(() => MediaRefSourceSchema.parse(42)).toThrow();
    expect(() => MediaRefSourceSchema.parse(null)).toThrow();
  });

  it('rejects inline_data missing required fields', () => {
    expect(() => MediaRefSourceSchema.parse({ kind: 'inline_data' })).toThrow();
    expect(() => MediaRefSourceSchema.parse({ kind: 'inline_data', data: 'abc' })).toThrow();
  });

  it('rejects url missing required fields', () => {
    expect(() => MediaRefSourceSchema.parse({ kind: 'url' })).toThrow();
  });
});

describe('MediaRefPlaceholderSchema', () => {
  const fullPlaceholder = {
    __media_ref__: true as const,
    source: {
      kind: 'inline_data' as const,
      data: 'base64data',
      mimeType: 'image/png',
    },
    mimeType: 'image/png',
    filename: 'photo.png',
    fieldPath: 'messages[0].content',
  };

  const minimalPlaceholder = {
    __media_ref__: true as const,
    source: {
      kind: 'url' as const,
      url: 'https://example.com/audio.mp3',
    },
  };

  it('parses a full MediaRefPlaceholder', () => {
    const result = MediaRefPlaceholderSchema.parse(fullPlaceholder);
    expect(result.__media_ref__).toBe(true);
    expect(result.source.kind).toBe('inline_data');
    expect(result.mimeType).toBe('image/png');
    expect(result.filename).toBe('photo.png');
    expect(result.fieldPath).toBe('messages[0].content');
  });

  it('parses a minimal MediaRefPlaceholder (only required fields)', () => {
    const result = MediaRefPlaceholderSchema.parse(minimalPlaceholder);
    expect(result.__media_ref__).toBe(true);
    expect(result.source.kind).toBe('url');
    expect(result.mimeType).toBeUndefined();
    expect(result.filename).toBeUndefined();
    expect(result.fieldPath).toBeUndefined();
  });

  it('rejects object missing __media_ref__ field', () => {
    expect(() =>
      MediaRefPlaceholderSchema.parse({
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }),
    ).toThrow();
  });

  it('rejects object with wrong __media_ref__ value', () => {
    expect(() =>
      MediaRefPlaceholderSchema.parse({
        __media_ref__: false,
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }),
    ).toThrow();
  });

  it('rejects object with invalid source', () => {
    expect(() =>
      MediaRefPlaceholderSchema.parse({
        __media_ref__: true,
        source: { kind: 'invalid' },
      }),
    ).toThrow();
  });

  it('rejects object missing source', () => {
    expect(() =>
      MediaRefPlaceholderSchema.parse({
        __media_ref__: true,
      }),
    ).toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => MediaRefPlaceholderSchema.parse('string')).toThrow();
    expect(() => MediaRefPlaceholderSchema.parse(123)).toThrow();
    expect(() => MediaRefPlaceholderSchema.parse(null)).toThrow();
  });
});

describe('isMediaRefPlaceholder', () => {
  it('returns true for a valid MediaRefPlaceholder', () => {
    expect(
      isMediaRefPlaceholder({
        __media_ref__: true,
        source: { kind: 'inline_data', data: 'abc', mimeType: 'image/png' },
      }),
    ).toBe(true);
  });

  it('returns true for a valid minimal MediaRefPlaceholder', () => {
    expect(
      isMediaRefPlaceholder({
        __media_ref__: true,
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }),
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(isMediaRefPlaceholder(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMediaRefPlaceholder(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isMediaRefPlaceholder('__iart_input_upload__:token123')).toBe(false);
  });

  it('returns false for a plain object without __media_ref__', () => {
    expect(isMediaRefPlaceholder({ source: { kind: 'url', url: 'https://example.com' } })).toBe(false);
  });

  it('returns false for object with __media_ref__: false', () => {
    expect(
      isMediaRefPlaceholder({
        __media_ref__: false,
        source: { kind: 'url', url: 'https://example.com' },
      }),
    ).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isMediaRefPlaceholder(42)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isMediaRefPlaceholder({})).toBe(false);
  });
});
