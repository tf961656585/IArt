import { describe, expect, it } from 'vitest';

import {
  createPlaceholderUpgradeScheduler,
  DEFAULT_UPGRADE_BATCH_SIZE,
} from '../placeholderUpgradeScheduler';

/**
 * 占位壳分帧升级调度器单测（spec：画布交互期渲染降级契约.md「moveEnd 后分帧升级契约」）。
 *
 * 覆盖：批量分帧、队列耗尽自停、cancel 中断、重复 start（取消旧调度以新队列开始）、空队列。
 * 使用可控的 mock raf（手动推进回调），不依赖真实 rAF 时序。
 */
describe('placeholderUpgradeScheduler', () => {
  /**
   * mock raf 适配器：把 raf 回调存到数组，测试手动调 driveNextFrame() 推进，
   * 完全控制时序，断言每帧的行为。
   */
  const createControllableAdapters = () => {
    const frames: Array<() => void> = [];
    const raf = (cb: () => void): number => {
      const id = frames.length;
      frames.push(cb);
      return id;
    };
    const cancelRaf = (id: number): void => {
      // 标记为已取消（保留索引位置，避免 id 错位），driveNextFrame 跳过。
      if (id >= 0 && id < frames.length) {
        frames[id] = noop;
      }
    };
    const noop = () => {};
    const driveNextFrame = (): void => {
      // 跳过被 cancel 标记为 noop 的帧，执行下一个真实回调。
      while (frames.length > 0) {
        const cb = frames.shift();
        if (cb !== undefined && cb !== noop) {
          cb();
          return;
        }
      }
    };
    const pendingFrameCount = (): number =>
      frames.filter((f) => f !== noop).length;
    return { raf, cancelRaf, driveNextFrame, pendingFrameCount };
  };

  describe('批量分帧', () => {
    it('按 batchSize 分帧调用 upgradeFn，头部 FIFO 升级顺序', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const upgradedBatches: string[][] = [];

      // 20 个节点，batchSize=8：第一帧 8、第二帧 8、第三帧 4。
      const ids = Array.from({ length: 20 }, (_, i) => `node-${i}`);
      scheduler.start(
        ids,
        (batch) => upgradedBatches.push(batch),
        { batchSize: 8 },
      );

      expect(scheduler.isRunning()).toBe(true);

      adapters.driveNextFrame();
      expect(upgradedBatches).toEqual([['node-0', 'node-1', 'node-2', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7']]);

      adapters.driveNextFrame();
      const secondBatch = upgradedBatches[1];
      if (secondBatch === undefined) {
        expect.fail('expected second batch to be invoked');
        return;
      }
      expect(secondBatch).toEqual(['node-8', 'node-9', 'node-10', 'node-11', 'node-12', 'node-13', 'node-14', 'node-15']);

      adapters.driveNextFrame();
      const thirdBatch = upgradedBatches[2];
      if (thirdBatch === undefined) {
        expect.fail('expected third batch to be invoked');
        return;
      }
      expect(thirdBatch).toEqual(['node-16', 'node-17', 'node-18', 'node-19']);
      expect(upgradedBatches.length).toBe(3);
    });

    it('不修改入参数组（防御外部数组被改）', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const ids = ['a', 'b', 'c'];
      const idsCopy = [...ids];

      scheduler.start(ids, () => {}, { batchSize: 1 });
      adapters.driveNextFrame();
      adapters.driveNextFrame();
      adapters.driveNextFrame();

      expect(ids).toEqual(idsCopy);
    });

    it('使用默认 batchSize（DEFAULT_UPGRADE_BATCH_SIZE）当 options 未传', () => {
      expect(DEFAULT_UPGRADE_BATCH_SIZE).toBeGreaterThan(0);
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const upgradedBatches: string[][] = [];

      const ids = Array.from({ length: DEFAULT_UPGRADE_BATCH_SIZE + 1 }, (_, i) => `n-${i}`);
      scheduler.start(ids, (b) => upgradedBatches.push(b), undefined);

      adapters.driveNextFrame();
      // 第一帧用默认 batchSize 取走 DEFAULT_UPGRADE_BATCH_SIZE 个，剩 1 个。
      const firstBatch = upgradedBatches[0];
      if (firstBatch === undefined) {
        expect.fail('expected first batch to be invoked');
        return;
      }
      expect(firstBatch.length).toBe(DEFAULT_UPGRADE_BATCH_SIZE);

      adapters.driveNextFrame();
      const tail = upgradedBatches[1];
      if (tail === undefined) {
        expect.fail('expected tail batch to be invoked');
        return;
      }
      expect(tail).toEqual([`n-${DEFAULT_UPGRADE_BATCH_SIZE}`]);
    });

    it('batchSize 小于队列长度时分多帧处理', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const upgraded: string[] = [];

      scheduler.start(['a', 'b', 'c', 'd', 'e'], (batch) => upgraded.push(...batch), { batchSize: 2 });

      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b']);

      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b', 'c', 'd']);

      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('队列耗尽自停', () => {
    it('全部处理完后 isRunning 返回 false，无多余 rAF 调度', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      let callCount = 0;

      scheduler.start(['a', 'b'], () => { callCount += 1; }, { batchSize: 2 });

      adapters.driveNextFrame();
      expect(callCount).toBe(1);
      expect(scheduler.isRunning()).toBe(false);
      expect(adapters.pendingFrameCount()).toBe(0);
    });

    it('耗尽后再 driveNextFrame 不再触发 upgradeFn', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      let callCount = 0;

      scheduler.start(['a'], () => { callCount += 1; }, { batchSize: 1 });
      adapters.driveNextFrame();
      expect(callCount).toBe(1);

      // 没有新帧可驱动（pendingFrameCount=0），模拟无操作。
      expect(adapters.pendingFrameCount()).toBe(0);
      expect(callCount).toBe(1);
    });
  });

  describe('cancel 中断', () => {
    it('处理到一半 cancel，upgradeFn 不再被调用，isRunning 返回 false', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const upgraded: string[] = [];

      // 6 个节点，batchSize=2，共 3 帧。
      scheduler.start(['a', 'b', 'c', 'd', 'e', 'f'], (batch) => upgraded.push(...batch), { batchSize: 2 });

      // 推进 1 帧（升级 a, b）。
      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b']);
      expect(scheduler.isRunning()).toBe(true);

      // 中断。
      scheduler.cancel();
      expect(scheduler.isRunning()).toBe(false);
      expect(adapters.pendingFrameCount()).toBe(0);

      // 不再推进（pending 已清空），upgradeFn 不再被调用。
      expect(upgraded).toEqual(['a', 'b']);
    });

    it('未运行时 cancel 是无操作', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);

      expect(() => scheduler.cancel()).not.toThrow();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('重复 start', () => {
    it('已在运行时再调 start，取消旧调度并以新队列开始', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const upgraded: string[] = [];

      // 启动第一批（6 个，batchSize=2）。
      scheduler.start(['a', 'b', 'c', 'd', 'e', 'f'], (batch) => upgraded.push(...batch), { batchSize: 2 });
      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b']);
      expect(scheduler.isRunning()).toBe(true);

      // 第二批 start：只含 3 个新节点，旧队列剩余 c/d/e/f 应被丢弃。
      scheduler.start(['x', 'y', 'z'], (batch) => upgraded.push(...batch), { batchSize: 2 });
      expect(scheduler.isRunning()).toBe(true);

      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b', 'x', 'y']);

      adapters.driveNextFrame();
      expect(upgraded).toEqual(['a', 'b', 'x', 'y', 'z']);
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('空队列', () => {
    it('start([]) 立即完成，isRunning 返回 false，不调度 rAF', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      let callCount = 0;

      scheduler.start([], () => { callCount += 1; }, { batchSize: 8 });

      expect(scheduler.isRunning()).toBe(false);
      expect(adapters.pendingFrameCount()).toBe(0);
      expect(callCount).toBe(0);
    });
  });
});
