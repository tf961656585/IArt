import type { MediaCacheEntry } from '../types/mediaCache';

/**
 * 媒体缓存存储
 * - 桌面端不使用 IndexedDB
 * - 当前实现为内存 Map（进程内生命周期）
 */

class MediaCacheStoreImpl {
  private store = new Map<string, MediaCacheEntry>();

  async put(entry: MediaCacheEntry): Promise<void> {
    if (!(entry !== null && entry !== undefined ? entry.cacheId : undefined)) return;
    this.store.set(entry.cacheId, entry);
  }

  async get(cacheId: string): Promise<MediaCacheEntry | null> {
    if (!cacheId) return null;
    return this.store.get(cacheId) ?? null;
  }

  async delete(cacheId: string): Promise<void> {
    if (!cacheId) return;
    this.store.delete(cacheId);
  }

  async deleteByNodeGraph(nodeGraphId: string): Promise<void> {
    if (!nodeGraphId) return;
    for (const [key, entry] of this.store.entries()) {
      if ((entry !== null && entry !== undefined ? entry.nodeGraphId : undefined) === nodeGraphId) {
        this.store.delete(key);
      }
    }
  }

  async cleanup(maxAge: number, maxSize: number): Promise<{ deletedCount: number }> {
    const now = Date.now();
    const entries = Array.from(this.store.values());
    const ageThreshold = maxAge > 0 ? now - maxAge : null;
    const sorted = [...entries].sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));

    const toDelete: MediaCacheEntry[] = [];
    let currentSize = 0;

    for (const entry of sorted) {
      const size = Number(entry.sizeBytes) || (entry.data !== null && entry.data !== undefined ? entry.data.size : undefined) || 0;
      const expired = ageThreshold !== null && (entry.cachedAt || 0) < ageThreshold;
      if (expired) {
        toDelete.push(entry);
        continue;
      }
      if (maxSize > 0 && currentSize + size > maxSize) {
        toDelete.push(entry);
        continue;
      }
      currentSize += size;
    }

    for (const entry of toDelete) {
      if ((entry !== null && entry !== undefined ? entry.cacheId : undefined)) {
        this.store.delete(entry.cacheId);
      }
    }

    return { deletedCount: toDelete.length };
  }

  async getStats(): Promise<{ totalSize: number; count: number }> {
    let totalSize = 0;
    for (const entry of this.store.values()) {
      totalSize += Number(entry.sizeBytes) || (entry.data !== null && entry.data !== undefined ? entry.data.size : undefined) || 0;
    }
    return { totalSize, count: this.store.size };
  }

  async getStatsByNodeGraph(): Promise<Map<string, { size: number; count: number }>> {
    const statsMap = new Map<string, { size: number; count: number }>();
    for (const entry of this.store.values()) {
      const graphId = (entry !== null && entry !== undefined ? entry.nodeGraphId : undefined) || '';
      if (!graphId) continue;
      const size = Number(entry.sizeBytes) || (entry.data !== null && entry.data !== undefined ? entry.data.size : undefined) || 0;
      const existing = statsMap.get(graphId) ?? { size: 0, count: 0 };
      statsMap.set(graphId, { size: existing.size + size, count: existing.count + 1 });
    }
    return statsMap;
  }
}

export const MediaCacheStore = new MediaCacheStoreImpl();

