import type { ObjectURLPoolEntry } from '../types/mediaCache';

import { cast } from '@/lib/utils';
import { MediaCacheStore } from './mediaCacheStore';

/**
 * Object URL 池管理器
 *
 * 架构职责：
 * - 管理 Object URL 的创建、复用和回收
 * - 通过引用计数 + 延迟 revoke 策略，平衡内存占用和用户体验
 * - 防止快速切换时的闪烁问题
 *
 * 内存释放策略：
 * 1. refCount > 0 时：URL 被使用中，不释放
 * 2. refCount = 0 时：启动延迟 revoke 计时器（防闪烁）
 * 3. 超过 maxPoolSize 时：立即 LRU 驱逐空闲 URL
 * 4. 调用 flush() 时：立即释放所有空闲 URL
 */
class ObjectURLPoolImpl {
  private pool = new Map<string, ObjectURLPoolEntry>();
  private revokeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private maxPoolSize = 200 * 1024 * 1024; // 200MB
  private currentSize = 0;
  private revokeDelay = 3000; // 3秒延迟，防止快速切换时闪烁

  async acquire(cacheId: string): Promise<string | null> {
    if (!cacheId) return null;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return null;
    }

    // 如果有待 revoke 的计时器，取消它
    const pendingTimer = this.revokeTimers.get(cacheId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.revokeTimers.delete(cacheId);
    }

    const existing = this.pool.get(cacheId);
    if (existing) {
      existing.refCount += 1;
      existing.lastAccess = Date.now();
      return existing.objectUrl;
    }

    const cacheEntry = await MediaCacheStore.get(cacheId);
    if (!cacheEntry) return null;

    const size = Number(cacheEntry.sizeBytes) || cacheEntry.data.size || 0;
    this.evictIfNeeded(size);

    const objectUrl = URL.createObjectURL(cacheEntry.data);
    this.pool.set(cacheId, {
      cacheId,
      objectUrl,
      refCount: 1,
      lastAccess: Date.now(),
      sizeBytes: size,
    });
    this.currentSize += size;
    return objectUrl;
  }

  release(cacheId: string): void {
    const entry = this.pool.get(cacheId);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastAccess = Date.now();

    if (entry.refCount === 0) {
      // 清除可能存在的旧计时器
      const existingTimer = this.revokeTimers.get(cacheId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // 如果超过池容量，立即释放
      if (this.currentSize > this.maxPoolSize) {
        this.revokeEntry(cacheId, entry);
        return;
      }

      // 否则设置延迟 revoke（防止快速切换闪烁）
      const timer = setTimeout(() => {
        const currentEntry = this.pool.get(cacheId);
        if (currentEntry && currentEntry.refCount === 0) {
          this.revokeEntry(cacheId, currentEntry);
        }
        this.revokeTimers.delete(cacheId);
      }, this.revokeDelay);

      this.revokeTimers.set(cacheId, timer);
    }
  }

  private evictIfNeeded(requiredSize: number): void {
    if (requiredSize > this.maxPoolSize) {
      // 单个资源超过池容量，清空后让调用方决定是否继续占用内存
      this.clear();
      return;
    }

    const lruEntries = [...this.pool.values()]
      .filter((item) => item.refCount === 0)
      .sort((a, b) => a.lastAccess - b.lastAccess);

    for (const entry of lruEntries) {
      if (this.currentSize + requiredSize <= this.maxPoolSize) break;
      // 取消该 entry 的延迟 revoke 计时器
      const timer = this.revokeTimers.get(entry.cacheId);
      if (timer) {
        clearTimeout(timer);
        this.revokeTimers.delete(entry.cacheId);
      }
      this.revokeEntry(entry.cacheId, entry);
    }
  }

  private revokeEntry(cacheId: string, entry: ObjectURLPoolEntry): void {
    try {
      URL.revokeObjectURL(entry.objectUrl);
    } catch {
      // ignore revoke errors
    }
    this.pool.delete(cacheId);
    this.currentSize = Math.max(0, this.currentSize - entry.sizeBytes);
  }

  /**
   * 立即清理所有空闲 URL（refCount = 0）
   * 用于画布切换、内存告警等场景
   */
  flush(): void {
    for (const [cacheId, entry] of this.pool.entries()) {
      if (entry.refCount === 0) {
        // 取消延迟 revoke 计时器
        const timer = this.revokeTimers.get(cacheId);
        if (timer) {
          clearTimeout(timer);
          this.revokeTimers.delete(cacheId);
        }
        this.revokeEntry(cacheId, entry);
      }
    }
  }

  /**
   * 清空所有 URL（包括使用中的）
   * 谨慎使用：会导致正在显示的媒体失效
   */
  clear(): void {
    // 清除所有延迟 revoke 计时器
    for (const timer of this.revokeTimers.values()) {
      clearTimeout(timer);
    }
    this.revokeTimers.clear();

    for (const entry of this.pool.values()) {
      try {
        URL.revokeObjectURL(entry.objectUrl);
      } catch {
        // ignore revoke errors
      }
    }
    this.pool.clear();
    this.currentSize = 0;
  }

  /**
   * 获取池状态统计
   */
  getStats(): { poolSize: number; currentSize: number; entryCount: number } {
    return {
      poolSize: this.maxPoolSize,
      currentSize: this.currentSize,
      entryCount: this.pool.size,
    };
  }

  /**
   * 获取指定 entry 的状态（用于调试）
   */
  getEntryStats(cacheId: string): ObjectURLPoolEntry | null {
    return this.pool.get(cacheId) ?? null;
  }

  /**
   * 获取所有 entries 的详细信息（用于调试）
   */
  getDetailedStats(): {
    poolSize: number;
    currentSize: number;
    entryCount: number;
    entries: Array<{
      cacheId: string;
      refCount: number;
      sizeBytes: number;
      lastAccess: number;
      hasPendingRevoke: boolean;
    }>;
  } {
    return {
      poolSize: this.maxPoolSize,
      currentSize: this.currentSize,
      entryCount: this.pool.size,
      entries: [...this.pool.values()].map((entry) => ({
        cacheId: entry.cacheId,
        refCount: entry.refCount,
        sizeBytes: entry.sizeBytes,
        lastAccess: entry.lastAccess,
        hasPendingRevoke: this.revokeTimers.has(entry.cacheId),
      })),
    };
  }
}

export const ObjectURLPool = new ObjectURLPoolImpl();

// 开发环境调试工具
if (typeof window !== 'undefined' && process.env['NODE_ENV'] === 'development') {
  cast<{ __MEDIA_CACHE_DEBUG__: unknown }>(window).__MEDIA_CACHE_DEBUG__ = {
    getStats: () => ObjectURLPool.getStats(),
    getDetailedStats: () => ObjectURLPool.getDetailedStats(),
    flush: () => {
      ObjectURLPool.flush();
      console.log('[ObjectURLPool] flush 完成');
    },
    clear: () => {
      ObjectURLPool.clear();
      console.log('[ObjectURLPool] clear 完成');
    },
  };
}
