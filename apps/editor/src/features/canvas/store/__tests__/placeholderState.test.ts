import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '../canvasStore';
import { selectIsPlaceholderNode } from '../selectors.base';

/**
 * 占位壳态生命周期单测（spec：画布交互期渲染降级契约.md「占位壳契约」、
 * 画布启动性能与Layout-Model架构.md「启动期占位壳契约」）。
 *
 * 覆盖 markNodeAsPlaceholder / markNodesAsPlaceholder / markNodesAsFull / clearPlaceholderUpgrade
 * 四个 action 的：
 * - 增删正确性
 * - 幂等性（重复操作无副作用）
 * - Set 引用不可变（每次写入产生新 Set，保证订阅者收到通知）
 * 以及 selectIsPlaceholderNode 的单节点作用域查询。
 */
describe('placeholder shell state actions', () => {
  beforeEach(() => {
    // 重置到初始空态，隔离用例间状态。
    useCanvasStore.getState().clearPlaceholderUpgrade();
  });

  describe('markNodeAsPlaceholder', () => {
    it('把节点加入占位集合，selectIsPlaceholderNode 返回 true', () => {
      const { markNodeAsPlaceholder } = useCanvasStore.getState();
      const state = useCanvasStore.getState;

      markNodeAsPlaceholder('node-1');

      expect(selectIsPlaceholderNode('node-1')(state())).toBe(true);
      expect(selectIsPlaceholderNode('node-2')(state())).toBe(false);
    });

    it('幂等：重复标记同一节点不产生副作用', () => {
      const { markNodeAsPlaceholder } = useCanvasStore.getState();

      markNodeAsPlaceholder('node-1');
      markNodeAsPlaceholder('node-1');
      markNodeAsPlaceholder('node-1');

      const ids = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(ids.size).toBe(1);
      expect(ids.has('node-1')).toBe(true);
    });

    it('空字符串 nodeId 不被加入集合', () => {
      const { markNodeAsPlaceholder } = useCanvasStore.getState();

      markNodeAsPlaceholder('');

      expect(useCanvasStore.getState().ui.placeholderNodeIds.size).toBe(0);
    });
  });

  describe('markNodesAsPlaceholder', () => {
    /**
     * 启动期占位壳契约（spec：画布启动性能与Layout-Model架构.md「启动期占位壳契约」）。
     * loadNodeGraph 完成后批量灌入全部新加载节点 id，让 NodeCanvas 在 waiting-interactive
     * 阶段以占位壳态轻量挂载。本组用例覆盖批量 action 的增删正确性、幂等性、空值过滤、
     * Set 引用不可变。
     */
    it('批量把节点加入占位集合', () => {
      const { markNodesAsPlaceholder } = useCanvasStore.getState();
      const state = useCanvasStore.getState;

      markNodesAsPlaceholder(['node-1', 'node-2', 'node-3']);

      expect(selectIsPlaceholderNode('node-1')(state())).toBe(true);
      expect(selectIsPlaceholderNode('node-2')(state())).toBe(true);
      expect(selectIsPlaceholderNode('node-3')(state())).toBe(true);
      expect(selectIsPlaceholderNode('node-4')(state())).toBe(false);
    });

    it('幂等：重复批量标记不产生副作用', () => {
      const { markNodesAsPlaceholder } = useCanvasStore.getState();

      markNodesAsPlaceholder(['node-1', 'node-2']);
      markNodesAsPlaceholder(['node-1', 'node-2']);
      markNodesAsPlaceholder(['node-2', 'node-3']);

      const ids = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(ids.size).toBe(3);
      expect(ids.has('node-1')).toBe(true);
      expect(ids.has('node-2')).toBe(true);
      expect(ids.has('node-3')).toBe(true);
    });

    it('空数组无操作', () => {
      const { markNodeAsPlaceholder, markNodesAsPlaceholder } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');

      markNodesAsPlaceholder([]);

      expect(useCanvasStore.getState().ui.placeholderNodeIds.size).toBe(1);
    });

    it('过滤空字符串元素', () => {
      const { markNodesAsPlaceholder } = useCanvasStore.getState();

      // 数组中夹杂空字符串（防御性：上游可能未过滤）。
      // undefined 元素由 TS 类型 `string[]` 在编译期挡住，运行时不会传入，故不在此测试。
      markNodesAsPlaceholder(['node-1', '', 'node-2', '']);

      const ids = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(ids.size).toBe(2);
      expect(ids.has('node-1')).toBe(true);
      expect(ids.has('node-2')).toBe(true);
      expect(ids.has('')).toBe(false);
    });
  });

  describe('markNodesAsFull', () => {
    it('批量从占位集合移除节点', () => {
      const { markNodeAsPlaceholder, markNodesAsFull } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');
      markNodeAsPlaceholder('node-2');
      markNodeAsPlaceholder('node-3');

      markNodesAsFull(['node-1', 'node-3']);

      const ids = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(ids.size).toBe(1);
      expect(ids.has('node-2')).toBe(true);
    });

    it('幂等：移除不在集合中的 id 无副作用', () => {
      const { markNodeAsPlaceholder, markNodesAsFull } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');

      markNodesAsFull(['node-999', 'node-1', 'node-1000']);

      const ids = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(ids.size).toBe(0);
    });

    it('空数组无操作', () => {
      const { markNodeAsPlaceholder, markNodesAsFull } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');

      markNodesAsFull([]);

      expect(useCanvasStore.getState().ui.placeholderNodeIds.size).toBe(1);
    });
  });

  describe('clearPlaceholderUpgrade', () => {
    it('清空整个占位集合', () => {
      const { markNodeAsPlaceholder, clearPlaceholderUpgrade } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');
      markNodeAsPlaceholder('node-2');
      markNodeAsPlaceholder('node-3');

      clearPlaceholderUpgrade();

      expect(useCanvasStore.getState().ui.placeholderNodeIds.size).toBe(0);
    });

    it('对空集合幂等', () => {
      const { clearPlaceholderUpgrade } = useCanvasStore.getState();

      clearPlaceholderUpgrade();
      clearPlaceholderUpgrade();

      expect(useCanvasStore.getState().ui.placeholderNodeIds.size).toBe(0);
    });
  });

  describe('Set 引用不可变性', () => {
    /**
     * immer 会为 draft 中的 Set 写入产生新引用，保证 zustand 订阅者收到更新。
     * 此用例验证占位态写入确实让 Set 引用变化——若错误地就地复用引用，订阅者不会收到通知，
     * 占位壳渲染切换会失效（这是隐性 bug 的常见来源）。
     */
    it('markNodeAsPlaceholder 后 Set 引用变化', () => {
      const { markNodeAsPlaceholder } = useCanvasStore.getState();
      const before = useCanvasStore.getState().ui.placeholderNodeIds;

      markNodeAsPlaceholder('node-1');

      const after = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(after).not.toBe(before);
    });

    it('markNodesAsPlaceholder 后 Set 引用变化', () => {
      const { markNodesAsPlaceholder } = useCanvasStore.getState();
      const before = useCanvasStore.getState().ui.placeholderNodeIds;

      markNodesAsPlaceholder(['node-1', 'node-2']);

      const after = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(after).not.toBe(before);
    });

    it('markNodesAsFull 后 Set 引用变化', () => {
      const { markNodeAsPlaceholder, markNodesAsFull } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');
      const before = useCanvasStore.getState().ui.placeholderNodeIds;

      markNodesAsFull(['node-1']);

      const after = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(after).not.toBe(before);
    });

    it('clearPlaceholderUpgrade 后 Set 引用变化', () => {
      const { markNodeAsPlaceholder, clearPlaceholderUpgrade } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-1');
      const before = useCanvasStore.getState().ui.placeholderNodeIds;

      clearPlaceholderUpgrade();

      const after = useCanvasStore.getState().ui.placeholderNodeIds;
      expect(after).not.toBe(before);
    });
  });

  describe('selectIsPlaceholderNode', () => {
    it('空 nodeId 返回 false', () => {
      expect(selectIsPlaceholderNode('')(useCanvasStore.getState())).toBe(false);
    });

    it('单节点作用域：只反映查询的节点', () => {
      const { markNodeAsPlaceholder } = useCanvasStore.getState();
      markNodeAsPlaceholder('node-A');
      markNodeAsPlaceholder('node-B');
      const state = useCanvasStore.getState;

      expect(selectIsPlaceholderNode('node-A')(state())).toBe(true);
      expect(selectIsPlaceholderNode('node-B')(state())).toBe(true);
      expect(selectIsPlaceholderNode('node-C')(state())).toBe(false);
    });
  });
});
