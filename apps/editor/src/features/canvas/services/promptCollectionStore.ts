/**
 * 提示词收藏存储服务（IPC 版）
 * - 通过 window.electron.storage.* IPC 调用 Storage Service
 * - 不再使用 WS/HTTP 调用
 */

import type { PromptCollectionItem } from '../types/promptCollection';
import type {
  StorageListPromptPresetsResult,
  StorageGetPromptPresetResult,
  StorageCreatePromptPresetResult,
  StorageUpdatePromptPresetResult,
  StorageDeletePromptPresetResult,
} from '@iart/contracts/editor-storage-contract';

const getStorage = () => {
  if (typeof window === "undefined") return null;
  return (window.electron !== null && window.electron !== undefined ? window.electron.storage : undefined) ?? null;
};

const ipcInvoke = async <T>(channel: string, args: unknown | undefined): Promise<T> => {
  const storage = getStorage();
  if (!storage || typeof storage[channel] !== "function") {
    throw new Error("无法读写本地数据，请重启应用后再试。");
  }
  return (storage[channel] as (args: unknown | undefined) => Promise<T>)(args);
};

class PromptCollectionStoreImpl {
  private allCache: PromptCollectionItem[] | null = null;
  private allCachePromise: Promise<PromptCollectionItem[]> | null = null;

  private invalidateCache() {
    this.allCache = null;
    this.allCachePromise = null;
  }

  async add(
    item: Omit<PromptCollectionItem, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string | null> {
    const resp = await ipcInvoke<StorageCreatePromptPresetResult>(
      "storage:create-prompt-preset",
      { name: item.name, content: item.content },
    );
    this.invalidateCache();
    return (resp !== null && resp !== undefined && resp.preset !== null && resp.preset !== undefined ? resp.preset.id : undefined) ?? null;
  }

  async get(id: string): Promise<PromptCollectionItem | null> {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) return null;
    try {
      const resp = await ipcInvoke<StorageGetPromptPresetResult>(
        "storage:get-prompt-preset",
        { id: trimmed },
      );
      return (resp !== null && resp !== undefined ? resp.preset : undefined) ?? null;
    } catch {
      return null;
    }
  }

  async getAll(options: { force: boolean | undefined } | undefined): Promise<PromptCollectionItem[]> {
    if (!(options !== null && options !== undefined ? options.force : undefined) && this.allCache) {
      return this.allCache;
    }
    if (!(options !== null && options !== undefined ? options.force : undefined) && this.allCachePromise) {
      return this.allCachePromise;
    }
    const loadPromise = (async () => {
      const resp = await ipcInvoke<StorageListPromptPresetsResult>(
        "storage:list-prompt-presets",
        undefined,
      );
      const next = Array.isArray((resp !== null && resp !== undefined ? resp.presets : undefined)) ? resp.presets : [];
      this.allCache = next;
      return next;
    })();

    this.allCachePromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      this.allCachePromise = null;
    }
  }

  async update(
    id: string,
    updates: Pick<PromptCollectionItem, 'name' | 'content'>
  ): Promise<boolean> {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) return false;
    try {
      await ipcInvoke<StorageUpdatePromptPresetResult>(
        "storage:update-prompt-preset",
        { id: trimmed, ...updates },
      );
      this.invalidateCache();
      return true;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<void> {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed) return;
    try {
      await ipcInvoke<StorageDeletePromptPresetResult>(
        "storage:delete-prompt-preset",
        { id: trimmed },
      );
      this.invalidateCache();
    } catch {
      // ignore
    }
  }
}

export const PromptCollectionStore = new PromptCollectionStoreImpl();
