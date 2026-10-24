// @spec: CLI-052, CLI-053, CLI-054
//
// CLI 代理执行通道 · 画布写原语（批次二）测试：
// canvas.group.move / canvas.nodes.move / canvas.undo 与 --dry-run / 执行报告（summary）。
//
// 三条核心不变式各自的测试证据：
// 1. 一条撤销记录：每次成功写命令后 history 长度恰好 +1（不产生逐节点多条记录）；
// 2. dry-run 零副作用：节点位置、history 长度、operation_id（null）三处断言；
// 3. summary 可区分空转：containers 作用域无相交时 inspected>0 且 moved=0/unchanged=inspected。
//
// 种床沿 cliProxyReceiver.canvasOps.test.ts 既有惯例：真实 store + setState 种节点。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProxyCommand } from '@iart/contracts';
import { useCanvasStore } from '../../store/canvasStore';
import { executeCliProxyCommand } from '../cliProxyReceiver';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '../../utils/nodeOccupancy';
import { rectsIntersect } from '../../utils/taskNodePlacement';
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

describe('CLI 代理执行通道 · 画布写原语（批次二）', () => {
  beforeEach(async () => {
    clearCliOperations();
    resetStore();
    await useCanvasStore.getState().loadNodeGraph(createTestGraph());
    // 显式提交 loadNodeGraph 的延迟基线：否则首次写历史会同时提交「基线 + 条目」（+2），
    // 断言的是「一条写命令 = 一条记录」本身，而不是基线提交的时机。
    useCanvasStore.getState().commitDeferredHistoryBaseline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // @spec: CLI-052
  describe('canvas.group.move', () => {
    it('相对位移：成员与容器按同一 delta 移动，一次批量写入 = 一条撤销记录', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 100, 100, 'g0');
      addTextInputNode('m2', 300, 200, 'g0');
      const frameBefore = derivedFrameOf('g0');
      const historyBefore = historyLength();

      const command: CliProxyCommand = {
        command: 'canvas.group.move',
        request_id: 'req-gm1',
        group: 'g0',
        dx: 40,
        dy: -10,
      };
      const response = parseResponse(await executeCliProxyCommand(command));

      if (response.command !== 'canvas.group.move' || 'error' in response) throw new Error('expected group.move success response');
      expect(response.group_node_id).toBe('g0');
      expect(response.dry_run).toBe(false);
      expect(response.operation_id).not.toBeNull();
      // 成员位移精确等于 delta
      expect(positionOf('m1')).toEqual({ x: 140, y: 90 });
      expect(positionOf('m2')).toEqual({ x: 340, y: 190 });
      // 容器（展开态）position 由成员包围盒重派生，同样平移 delta
      // 容器渲染框 = 整理前派生框 + 同一 delta（容器存储 position 由成员包围盒重派生）
      const containerAfter = positionOf('g0');
      expect(derivedFrameOf('g0')).toEqual({
        x: (frameBefore?.x ?? 0) + 40,
        y: (frameBefore?.y ?? 0) - 10,
      });
      // 响应 positions 覆盖成员 + 容器
      expect(response.positions['m1']).toEqual({ x: 140, y: 90 });
      expect(response.positions['g0']).toEqual(containerAfter);
      // 成员 + 容器全部纳入 moved
      expect(new Set(response.moved_node_ids)).toEqual(new Set(['g0', 'm1', 'm2']));
      expect(response.summary.inspected).toBe(3);
      expect(response.summary.moved).toBe(3);
      expect(response.summary.unchanged).toBe(0);
      expect(response.summary.skipped).toEqual([]);
      // 一次写命令 = 一条撤销记录（不是逐节点多条）
      expect(historyLength()).toBe(historyBefore + 1);
    });

    it('绝对落点：目标渲染框左上角落在 (x, y)，只给一个轴时另一轴保持', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 100, 100, 'g0');
      const frameBefore = derivedFrameOf('g0');

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.move',
          request_id: 'req-gm2',
          group: 'g0',
          x: 1000,
        }),
      );
      if (response.command !== 'canvas.group.move' || 'error' in response) throw new Error('expected group.move success response');
      // 只有 X 轴落到目标，Y 轴保持
      expect(derivedFrameOf('g0')?.x).toBe(1000);
      expect(derivedFrameOf('g0')?.y).toBe(frameBefore?.y);
      expect(positionOf('m1')?.y).toBe(100);
    });

    it('空容器：直接移动容器自身 position，不展开成员', async () => {
      addGroupNode('g0', 50, 60);
      const historyBefore = historyLength();
      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.move',
          request_id: 'req-gm3',
          group: 'g0',
          dx: 5,
          dy: 7,
        }),
      );
      if (response.command !== 'canvas.group.move' || 'error' in response) throw new Error('expected group.move success response');
      expect(positionOf('g0')).toEqual({ x: 55, y: 67 });
      expect(response.moved_node_ids).toEqual(['g0']);
      expect(response.summary.inspected).toBe(1);
      expect(historyLength()).toBe(historyBefore + 1);
    });

    it('目标不存在 → group_not_found；目标不是容器 → command_rejected；两族同时出现 → command_rejected', async () => {
      addTextInputNode('plain', 0, 0);

      const missing = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.move',
          request_id: 'req-gm4',
          group: 'ghost',
          dx: 1,
        }),
      );
      if (!('error' in missing)) throw new Error('expected error response');
      expect(missing.error.code).toBe('group_not_found');

      const notContainer = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.move',
          request_id: 'req-gm5',
          group: 'plain',
          dx: 1,
        }),
      );
      if (!('error' in notContainer)) throw new Error('expected error response');
      expect(notContainer.error.code).toBe('command_rejected');

      addGroupNode('g0');
      const mixed = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.move',
          request_id: 'req-gm6',
          group: 'g0',
          dx: 1,
          y: 2,
        }),
      );
      if (!('error' in mixed)) throw new Error('expected error response');
      expect(mixed.error.code).toBe('command_rejected');
    });
  });

  // @spec: CLI-053
  describe('canvas.nodes.move', () => {
    it('批量相对位移：一次写入 = 一条历史；未知节点整批拒绝且零改动', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 50, 50);
      const historyBefore = historyLength();

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-nm1',
          nodes: ['n1', 'n2', 'n1'],
          dx: 10,
          dy: 20,
        }),
      );
      if (response.command !== 'canvas.nodes.move' || 'error' in response) throw new Error('expected nodes.move success response');
      expect(positionOf('n1')).toEqual({ x: 10, y: 20 });
      expect(positionOf('n2')).toEqual({ x: 60, y: 70 });
      expect(new Set(response.moved_node_ids)).toEqual(new Set(['n1', 'n2']));
      // 去重保序：重复 id 按一个节点处理（inspected = 2）
      expect(response.summary.inspected).toBe(2);
      expect(historyLength()).toBe(historyBefore + 1);

      // 任一节点不存在 → 整批拒绝、零改动
      const historyAfterSuccess = historyLength();
      const missing = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-nm2',
          nodes: ['n1', 'ghost'],
          dx: 1,
          dy: 1,
        }),
      );
      if (!('error' in missing)) throw new Error('expected error response');
      expect(missing.error.code).toBe('node_not_found');
      expect(positionOf('n1')).toEqual({ x: 10, y: 20 });
      expect(historyLength()).toBe(historyAfterSuccess);
    });

    it('允许包含容器 id：成员随容器一起移动，重复展开去重', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('m2', 200, 0, 'g0');

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.nodes.move',
          request_id: 'req-nm3',
          nodes: ['g0', 'm1'],
          dx: 30,
          dy: 0,
        }),
      );
      if (response.command !== 'canvas.nodes.move' || 'error' in response) throw new Error('expected nodes.move success response');
      // 显式 m1 与容器展开都以同一 delta 位移，不出现重复位移
      expect(positionOf('m1')).toEqual({ x: 30, y: 0 });
      expect(positionOf('m2')).toEqual({ x: 230, y: 0 });
      // cascaded = moved 中不属于 inspected 的级联节点（容器展开带出的 m2）
      expect(response.summary.inspected).toBe(2);
      expect(response.summary.moved).toBe(3);
      expect(response.summary.cascaded).toBe(1);
    });
  });

  // @spec: CLI-052, CLI-053
  describe('--dry-run：零写入、零历史', () => {
    it('group move dry-run 不改变任何位置、不产生历史、operation_id 为 null', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 100, 100, 'g0');
      const before = new Map(
        (useCanvasStore.getState().nodeGraph?.nodes ?? []).map((node) => [
          node.id,
          { x: node.position.x, y: node.position.y },
        ]),
      );
      const historyBefore = historyLength();

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.move',
          request_id: 'req-dry1',
          group: 'g0',
          dx: 100,
          dy: 100,
          dry_run: true,
        }),
      );
      if (response.command !== 'canvas.group.move' || 'error' in response) throw new Error('expected group.move success response');
      expect(response.dry_run).toBe(true);
      expect(response.operation_id).toBeNull();
      // 计划值正确（成员 + delta）
      expect(response.positions['m1']).toEqual({ x: 200, y: 200 });
      expect(response.summary.moved).toBeGreaterThan(0);
      // 零写入 ×2（位置不变 + 历史不变）
      for (const node of useCanvasStore.getState().nodeGraph?.nodes ?? []) {
        expect({ x: node.position.x, y: node.position.y }).toEqual(before.get(node.id));
      }
      expect(historyLength()).toBe(historyBefore);
    });

    it('layout dry-run 不产生历史，positions 为计划值', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 500, 300);
      const historyBefore = historyLength();
      const before = new Map(
        (useCanvasStore.getState().nodeGraph?.nodes ?? []).map((node) => [
          node.id,
          { x: node.position.x, y: node.position.y },
        ]),
      );

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-dry2',
          scope: 'all',
          dry_run: true,
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) {
        throw new Error('expected layout success response');
      }
      expect(response.dry_run).toBe(true);
      expect(response.operation_id).toBeNull();
      expect(Object.keys(response.positions).length).toBe(2);
      for (const node of useCanvasStore.getState().nodeGraph?.nodes ?? []) {
        expect({ x: node.position.x, y: node.position.y }).toEqual(before.get(node.id));
      }
      expect(historyLength()).toBe(historyBefore);
    });
  });

  // @spec: CLI-048, CLI-052
  describe('执行报告 summary：可区分「检查过但无相交」与空转', () => {
    it('containers 作用域两组不相交 → inspected=2 / moved=0 / unchanged=2', async () => {
      addGroupNode('g0', 0, 0);
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1', 5000, 5000);
      addTextInputNode('m2', 5000, 5000, 'g1');
      const historyBefore = historyLength();

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-sum1',
          scope: 'containers',
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) throw new Error('expected layout success response');
      expect(response.summary.inspected).toBe(2);
      expect(response.summary.moved).toBe(0);
      expect(response.summary.unchanged).toBe(2);
      expect(response.summary.skipped).toEqual([]);
      // 无相交 ⇒ 无写入 ⇒ 无历史、positions 为空
      expect(Object.keys(response.positions)).toHaveLength(0);
      expect(historyLength()).toBe(historyBefore);
    });
  });

  // @spec: CLI-054
  describe('canvas.undo：按操作精确回退', () => {
    it('只回退该次操作，期间的用户手工编辑保留；撤销本身作为一条新历史', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 0, 0);

      const moveResponse = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.node.move',
          request_id: 'req-u1',
          node: 'n1',
          x: 100,
          y: 100,
        }),
      );
      if (moveResponse.command !== 'canvas.node.move' || 'error' in moveResponse || moveResponse.operation_id === null) {
        throw new Error('expected operation_id from node.move');
      }
      const operationId = moveResponse.operation_id;
      expect(positionOf('n1')).toEqual({ x: 100, y: 100 });

      // 期间的用户手工编辑（不同节点）——撤销不得影响它
      useCanvasStore.getState().updateNodePositionsBatch([{ id: 'n2', position: { x: 777, y: 888 } }]);
      const historyBeforeUndo = historyLength();

      const undoResponse = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.undo',
          request_id: 'req-u2',
          operation: operationId,
        }),
      );
      if (undoResponse.command !== 'canvas.undo' || 'error' in undoResponse) throw new Error('expected undo success response');
      expect(undoResponse.undone).toBe(true);
      expect(undoResponse.operation_id).toBe(operationId);
      expect(positionOf('n1')).toEqual({ x: 0, y: 0 });
      // 手工编辑保留
      expect(positionOf('n2')).toEqual({ x: 777, y: 888 });
      // 撤销 = 一条新的历史记录（可被 Cmd+Z 反悔）
      expect(historyLength()).toBe(historyBeforeUndo + 1);

      // 同一 id 不可重复撤销
      const again = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.undo',
          request_id: 'req-u3',
          operation: operationId,
        }),
      );
      if (!('error' in again)) throw new Error('expected error response');
      expect(again.error.code).toBe('operation_not_found');
    });

    it('未知标识 → operation_not_found；非位置类操作标识 → command_rejected', async () => {
      const unknown = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.undo',
          request_id: 'req-u4',
          operation: 'op-does-not-exist',
        }),
      );
      if (!('error' in unknown)) throw new Error('expected error response');
      expect(unknown.error.code).toBe('operation_not_found');
      expect(unknown.error.message).toContain('失效');

      addTextInputNode('m1', 0, 0);
      const created = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.create',
          request_id: 'req-u5',
          name: '新组',
          members: ['m1'],
        }),
      );
      if (created.command !== 'canvas.group.create' || 'error' in created) throw new Error('expected create success response');
      const unsupported = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.undo',
          request_id: 'req-u6',
          operation: created.operation_id,
        }),
      );
      if (!('error' in unsupported)) throw new Error('expected error response');
      expect(unsupported.error.code).toBe('command_rejected');
    });
  });

  // @spec: CLI-055
  describe('canvas.layout --scope containers --pack：容器看板排布', () => {
    /** 容器派生 entry（渲染框 position + size）；缺失返回 undefined。 */
    const derivedEntryOf = (id: string) => {
      const store = useCanvasStore.getState();
      if (store.nodeGraph === null) return undefined;
      return buildGroupDerivedSize({
        nodes: store.nodeGraph.nodes,
        sizeSources: buildCanvasSizeSources(store),
      }).byGroupId[id];
    };

    const assertNoContainerOverlap = (leftId: string, rightId: string): void => {
      const left = derivedEntryOf(leftId);
      const right = derivedEntryOf(rightId);
      if (left === undefined || right === undefined) throw new Error('容器派生 entry 缺失');
      const rectOf = (entry: typeof left) => ({
        x: entry.position.x,
        y: entry.position.y,
        width: entry.size.width,
        height: entry.size.height,
      });
      expect(rectsIntersect(rectOf(left), rectOf(right))).toBe(false);
    };

    it('两个相交容器按默认列数排成看板：一次写入一条历史，summary 以容器计数', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1');
      addTextInputNode('m2', 0, 0, 'g1');
      const historyBefore = historyLength();
      const frameBefore = derivedFrameOf('g0');
      const memberBefore = positionOf('m1');
      if (frameBefore === undefined || memberBefore === undefined) throw new Error('种子缺失');
      const relativeBefore = {
        x: memberBefore.x - frameBefore.x,
        y: memberBefore.y - frameBefore.y,
      };

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack1',
          scope: 'containers',
          pack: true,
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) {
        throw new Error('expected layout success response');
      }
      // 缺省列数 = ceil(sqrt(2)) = 2；缺省间距 = NODE_GAP(120)
      expect(response.columns).toBe(2);
      expect(response.gap).toBe(120);
      expect(response.dry_run).toBe(false);
      expect(response.operation_id).not.toBeNull();
      // summary 以容器为单位：2 个容器都因排布发生位移
      expect(response.summary.inspected).toBe(2);
      expect(response.summary.moved).toBe(2);
      expect(response.summary.unchanged).toBe(0);
      expect(response.summary.skipped).toEqual([]);
      assertNoContainerOverlap('g0', 'g1');
      // 成员随宿主整体平移（成员相对容器的偏移不变）
      const frameAfter = derivedFrameOf('g0');
      const memberAfter = positionOf('m1');
      if (frameAfter === undefined || memberAfter === undefined) throw new Error('排布后种子缺失');
      expect({
        x: memberAfter.x - frameAfter.x,
        y: memberAfter.y - frameAfter.y,
      }).toEqual(relativeBefore);
      // 一次写命令 = 一条撤销记录
      expect(historyLength()).toBe(historyBefore + 1);
      // positions 覆盖受影响节点（容器 + 成员）且与 store 最终位置一致
      for (const [nodeId, position] of Object.entries(response.positions)) {
        expect(positionOf(nodeId)).toEqual(position);
      }
    });

    it('--dry-run：计划位置正确、零写入、零历史、operation_id 为 null', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1');
      addTextInputNode('m2', 500, 500, 'g1');
      const historyBefore = historyLength();
      const before = new Map(
        (useCanvasStore.getState().nodeGraph?.nodes ?? []).map((node) => [
          node.id,
          { x: node.position.x, y: node.position.y },
        ]),
      );

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack2',
          scope: 'containers',
          pack: true,
          dry_run: true,
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) {
        throw new Error('expected layout success response');
      }
      expect(response.dry_run).toBe(true);
      expect(response.operation_id).toBeNull();
      expect(response.columns).toBe(2);
      expect(Object.keys(response.positions).length).toBeGreaterThan(0);
      // 零写入 ×2（位置不变 + 历史不变）
      for (const node of useCanvasStore.getState().nodeGraph?.nodes ?? []) {
        expect({ x: node.position.x, y: node.position.y }).toEqual(before.get(node.id));
      }
      expect(historyLength()).toBe(historyBefore);
    });

    it('显式 --columns/--gap 与 --order：顺序按给定优先，未指定容器按阅读序跟排', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1');
      addTextInputNode('m2', 0, 300, 'g1');

      const response = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack3',
          scope: 'containers',
          pack: true,
          columns: 1,
          gap: 0,
          order: ['g1'],
        }),
      );
      if (response.command !== 'canvas.layout' || 'error' in response) {
        throw new Error('expected layout success response');
      }
      expect(response.columns).toBe(1);
      expect(response.gap).toBe(0);
      const first = derivedEntryOf('g1');
      const second = derivedEntryOf('g0');
      if (first === undefined || second === undefined) throw new Error('容器派生 entry 缺失');
      // g1 显式排第一（上方），g0 跟排；单列 + 间距 0 ⇒ 紧邻上下
      expect(first.position.y).toBeLessThan(second.position.y);
      expect(second.position.y - first.position.y).toBeGreaterThanOrEqual(first.size.height);
    });

    it('--pack 用在 all / group 作用域 → command_rejected，画布零改动', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      const historyBefore = historyLength();
      const frameBefore = derivedFrameOf('g0');

      const allRejected = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack4',
          scope: 'all',
          pack: true,
        }),
      );
      if (!('error' in allRejected)) throw new Error('expected error response');
      expect(allRejected.error.code).toBe('command_rejected');

      const groupRejected = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack5',
          scope: { group: 'g0' },
          pack: true,
        }),
      );
      if (!('error' in groupRejected)) throw new Error('expected error response');
      expect(groupRejected.error.code).toBe('command_rejected');

      expect(derivedFrameOf('g0')).toEqual(frameBefore);
      expect(historyLength()).toBe(historyBefore);
    });

    it('--gap 不带 --pack → command_rejected；--order 指向不存在/非顶层容器的 id → 分别拒绝', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');

      const gapOnly = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack6',
          scope: 'containers',
          gap: 40,
        }),
      );
      if (!('error' in gapOnly)) throw new Error('expected error response');
      expect(gapOnly.error.code).toBe('command_rejected');

      const missingOrder = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack7',
          scope: 'containers',
          pack: true,
          order: ['ghost'],
        }),
      );
      if (!('error' in missingOrder)) throw new Error('expected error response');
      expect(missingOrder.error.code).toBe('node_not_found');

      // 成员节点存在但不是顶层容器
      const outOfScopeOrder = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-pack8',
          scope: 'containers',
          pack: true,
          order: ['m1'],
        }),
      );
      if (!('error' in outOfScopeOrder)) throw new Error('expected error response');
      expect(outOfScopeOrder.error.code).toBe('command_rejected');
    });

    it('无 --pack 时旧 containers 行为不变：仍拒绝 --columns/--order，响应 columns/gap 为 null', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addGroupNode('g1');
      addTextInputNode('m2', 0, 0, 'g1');

      const legacy = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-legacy1',
          scope: 'containers',
        }),
      );
      if (legacy.command !== 'canvas.layout' || 'error' in legacy) {
        throw new Error('expected layout success response');
      }
      expect(legacy.columns).toBeNull();
      expect(legacy.gap).toBeNull();
      assertNoContainerOverlap('g0', 'g1');

      const rejected = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.layout',
          request_id: 'req-legacy2',
          scope: 'containers',
          columns: 2,
        }),
      );
      if (!('error' in rejected)) throw new Error('expected error response');
      expect(rejected.error.code).toBe('command_rejected');
    });
  });
});
