// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  upsertBackendTaskCache,
  updateBackendTaskCache,
} from '../backendTaskCache';

const STORAGE_KEY = 'iarts_backend_tasks_cache';

const installLocalStorage = (storage: Storage) => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
};

const createMockStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
};

describe('backendTaskCache legacy retirement', () => {
  beforeEach(() => {
    installLocalStorage(createMockStorage());
    localStorage.clear();
  });

  it('upsert 不再持久化 legacy backend task cache，并清掉旧数据', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks: [{ taskId: 'legacy-task' }] }));

    upsertBackendTaskCache({
      taskId: 'task-1',
      model: undefined,
      prompt: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'queued',
      resolvedAt: undefined,
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('update 不再写回 legacy backend task cache，并清掉旧数据', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks: [{ taskId: 'legacy-task' }] }));

    updateBackendTaskCache('task-1', { status: 'succeeded', resolvedAt: Date.now() });

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
