'use client';

import { cast } from '@/lib/utils';

/**
 * 占位壳分帧升级调度器（spec：画布交互期渲染降级契约.md「moveEnd 后分帧升级契约」）。
 *
 * 职责：收敛期把视口内占位壳节点按帧分批升级。每帧从待升级队列头部取固定数量节点，
 * 调用 upgradeFn 触发状态层移除占位标记，对应组件重渲染为完整态。队列耗尽自停。
 * 调度模型为"批处理多节点、每帧处理 N 个"（FIFO 分帧）。
 *
 * 中断语义（spec「收敛期被新交互中断，未升级占位壳保持占位态」）：
 * - cancel() 只停止后续升级，不回退已完成升级（已升级的是完整态，无需回退）
 * - 运行中再次 start() 视为新批次：取消旧调度，以新队列重新开始
 */

/** rAF 适配器，测试可注入 mock 以控制时序。 */
export type PlaceholderUpgradeAdapters = {
  raf: (cb: () => void) => number;
  cancelRaf: (id: number) => void;
};

export type PlaceholderUpgradeOptions = {
  /** 每帧处理的节点数量。默认 DEFAULT_BATCH_SIZE（实现层裁定项，spec 未收死具体数值）。 */
  batchSize: number;
};

export type PlaceholderUpgradeScheduler = {
  /**
   * 启动一批升级。把 nodeIds 复制到内部队列（不修改入参数组），按帧分批调 upgradeFn。
   * 若已有调度在运行，取消旧调度并以新队列开始（符合"收敛期中断"语义）。
   * 空队列立即完成，不调度 rAF。
   */
  start: (
    nodeIds: string[],
    upgradeFn: (batch: string[]) => void,
    options: Partial<PlaceholderUpgradeOptions> | undefined,
  ) => void;
  /** 停止后续升级，不回退已完成升级。 */
  cancel: () => void;
  /** 是否有调度在运行（队列未耗尽且未被 cancel）。 */
  isRunning: () => boolean;
};

/**
 * 默认每帧升级数量（实现层裁定起始值）。
 * spec 未收死具体数值，此处选 8 作为保守起始点：
 * - 足够小，每帧升级开销可控，不与视口变换或其他渲染任务竞争主线程
 * - 足够大，收敛期升级总帧数有界（100 个节点约 13 帧，约 200ms@60fps）
 * 实测后可按帧开销调整。
 */
export const DEFAULT_UPGRADE_BATCH_SIZE = 8;

const resolveDefaultAdapters = (): PlaceholderUpgradeAdapters => {
  const raf =
    typeof globalThis.requestAnimationFrame === 'function'
      ? (cb: () => void) => cast<number>(globalThis.requestAnimationFrame(() => cb()))
      : (cb: () => void) => cast<number>(globalThis.setTimeout(cb, 0));

  const cancelRaf =
    typeof globalThis.cancelAnimationFrame === 'function'
      ? (id: number) => globalThis.cancelAnimationFrame(id)
      : (id: number) => globalThis.clearTimeout(id);

  return { raf, cancelRaf };
};

export function createPlaceholderUpgradeScheduler(
  adapters: Partial<PlaceholderUpgradeAdapters> | null | undefined,
): PlaceholderUpgradeScheduler {
  const resolvedAdapters: PlaceholderUpgradeAdapters = {
    ...resolveDefaultAdapters(),
    ...(adapters ?? null),
  };

  let queue: string[] = [];
  let upgradeFn: ((batch: string[]) => void) | null = null;
  let batchSize = DEFAULT_UPGRADE_BATCH_SIZE;
  let pendingRafId: number | null = null;
  let running = false;

  const cancelPendingRaf = () => {
    if (pendingRafId === null) return;
    resolvedAdapters.cancelRaf(pendingRafId);
    pendingRafId = null;
  };

  const stopRun = () => {
    cancelPendingRaf();
    running = false;
  };

  const processBatch = () => {
    pendingRafId = null;
    if (!running || upgradeFn === null) {
      stopRun();
      return;
    }

    if (queue.length === 0) {
      // 队列耗尽，自停（spec「全部占位壳升级在有限帧内完成」）。
      stopRun();
      return;
    }

    const take = Math.min(batchSize, queue.length);
    const batch = queue.slice(0, take);
    queue = queue.slice(take);

    upgradeFn(batch);

    if (queue.length === 0) {
      // 本帧处理完最后一批，自停。
      stopRun();
      return;
    }

    // 还有剩余，调度下一帧。
    pendingRafId = resolvedAdapters.raf(processBatch);
  };

  return {
    start: (nodeIds, fn, options) => {
      // 运行中再次 start：取消旧调度，以新队列重新开始（spec「收敛期中断」语义，
      // 已升级的是完整态无需回退，旧队列丢弃由调用方重新传新队列）。
      cancelPendingRaf();

      upgradeFn = fn;
      batchSize =
        options !== undefined && options.batchSize !== undefined && options.batchSize > 0
          ? options.batchSize
          : DEFAULT_UPGRADE_BATCH_SIZE;
      // 复制入参，避免修改外部数组。
      queue = nodeIds.slice();

      if (queue.length === 0) {
        // 空队列立即完成，不调度 rAF（spec「交互结束时无占位壳待升级」直接回稳态）。
        running = false;
        return;
      }

      running = true;
      pendingRafId = resolvedAdapters.raf(processBatch);
    },

    cancel: () => {
      // 只停止后续升级，不回退已完成升级（已升级的是完整态，无需回退）。
      // 队列状态丢弃——调用方下次 start 时传新队列。
      stopRun();
    },

    isRunning: () => running,
  };
}
