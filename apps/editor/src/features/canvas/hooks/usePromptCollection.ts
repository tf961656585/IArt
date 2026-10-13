/**
 * 提示词收藏 CRUD Hook
 */

import { useState, useEffect, useCallback } from 'react';
import type { PromptCollectionItem } from '../types/promptCollection';
import { PromptCollectionStore } from '../services/promptCollectionStore';
import { trackPromptEvent } from './usePromptAnalytics';

interface UsePromptCollectionReturn {
  items: PromptCollectionItem[];
  isLoading: boolean;
  error: Error | null;
  add: (name: string, content: string) => Promise<string | null>;
  update: (id: string, name: string, content: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePromptCollection(): UsePromptCollectionReturn {
  const [items, setItems] = useState<PromptCollectionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      const all = await PromptCollectionStore.getAll({ force: undefined });
      setItems(all);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (name: string, content: string) => {
      const id = await PromptCollectionStore.add({ name, content });
      if (id) {
        trackPromptEvent({ type: 'create', itemId: id, content });
        await refresh();
      }
      return id;
    },
    [refresh]
  );

  const update = useCallback(
    async (id: string, name: string, content: string) => {
      const success = await PromptCollectionStore.update(id, { name, content });
      if (success) {
        trackPromptEvent({ type: 'update', itemId: id, content });
        await refresh();
      }
      return success;
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      await PromptCollectionStore.delete(id);
      trackPromptEvent({ type: 'delete', itemId: id, content: undefined });
      await refresh();
    },
    [refresh]
  );

  return { items, isLoading, error, add, update, remove, refresh };
}
