import { describe, expect, it } from 'vitest';
import { tryExtractImageUrlFromDataTransfer } from '@/features/canvas/dnd/nodeGraphDropPayload';

const buildDataTransfer = (mapping: Record<string, string | undefined>) =>
  ({
    getData: (type: string) => mapping[type] ?? '',
  }) as never;

describe('tryExtractImageUrlFromDataTransfer', () => {
  it('extracts image url from application/nodeGraph-node (imageInput)', () => {
    const dt = buildDataTransfer({
      'application/nodeGraph-node': JSON.stringify({ key: 'imageInput', data: { imageUrl: '/a.png' } }),
    });
    expect(tryExtractImageUrlFromDataTransfer(dt)).toBe('/a.png');
  });

  it('returns null for non-imageInput nodeGraph payload', () => {
    const dt = buildDataTransfer({
      'application/nodeGraph-node': JSON.stringify({ key: 'videoInput', data: { videoUrl: '/a.mp4' } }),
    });
    expect(tryExtractImageUrlFromDataTransfer(dt)).toBeNull();
  });

  it('extracts url from text/plain when it looks like an image url', () => {
    const dt = buildDataTransfer({
      'text/plain': 'https://example.com/a.png',
    });
    expect(tryExtractImageUrlFromDataTransfer(dt)).toBe('https://example.com/a.png');
  });

  it('returns null for text/plain that does not look like an image url', () => {
    const dt = buildDataTransfer({
      'text/plain': 'hello world',
    });
    expect(tryExtractImageUrlFromDataTransfer(dt)).toBeNull();
  });
});

