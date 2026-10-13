import { describe, expect, it } from 'vitest';
import { rewriteFilesReferencesInString, scanFilesReferences } from '@/features/canvas/export/filesRef';

describe('filesRef', () => {
  it('scanFilesReferences extracts /files keys from nested structures', () => {
    const input = {
      a: '/files/a.png',
      b: {
        c: 'http://localhost:1234/files/b.mp4?t=1',
        d: ['nope', { e: '/files/c.ogg#x' }],
      },
    };

    const scan = scanFilesReferences(input);
    expect(scan.fileKeys.sort()).toEqual(['a.png', 'b.mp4', 'c.ogg'].sort());
  });

  it('rewriteFilesReferencesInString only replaces the /files/<key> segment', () => {
    const mapping = {
      'a.png': '/files/new-a',
      'b.mp4': '/files/new-b',
    };

    expect(rewriteFilesReferencesInString('/files/a.png', mapping)).toBe('/files/new-a');
    expect(rewriteFilesReferencesInString('http://x.test/files/b.mp4?t=1', mapping)).toBe(
      'http://x.test/files/new-b?t=1'
    );
    expect(rewriteFilesReferencesInString('http://127.0.0.1:1234/files/b.mp4?t=1#x', mapping)).toBe(
      '/files/new-b?t=1#x'
    );
    expect(rewriteFilesReferencesInString('http://localhost:1234/files/b.mp4', mapping)).toBe('/files/new-b');
    expect(rewriteFilesReferencesInString('http://[::1]:1234/files/b.mp4#x', mapping)).toBe('/files/new-b#x');
    expect(rewriteFilesReferencesInString('no match', mapping)).toBe('no match');
  });
});
