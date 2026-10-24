// @spec: CLI-055, CLI-058, CLI-059, CLI-061
//
// CLI 画布写命令 · 批次 1a 测试：nodes move 绝对坐标族、容器渲染框坐标口径、
// layout 列数/间距回显与顺序报告（content_reordered / order_changes）、summary.cascaded。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '../../store/canvasStore';
import { executeCliProxyCommand } from '../cliProxyReceiver';
import { clearCliOperations } from '../cliOperationRegistry';
import {
  addGroupNode,
  addTextInputNode,
  createTestGraph,
  derivedFrameOf,
  historyLength,
  parseResponse,
  positionOf,
  resetStore,
} from './cliProxyReceiver.writeOpsFixtures';

describe('CLI 画布写命令 · 批次 1a', () => {
  beforeEach(async () => {
    clearCliOperations();
    resetStore();
    await useCanvasStore.getState().loadNodeGraph(createTestGraph());
    useCanvasStore.getState().commitDeferredHistoryBaseline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

// @spec: CLI-059, CLI-061
  describe('canvas.nodes.move 绝对坐标族（--positions）', () => {
    it('每个节点各自落到绝对坐标：一次批量写入 = 一条撤销记录', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 50, 50);
      const historyBefore = historyLength();

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs1',
          positions: [
            { node_id: 'n1', x: 300, y: 400 },
            { node_id: 'n2', x: -20, y: 70 },
          ],
        }),
      );
      if (response.command !== 'canvas.nodes.move' || 'error' in response) {
        throw new Error('expected nodes.move success response');
      }
      expect(positionOf('n1')).toEqual({ x: 300, y: 400 });
      expect(positionOf('n2')).toEqual({ x: -20, y: 70 });
      expect(response.positions.n1).toEqual({ x: 300, y: 400 });
      expect(response.positions.n2).toEqual({ x: -20, y: 70 });
      expect(new Set(response.moved_node_ids)).toEqual(new Set(['n1', 'n2']));
      expect(response.summary.inspected).toBe(2);
      expect(response.summary.moved).toBe(2);
      expect(response.summary.cascaded).toBe(0);
      expect(historyLength()).toBe(historyBefore + 1);
    });

    it('与相对族混用、两族都没给、重复 node_id、容器目标 → 分别 command_rejected 且零改动', async () => {
      addTextInputNode('n1', 0, 0);
      addGroupNode('g0');
      const historyBefore = historyLength();

      const mixed = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs2',
          nodes: ['n1'],
          dx: 1,
          dy: 1,
          positions: [{ node_id: 'n1', x: 5, y: 5 }],
        }),
      );
      if (!('error' in mixed)) throw new Error('expected error response');
      expect(mixed.error.code).toBe('command_rejected');

      const none = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs3',
        }),
      );
      if (!('error' in none)) throw new Error('expected error response');
      expect(none.error.code).toBe('command_rejected');

      const duplicate = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs4',
          positions: [
            { node_id: 'n1', x: 5, y: 5 },
            { node_id: 'n1', x: 9, y: 9 },
          ],
        }),
      );
      if (!('error' in duplicate)) throw new Error('expected error response');
      expect(duplicate.error.code).toBe('command_rejected');

      const containerTarget = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs5',
          positions: [{ node_id: 'g0', x: 5, y: 5 }],
        }),
      );
      if (!('error' in containerTarget)) throw new Error('expected error response');
      expect(containerTarget.error.code).toBe('command_rejected');
      expect(containerTarget.error.message).toContain('canvas group move');

      // 全部拒绝路径零写入、零历史
      expect(positionOf('n1')).toEqual({ x: 0, y: 0 });
      expect(historyLength()).toBe(historyBefore);
    });

    it('未知节点 → node_not_found，整批零改动', async () => {
      addTextInputNode('n1', 0, 0);
      const historyBefore = historyLength();
      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs6',
          positions: [
            { node_id: 'n1', x: 10, y: 10 },
            { node_id: 'ghost', x: 20, y: 20 },
          ],
        }),
      );
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('node_not_found');
      expect(positionOf('n1')).toEqual({ x: 0, y: 0 });
      expect(historyLength()).toBe(historyBefore);
    });

    it('dry-run：返回计划绝对坐标、零写入、零历史、operation_id 为 null', async () => {
      addTextInputNode('n1', 0, 0);
      const historyBefore = historyLength();

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-abs7',
          positions: [{ node_id: 'n1', x: 123, y: 456 }],
          dry_run: true,
        }),
      );
      if (response.command !== 'canvas.nodes.move' || 'error' in response) {
        throw new Error('expected nodes.move success response');
      }
      expect(response.dry_run).toBe(true);
      expect(response.operation_id).toBeNull();
      expect(response.positions.n1).toEqual({ x: 123, y: 456 });
      expect(response.summary.moved).toBe(1);
      expect(positionOf('n1')).toEqual({ x: 0, y: 0 });
      expect(historyLength()).toBe(historyBefore);
    });
  });

  // @spec: CLI-058
  describe('canvas.layout 列数/间距回显与顺序报告', () => {
    it('scope=all 缺省回显 columns=1 / gap=120；显式值原样回显；content_reordered 字段齐全', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 500, 300);

      const defaults = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-lay1',
          scope: 'all',
        }),
      );
      if (defaults.command !== 'canvas.layout' || 'error' in defaults) {
        throw new Error('expected layout success response');
      }
      expect(defaults.columns).toBe(1);
      expect(defaults.gap).toBe(120);
      expect(typeof defaults.content_reordered).toBe('boolean');
      expect(Array.isArray(defaults.order_changes)).toBe(true);

      const explicit = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-lay2',
          scope: 'all',
          columns: 2,
          gap: 40,
          order_mode: 'insertion',
        }),
      );
      if (explicit.command !== 'canvas.layout' || 'error' in explicit) {
        throw new Error('expected layout success response');
      }
      expect(explicit.columns).toBe(2);
      expect(explicit.gap).toBe(40);
    });

    it('scope=group 回显 columns=1 / gap=120；order_mode created 按 insertion 处理不报错', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('m2', 400, 0, 'g0');

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-lay3',
          scope: { group: 'g0' },
          order_mode: 'created',
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) {
        throw new Error('expected layout success response');
      }
      expect(response.columns).toBe(1);
      expect(response.gap).toBe(120);
    });

    it('scope=containers 非 pack 携带 gap / order_mode → command_rejected，画布零改动', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      const historyBefore = historyLength();

      for (const extra of [{ gap: 40 }, { order_mode: 'insertion' as const }]) {
        const rejected = parseResponse(
          await executeCliProxyCommand({
            command: 'canvas.layout',
            request_id: 'req-lay4',
            scope: 'containers',
            ...extra,
          }),
        );
        if (!('error' in rejected)) throw new Error('expected error response');
        expect(rejected.error.code).toBe('command_rejected');
      }
      expect(historyLength()).toBe(historyBefore);
    });
  });

  // @spec: CLI-055, CLI-058, CLI-061
  describe('pack：dry-run 容器坐标为派生渲染框，content_reordered / order_changes', () => {
    it('dry-run 的容器计划坐标 = 真实执行后的派生渲染框（不是存储 position + delta）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1');
      addTextInputNode('m2', 0, 0, 'g1');
      const memberBefore = positionOf('m1');
      const historyBefore = historyLength();

      const planned = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pkd1',
          scope: 'containers',
          pack: true,
          dry_run: true,
        }),
      );
      if (planned.command !== 'canvas.layout' || 'error' in planned) {
        throw new Error('expected layout success response');
      }
      // dry-run 零写入：成员仍在原位、无历史
      expect(positionOf('m1')).toEqual(memberBefore);
      expect(historyLength()).toBe(historyBefore);

      const executed = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pkd2',
          scope: 'containers',
          pack: true,
        }),
      );
      if (executed.command !== 'canvas.layout' || 'error' in executed) {
        throw new Error('expected layout success response');
      }
      // 计划容器坐标 = 执行后派生框左上角（+0 归一 -0，pack 对齐可能产出 -0）
      const normalize = (position: { x: number; y: number } | undefined) =>
        position === undefined ? undefined : { x: position.x + 0, y: position.y + 0 };
      expect(normalize(planned.positions['g0'])).toEqual(normalize(derivedFrameOf('g0')));
      expect(normalize(planned.positions['g1'])).toEqual(normalize(derivedFrameOf('g1')));
      expect(normalize(planned.positions['g0'])).toEqual(normalize(executed.positions['g0']));
      // 成员计划位置 = 执行后成员存储位置
      expect(planned.positions['m1']).toEqual(positionOf('m1'));
      // 真实执行的容器位置同样是派生框
      expect(executed.positions['g0']).toEqual(derivedFrameOf('g0'));
    });

    it('无显式 order 时视觉序未被洗牌（content_reordered=false）；显式 order 改变顺序时报告明细', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1');
      addTextInputNode('m2', 0, 500, 'g1');

      const natural = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-ord1',
          scope: 'containers',
          pack: true,
          dry_run: true,
        }),
      );
      if (natural.command !== 'canvas.layout' || 'error' in natural) {
        throw new Error('expected layout success response');
      }
      expect(natural.content_reordered).toBe(false);
      expect(natural.order_changes).toEqual([]);

      const reordered = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-ord2',
          scope: 'containers',
          pack: true,
          dry_run: true,
          order: ['g1'],
        }),
      );
      if (reordered.command !== 'canvas.layout' || 'error' in reordered) {
        throw new Error('expected layout success response');
      }
      expect(reordered.content_reordered).toBe(true);
      expect(reordered.order_changes).toEqual([
        { node_id: 'g1', from_slot: 1, to_slot: 0 },
        { node_id: 'g0', from_slot: 0, to_slot: 1 },
      ]);
    });

    it('pack 的 summary 携带 cascaded（容器口径下恒为 0）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-ord3',
          scope: 'containers',
          pack: true,
          dry_run: true,
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) {
        throw new Error('expected layout success response');
      }
      expect(response.summary.cascaded).toBe(0);
    });
  });
});
