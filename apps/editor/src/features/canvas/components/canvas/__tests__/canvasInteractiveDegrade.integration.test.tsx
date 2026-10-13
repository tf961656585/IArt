import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cast } from '@/lib/utils';

import { useCanvasStore } from '../../../store/canvasStore';
import {
  createPlaceholderUpgradeScheduler,
  DEFAULT_UPGRADE_BATCH_SIZE,
} from '../../../application/placeholderUpgradeScheduler';

/**
 * 画布交互期渲染降级集成测试（spec：画布交互期渲染降级契约.md）。
 *
 * 本测试聚焦"主链编排"——store 占位态 action 与分帧升级调度器的协作，
 * 验证 spec 的核心时序契约：
 * - 交互期挂载占位（markNodeAsPlaceholder）
 * - moveEnd 分帧升级（scheduler.start + markNodesAsFull）
 * - 收敛期中断保持占位态（scheduler.cancel + 未升级节点保持占位）
 * - 稳态无占位壳（markNodesAsFull 清空集合）
 *
 * 不测 controller hook 本身（它创建真实 rAF scheduler 实例，时序控制困难），
 * 而是测 controller 调用的编排原语（store action + scheduler）的端到端协作。
 * controller 的接线（onMoveStart/onMoveEnd 调用这些原语）由类型检查与代码走查保证。
 */

const createControllableAdapters = () => {
  const frames: Array<() => void> = [];
  const raf = (cb: () => void): number => {
    const id = frames.length;
    frames.push(cb);
    return id;
  };
  const cancelRaf = (id: number): void => {
    if (id >= 0 && id < frames.length) {
      frames[id] = noop;
    }
  };
  const noop = () => {};
  const driveNextFrame = (): void => {
    while (frames.length > 0) {
      const cb = frames.shift();
      if (cb !== undefined && cb !== noop) {
        cb();
        return;
      }
    }
  };
  return { raf, cancelRaf, driveNextFrame };
};

describe('画布交互期渲染降级 - 主链编排', () => {
  beforeEach(() => {
    // 重置到初始空态，隔离用例间状态。
    useCanvasStore.getState().clearPlaceholderUpgrade();
    useCanvasStore.setState({ isCanvasInteracting: false });
  });

  afterEach(() => {
    useCanvasStore.getState().clearPlaceholderUpgrade();
    useCanvasStore.setState({ isCanvasInteracting: false });
  });

  describe('交互期挂载占位 → moveEnd 分帧升级', () => {
    it('交互期 markNodeAsPlaceholder 后，集合含该 id；moveEnd 启动 scheduler 分帧升级，最终集合清空', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const store = useCanvasStore.getState;

      // 模拟交互期：3 个节点 mount 时注册占位。
      store().setCanvasInteracting(true);
      store().markNodeAsPlaceholder('node-1');
      store().markNodeAsPlaceholder('node-2');
      store().markNodeAsPlaceholder('node-3');
      expect(store().ui.placeholderNodeIds.size).toBe(3);

      // 模拟 moveEnd：读取占位集合，启动 scheduler。
      store().setCanvasInteracting(false);
      const placeholderIds = store().ui.placeholderNodeIds;
      expect(placeholderIds.size).toBe(3);

      scheduler.start(
        Array.from(placeholderIds),
        (batch) => store().markNodesAsFull(batch),
        { batchSize: DEFAULT_UPGRADE_BATCH_SIZE },
      );

      // 推进帧，逐批升级。
      adapters.driveNextFrame();
      // batchSize 默认 8，3 个节点一帧就升级完。
      expect(store().ui.placeholderNodeIds.size).toBe(0);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('大量节点跨多帧升级，最终全部清空（稳态无占位壳，spec 不变量 6）', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const store = useCanvasStore.getState;

      // 20 个节点，batchSize=8，需要 3 帧（8+8+4）。
      store().setCanvasInteracting(true);
      for (let i = 0; i < 20; i += 1) {
        store().markNodeAsPlaceholder(`node-${i}`);
      }
      expect(store().ui.placeholderNodeIds.size).toBe(20);

      store().setCanvasInteracting(false);
      scheduler.start(
        Array.from(store().ui.placeholderNodeIds),
        (batch) => store().markNodesAsFull(batch),
        { batchSize: 8 },
      );

      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(12);

      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(4);

      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(0);
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('收敛期中断保持占位态（spec 不变量 5）', () => {
    it('升级进行中 cancel，剩余节点保持占位态；再次 moveEnd 升级剩余', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const store = useCanvasStore.getState;

      // 10 个节点，batchSize=3，需要 4 帧（3+3+3+1）。
      store().setCanvasInteracting(true);
      for (let i = 0; i < 10; i += 1) {
        store().markNodeAsPlaceholder(`node-${i}`);
      }

      // 第一次 moveEnd。
      store().setCanvasInteracting(false);
      scheduler.start(
        Array.from(store().ui.placeholderNodeIds),
        (batch) => store().markNodesAsFull(batch),
        { batchSize: 3 },
      );

      // 推进 1 帧（升级 3 个）。
      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(7);

      // 用户再次拖拽（moveStart）：cancel 调度器。
      store().setCanvasInteracting(true);
      scheduler.cancel();
      expect(scheduler.isRunning()).toBe(false);

      // 剩余 7 个保持占位态。
      expect(store().ui.placeholderNodeIds.size).toBe(7);

      // 再次 moveEnd：升级剩余 7 个。
      store().setCanvasInteracting(false);
      scheduler.start(
        Array.from(store().ui.placeholderNodeIds),
        (batch) => store().markNodesAsFull(batch),
        { batchSize: 3 },
      );

      adapters.driveNextFrame();
      adapters.driveNextFrame();
      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(0);
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('空占位集合不启动调度器（spec 验收标准 9 + 稳态判定）', () => {
    it('moveEnd 时占位集合为空，scheduler.start([]) 立即完成不调度 rAF', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const store = useCanvasStore.getState;

      // 无占位节点。
      store().setCanvasInteracting(false);
      expect(store().ui.placeholderNodeIds.size).toBe(0);

      scheduler.start(
        Array.from(store().ui.placeholderNodeIds),
        (batch) => store().markNodesAsFull(batch),
        { batchSize: 8 },
      );

      // 空集合立即完成。
      expect(scheduler.isRunning()).toBe(false);
      expect(store().ui.placeholderNodeIds.size).toBe(0);
    });
  });

  describe('卸载节点 id 残留无害（spec 验收标准 7 代理验证）', () => {
    it('升级进行中节点 id 被外部移除（模拟虚拟化卸载），scheduler 对已移除 id 调 markNodesAsFull 不报错（幂等）', () => {
      const adapters = createControllableAdapters();
      const scheduler = createPlaceholderUpgradeScheduler(adapters);
      const store = useCanvasStore.getState;

      store().setCanvasInteracting(true);
      store().markNodeAsPlaceholder('node-1');
      store().markNodeAsPlaceholder('node-2');
      store().markNodeAsPlaceholder('node-3');

      store().setCanvasInteracting(false);
      // 启动升级，但传给 scheduler 的 id 列表里混入一个已不在集合的 id（模拟卸载残留）。
      scheduler.start(
        ['node-1', 'node-2', 'node-3', 'node-unmounted'],
        (batch) => store().markNodesAsFull(batch),
        { batchSize: 2 },
      );

      // 推进帧，markNodesAsFull 对 'node-unmounted'（不在集合）幂等无副作用。
      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(1); // 剩 node-3

      adapters.driveNextFrame();
      expect(store().ui.placeholderNodeIds.size).toBe(0);
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('selectIsPlaceholderNode 单节点作用域订阅', () => {
    it('节点从占位态升级为完整态后，selector 返回 false（触发组件重渲染）', async () => {
      const { selectIsPlaceholderNode } = await import('../../../store/selectors.base');
      const store = useCanvasStore.getState;

      store().markNodeAsPlaceholder('node-A');
      expect(selectIsPlaceholderNode('node-A')(store())).toBe(true);

      store().markNodesAsFull(['node-A']);
      expect(selectIsPlaceholderNode('node-A')(store())).toBe(false);
    });
  });

  describe('clearPlaceholderUpgrade 清空（收敛期全部完成或中断时调用）', () => {
    it('clearPlaceholderUpgrade 清空整个占位集合，无残留', () => {
      const store = useCanvasStore.getState;
      store().markNodeAsPlaceholder('node-1');
      store().markNodeAsPlaceholder('node-2');
      store().markNodeAsPlaceholder('node-3');

      store().clearPlaceholderUpgrade();
      expect(store().ui.placeholderNodeIds.size).toBe(0);
    });

    it('clearPlaceholderUpgrade 后 Set 引用变化（订阅者收到通知）', () => {
      const store = useCanvasStore.getState;
      store().markNodeAsPlaceholder('node-1');
      const before = store().ui.placeholderNodeIds;

      store().clearPlaceholderUpgrade();
      const after = store().ui.placeholderNodeIds;
      expect(after).not.toBe(before);
    });
  });
});

// 避免 cast 未使用警告（保留以备测试扩展时使用）。
void cast;
