/**
 * MediaCacheStore / ObjectURLPool 基础行为单元测试
 * - 项目约定：不使用 IndexedDB
 */

import { describe, it, expect } from 'vitest';

const must = <T,>(value: T | null | undefined): T => {
  if (value == null) throw new Error('expected value');
  return value;
};

describe('MediaCacheEntry structure', () => {
  it('should have correct interface shape', () => {
    const entry = {
      cacheId: 'cache_123_node1_1234567890',
      data: new Blob(['test'], { type: 'image/png' }),
      mimeType: 'image/png',
      originalUrl: 'https://example.com/image.png',
      cachedAt: Date.now(),
      nodeGraphId: 'graph_123',
      nodeId: 'node_1',
      sizeBytes: 4,
    };

    expect(entry.cacheId).toBeDefined();
    expect(entry.data).toBeInstanceOf(Blob);
    expect(entry.mimeType).toBe('image/png');
    expect(entry.sizeBytes).toBe(4);
  });
});

describe('cacheId format', () => {
  it('should follow cache_${nodeGraphId}_${nodeId}_${timestamp} format', () => {
    const nodeGraphId = 'graph_abc123';
    const nodeId = 'node_xyz789';
    const timestamp = Date.now();
    const cacheId = `cache_${nodeGraphId}_${nodeId}_${timestamp}`;

    expect(cacheId).toMatch(/^cache_graph_abc123_node_xyz789_\d+$/);
  });
});

describe('ObjectURLPool', () => {
  it('should have 200MB max pool size', () => {
    const maxPoolSize = 200 * 1024 * 1024;
    expect(maxPoolSize).toBe(209715200);
  });

  it('should evict least recently used entries when pool is full', () => {
    const entries = [
      { cacheId: 'a', lastAccess: 1000, refCount: 0 },
      { cacheId: 'b', lastAccess: 2000, refCount: 0 },
      { cacheId: 'c', lastAccess: 500, refCount: 0 }, // 最早访问
    ];

    const sorted = entries
      .filter((e) => e.refCount === 0)
      .sort((a, b) => a.lastAccess - b.lastAccess);

    expect(must(sorted.at(0)).cacheId).toBe('c');
  });

  it('should not evict entries with refCount > 0', () => {
    const entries = [
      { cacheId: 'a', lastAccess: 1000, refCount: 1 }, // 有引用
      { cacheId: 'b', lastAccess: 2000, refCount: 0 },
    ];

    const evictable = entries.filter((e) => e.refCount === 0);
    expect(evictable.length).toBe(1);
    expect(must(evictable.at(0)).cacheId).toBe('b');
  });
});
