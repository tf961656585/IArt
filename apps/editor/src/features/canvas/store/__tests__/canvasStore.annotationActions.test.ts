import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { CanvasAnnotation } from '../../types';
import {
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';

const createTestGraph = () =>
  createNodeGraph({
    name: 'annotation-actions-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.history = [];
    state.historyIndex = -1;
    state.deferredHistoryBaseline = null;
  });
};

const seedGraphWithAnnotation = (annotation: CanvasAnnotation): CanvasAnnotation => {
  const graph = createTestGraph();
  graph.nodes = [createTextInputNodeFixture({ id: 'n1' })];
  graph.annotations = [annotation];
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.history = [];
    state.historyIndex = -1;
  });
  // 落一次基线 snapshot 历史，使后续 action 落新条目并可 undo 回基线
  useCanvasStore.getState().saveToHistory();
  return annotation;
};

describe('canvasStore.annotationActions', () => {
  beforeEach(() => resetStore());

  describe('updateAnnotation - 历史入栈行为', () => {
    it('实际变化时入 1 条历史', () => {
      const ann = seedGraphWithAnnotation({
        id: 'ann-1',
        content: '原内容',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 60 },
        binding: { type: 'free' },
        style: { color: '#fef3c7', fontSize: 14 },
      });
      const baselineHistoryLen = useCanvasStore.getState().history.length;

      useCanvasStore.getState().updateAnnotation(ann.id, { content: '新内容' });

      const after = useCanvasStore.getState();
      expect(after.history.length).toBe(baselineHistoryLen + 1);
      expect(after.nodeGraph?.annotations?.[0]?.content).toBe('新内容');
    });

    it('无实际变化时不入历史', () => {
      const ann = seedGraphWithAnnotation({
        id: 'ann-1',
        content: '原内容',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 60 },
        binding: { type: 'free' },
        style: { color: '#fef3c7', fontSize: 14 },
      });
      const baselineHistoryLen = useCanvasStore.getState().history.length;

      // 用相同 content 调用 update：守卫应跳过历史
      useCanvasStore.getState().updateAnnotation(ann.id, { content: '原内容' });

      const after = useCanvasStore.getState();
      expect(after.history.length).toBe(baselineHistoryLen);
    });

    it('样式修改（颜色/字号）入历史，且可被 undo 还原', () => {
      const ann = seedGraphWithAnnotation({
        id: 'ann-1',
        content: '原内容',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 60 },
        binding: { type: 'free' },
        style: { color: '#fef3c7', fontSize: 14 },
      });

      useCanvasStore.getState().updateAnnotation(ann.id, {
        style: { color: '#ff0000', fontSize: 18 },
      });

      expect(useCanvasStore.getState().nodeGraph?.annotations?.[0]?.style).toEqual({
        color: '#ff0000',
        fontSize: 18,
      });

      useCanvasStore.getState().undo();

      expect(useCanvasStore.getState().nodeGraph?.annotations?.[0]?.style).toEqual({
        color: '#fef3c7',
        fontSize: 14,
      });
    });
  });

  describe('createAnnotation', () => {
    it('创建自由注释并落历史', () => {
      const graph = createTestGraph();
      graph.nodes = [];
      graph.annotations = [];
      useCanvasStore.setState((state) => {
        state.nodeGraph = graph;
        state.history = [];
        state.historyIndex = -1;
      });
      useCanvasStore.getState().saveToHistory();
      const baselineHistoryLen = useCanvasStore.getState().history.length;

      const created = useCanvasStore.getState().createAnnotation({ x: 50, y: 60 });

      expect(created).not.toBeNull();
      expect(created?.binding).toEqual({ type: 'free' });
      expect(created?.position).toEqual({ x: 50, y: 60 });
      expect(useCanvasStore.getState().history.length).toBe(baselineHistoryLen + 1);
      // 创建即编辑（spec：画布注释.md，阶段 4 决策）：editingAnnotationId 被设为新注释 id
      expect(useCanvasStore.getState().editingAnnotationId).toBe(created?.id);
    });
  });

  describe('bindAnnotation - 同对象冲突拒绝', () => {
    it('同节点已被绑定时，新绑定请求返回 false 且不入历史', () => {
      const graph = createTestGraph();
      graph.nodes = [createTextInputNodeFixture({ id: 'n1' })];
      graph.annotations = [
        {
          id: 'ann-existing',
          content: '已绑定',
          position: { x: 0, y: 0 },
          size: { width: 200, height: 60 },
          binding: { type: 'node', nodeId: 'n1' },
          style: { color: '#fef3c7', fontSize: 14 },
        },
        {
          id: 'ann-new',
          content: '尝试绑定',
          position: { x: 100, y: 100 },
          size: { width: 200, height: 60 },
          binding: { type: 'free' },
          style: { color: '#fef3c7', fontSize: 14 },
        },
      ];
      useCanvasStore.setState((state) => {
        state.nodeGraph = graph;
        state.history = [];
        state.historyIndex = -1;
      });
      useCanvasStore.getState().saveToHistory();
      const baselineHistoryLen = useCanvasStore.getState().history.length;

      const ok = useCanvasStore.getState().bindAnnotation('ann-new', {
        type: 'node',
        nodeId: 'n1',
      });

      expect(ok).toBe(false);
      expect(useCanvasStore.getState().history.length).toBe(baselineHistoryLen);
      // ann-new 仍是 free
      const annNew = useCanvasStore
        .getState()
        .nodeGraph?.annotations?.find((a) => a.id === 'ann-new');
      expect(annNew?.binding).toEqual({ type: 'free' });
    });
  });

  describe('unbindAnnotation - 位置固化', () => {
    it('解绑后注释转为 free，且派生位置固化为自由位置', () => {
      const graph = createTestGraph();
      const node = createTextInputNodeFixture({ id: 'n1', position: { x: 100, y: 200 } });
      graph.nodes = [node];
      graph.annotations = [
        {
          id: 'ann-bound',
          content: '绑定中',
          position: { x: 0, y: 0 }, // 原位置；绑定态由派生位置覆盖
          size: { width: 200, height: 60 },
          binding: { type: 'node', nodeId: 'n1' },
          style: { color: '#fef3c7', fontSize: 14 },
        },
      ];
      useCanvasStore.setState((state) => {
        state.nodeGraph = graph;
        state.history = [];
        state.historyIndex = -1;
      });
      useCanvasStore.getState().saveToHistory();

      useCanvasStore.getState().unbindAnnotation('ann-bound');

      const ann = useCanvasStore
        .getState()
        .nodeGraph?.annotations?.find((a) => a.id === 'ann-bound');
      expect(ann?.binding).toEqual({ type: 'free' });
      // 解绑后位置应该被固化（不再是原 {x:0, y:0}），而是派生位置（绑定到 n1，节点底部 + gap）
      expect(ann?.position.y).toBeGreaterThan(200);
    });
  });

  describe('insertAnnotationsBatch - 批量插入', () => {
    it('批量插入多条注释并落 1 条历史', () => {
      const graph = createTestGraph();
      graph.nodes = [];
      graph.annotations = [];
      useCanvasStore.setState((state) => {
        state.nodeGraph = graph;
        state.history = [];
        state.historyIndex = -1;
      });
      useCanvasStore.getState().saveToHistory();
      const baselineHistoryLen = useCanvasStore.getState().history.length;

      const inserted = useCanvasStore.getState().insertAnnotationsBatch(
        [
          {
            id: 'a1',
            content: '批 1',
            position: { x: 10, y: 10 },
            size: { width: 100, height: 50 },
            binding: { type: 'free' },
            style: { color: '#abc', fontSize: 14 },
          },
          {
            id: 'a2',
            content: '批 2',
            position: { x: 20, y: 20 },
            size: { width: 100, height: 50 },
            binding: { type: 'free' },
            style: { color: '#abc', fontSize: 14 },
          },
        ],
        { offset: undefined, saveHistory: true },
      );

      expect(inserted).toHaveLength(2);
      // 每条注释生成新 id（不沿用传入 id），避免与已有注释冲突
      expect(inserted[0]?.id).not.toBe('a1');
      expect(useCanvasStore.getState().history.length).toBe(baselineHistoryLen + 1);
      expect(useCanvasStore.getState().nodeGraph?.annotations).toHaveLength(2);
    });

    it('空数组不入历史', () => {
      const graph = createTestGraph();
      graph.nodes = [];
      graph.annotations = [];
      useCanvasStore.setState((state) => {
        state.nodeGraph = graph;
        state.history = [];
        state.historyIndex = -1;
      });
      useCanvasStore.getState().saveToHistory();
      const baselineHistoryLen = useCanvasStore.getState().history.length;

      const inserted = useCanvasStore.getState().insertAnnotationsBatch([], {
        offset: undefined,
        saveHistory: true,
      });

      expect(inserted).toEqual([]);
      expect(useCanvasStore.getState().history.length).toBe(baselineHistoryLen);
    });
  });
});
