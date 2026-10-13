/**
 * Task Terminal Waiter
 *
 * agent 工具调用的任务终态等待登记表（spec 04「工具调用循环语义」阻塞等待）。
 *
 * - 生成类工具调用派生任务后，在同一 Backend 进程内等待任务到达终态
 *   （succeeded / failed / cancelled），产物资产随终态直接带回，不轮询、不设超时。
 * - 结算点：任务执行链的终态打点（task-engine-state 的两处终态路径）与
 *   取消结算（task-cancel-service）。结算幂等，先到先得。
 * - 会话取消联动：请求中止时等待方收到 `cancelled` 结算（任务本身由取消链路另行结算）。
 */

import type { RuntimeMediaAssetView } from '@iart/contracts';
import { logDebug } from './logging.cts';

export type TaskTerminalOutcome = {
  status: 'succeeded' | 'failed' | 'cancelled';
  /** 终态随行的产物资产（仅成功路径携带；空数组时消费方可经 Backend→Main 读取通道兜底）。 */
  mediaAssets: RuntimeMediaAssetView[];
  errorMessage: string | null;
};

type WaiterEntry = {
  resolve: (outcome: TaskTerminalOutcome) => void;
  settled: boolean;
};

const waitersByTaskId = new Map<string, WaiterEntry>();

const normalizedTaskId = (taskId: string): string => taskId.trim();

/** 等待任务终态。重复等待同一任务共享同一次结算。 */
export const awaitTaskTerminal = (taskId: string): Promise<TaskTerminalOutcome> => {
  const key = normalizedTaskId(taskId);
  return new Promise((resolve) => {
    waitersByTaskId.set(key, { resolve, settled: false });
  });
};

/** 终态结算（幂等：同一任务先到先得，后续结算忽略）。 */
export const settleTaskTerminal = (taskId: string, outcome: TaskTerminalOutcome): void => {
  const key = normalizedTaskId(taskId);
  const entry = waitersByTaskId.get(key);
  if (!entry || entry.settled) return;
  entry.settled = true;
  waitersByTaskId.delete(key);
  logDebug('[task-terminal-waiter] task settled', {
    taskId: key,
    status: outcome.status,
    mediaAssetCount: outcome.mediaAssets.length,
  });
  entry.resolve(outcome);
};

/** 请求中止联动：立即以 cancelled 结算（任务取消由取消链路负责，不在这里重复触发）。 */
export const cancelTaskWaiters = (taskIds: ReadonlyArray<string>): void => {
  for (const taskId of taskIds) {
    const entry = waitersByTaskId.get(normalizedTaskId(taskId));
    if (entry && !entry.settled) {
      settleTaskTerminal(taskId, { status: 'cancelled', mediaAssets: [], errorMessage: null });
    }
  }
};

/** 测试清理：清空登记表（未结算的等待 Promise 不再兑现）。 */
export const __clearTaskTerminalWaitersForTests = (): void => {
  waitersByTaskId.clear();
};
