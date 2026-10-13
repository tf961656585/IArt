/**
 * 系统提示词库存储服务（IPC 版）
 *
 * 用户级全局资源，独立于 PromptPresetItem。
 * 通过 window.electron.storage.* N 组 IPC 调用。
 */

import type { SystemPromptItem } from '@iart/contracts';
import type {
  StorageListSystemPromptsResult,
  StorageGetSystemPromptResult,
  StorageCreateSystemPromptResult,
  StorageUpdateSystemPromptResult,
  StorageDeleteSystemPromptResult,
} from '@iart/contracts';

const getStorage = () => {
  if (typeof window === 'undefined') return null;
  return (window.electron !== null && window.electron !== undefined ? window.electron.storage : undefined) ?? null;
};

const ipcInvoke = async <T>(channel: string, args: unknown | undefined): Promise<T> => {
  const storage = getStorage();
  if (!storage || typeof storage[channel] !== 'function') {
    throw new Error('无法读写本地数据，请重启应用后再试。');
  }
  return (storage[channel] as (args: unknown | undefined) => Promise<T>)(args);
};

class SystemPromptStoreImpl {
  private allCache: SystemPromptItem[] | null = null;
  private allCachePromise: Promise<SystemPromptItem[]> | null = null;

  private invalidateCache() {
    this.allCache = null;
    this.allCachePromise = null;
  }

  async getAll(options: { force: boolean | undefined; keyword: string | undefined } | undefined): Promise<SystemPromptItem[]> {
    const force = options !== null && options !== undefined ? options.force : undefined;
    const keyword = options !== null && options !== undefined ? options.keyword : undefined;

    if (!force && !keyword && this.allCache) {
      return this.allCache;
    }
    if (!force && !keyword && this.allCachePromise) {
      return this.allCachePromise;
    }

    const loadPromise = (async () => {
      const resp = await ipcInvoke<StorageListSystemPromptsResult>(
        'storage:list-system-prompts',
        keyword ? { keyword } : {},
      );
      const next = Array.isArray(resp !== null && resp !== undefined ? resp.items : undefined) ? resp.items : [];
      if (!keyword) {
        this.allCache = next;
      }
      return next;
    })();

    if (!keyword) {
      this.allCachePromise = loadPromise;
    }
    try {
      return await loadPromise;
    } finally {
      if (!keyword) {
        this.allCachePromise = null;
      }
    }
  }

  async get(id: string): Promise<SystemPromptItem | null> {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) return null;
    try {
      const resp = await ipcInvoke<StorageGetSystemPromptResult>(
        'storage:get-system-prompt',
        { id: trimmed },
      );
      return (resp !== null && resp !== undefined ? resp.item : undefined) ?? null;
    } catch {
      return null;
    }
  }

  async create(params: { name: string; description: string; systemPrompt: string }): Promise<string | null> {
    const resp = await ipcInvoke<StorageCreateSystemPromptResult>(
      'storage:create-system-prompt',
      params,
    );
    this.invalidateCache();
    return (resp !== null && resp !== undefined && resp.item !== null && resp.item !== undefined ? resp.item.id : undefined) ?? null;
  }

  async update(
    id: string,
    updates: { name: string | undefined; description: string | undefined; systemPrompt: string | undefined },
  ): Promise<boolean> {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) return false;
    try {
      await ipcInvoke<StorageUpdateSystemPromptResult>(
        'storage:update-system-prompt',
        { id: trimmed, ...updates },
      );
      this.invalidateCache();
      return true;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<void> {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) return;
    try {
      await ipcInvoke<StorageDeleteSystemPromptResult>(
        'storage:delete-system-prompt',
        { id: trimmed },
      );
      this.invalidateCache();
    } catch {
      // ignore
    }
  }

  async resolveSystemPromptText(systemPromptId: string | undefined): Promise<string | undefined> {
    if (systemPromptId === null || systemPromptId === undefined) return undefined;
    const item = await this.get(systemPromptId);
    if (item === null) return undefined;
    return item.systemPrompt;
  }
}

export const SystemPromptStore = new SystemPromptStoreImpl();
