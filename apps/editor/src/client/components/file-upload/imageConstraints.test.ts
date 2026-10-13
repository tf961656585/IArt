import { describe, expect, it } from 'vitest';
import { computeFittedSize, DEFAULT_MAX_IMAGE_DIMENSION } from './imageConstraints';

describe('computeFittedSize', () => {
  it('returns original size when within limit', () => {
    const result = computeFittedSize(500, 600, DEFAULT_MAX_IMAGE_DIMENSION);
    expect(result).toEqual({ width: 500, height: 600, resized: false });
  });

  it('clamps long edge by width while preserving aspect ratio', () => {
    const result = computeFittedSize(2000, 1000, 768);
    expect(result).toEqual({ width: 768, height: 384, resized: true });
  });

  it('clamps long edge by height while preserving aspect ratio', () => {
    const result = computeFittedSize(600, 1200, 768);
    expect(result).toEqual({ width: 384, height: 768, resized: true });
  });

  it('does not upscale small images even with tiny maxDimension', () => {
    const result = computeFittedSize(100, 50, 500);
    expect(result).toEqual({ width: 100, height: 50, resized: false });
  });
});
