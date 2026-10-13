import { useCallback } from 'react';

export type DispatchQueueTask = {
  id: string;
  modelId: string;
  payload: unknown;
  status: 'scheduled' | 'dispatching' | 'settled' | 'error';
  executor: () => Promise<unknown>;
};

export interface DispatchQueueStats {
  scheduled: number; // 等待本地调度的任务数
  dispatching: number; // 正在本地执行的任务数
  settled: number; // 已落定的任务数（本次会话）
  error: number; // 报错的任务数（本次会话）
  total: number; // 总任务数
}

type InternalDispatchQueueTask = DispatchQueueTask & {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown | undefined) => void;
};

const createDeferred = () => {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason: unknown | undefined) => void = () => {};
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const randomId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const RETIRED_QUEUE_STATS: DispatchQueueStats = {
  scheduled: 0,
  dispatching: 0,
  settled: 0,
  error: 0,
  total: 0,
};

export const useTaskQueue = (_options: { defaultMaxConcurrent: number | undefined } | undefined) => {
  // Phase E Slice 2: 生产路径已不再依赖本地队列。
  // 这里仅保留 compat API，避免旧测试或临时调用点在清理期直接崩溃。

  const enqueue = useCallback(
    (
      modelId: string,
      task: Omit<DispatchQueueTask, 'status' | 'modelId' | 'id'> &
        Partial<Pick<DispatchQueueTask, 'id'>> |
        null,
      _opts: { maxConcurrent: number | undefined } | undefined
    ) => {
      if (!task || typeof task.executor !== 'function') {
        console.error('[useTaskQueue] invalid task or missing executor', { modelId, task });
        return null;
      }
      const deferred = createDeferred();
      const wrappedTask: InternalDispatchQueueTask = {
        id: task.id ?? randomId(),
        modelId,
        payload: task.payload ?? null,
        status: 'dispatching',
        executor: task.executor,
        promise: deferred.promise,
        resolve: deferred.resolve,
        reject: deferred.reject,
      };
      void Promise.resolve()
        .then(() => wrappedTask.executor())
        .then((result) => {
          wrappedTask.status = 'settled';
          wrappedTask.resolve(result);
        })
        .catch((error) => {
          wrappedTask.status = 'error';
          wrappedTask.reject(error);
        });
      return wrappedTask.promise;
    },
    []
  );

  const getQueueLength = useCallback((_modelId: string, _opts: { maxConcurrent: number | undefined } | undefined) => 0, []);

  const getQueueStats = useCallback(
    (_modelId: string, _opts: { maxConcurrent: number | undefined } | undefined): DispatchQueueStats => RETIRED_QUEUE_STATS,
    []
  );

  /** @deprecated 队列不再有容量限制，此方法始终返回 false */
  const isQueueFull = useCallback(
    (_modelId: string, _opts: { maxConcurrent: number | undefined } | undefined) => {
      return false;
    },
    []
  );

  return {
    enqueue,
    getQueueLength,
    isQueueFull,
    getQueueStats,
  };
};
