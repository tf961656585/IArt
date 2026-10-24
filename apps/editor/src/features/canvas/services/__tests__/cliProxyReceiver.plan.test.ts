// @spec: CLI-030, CLI-055, CLI-058, CLI-059, CLI-061
//
// CLI 画布写命令 · 批次 1b 测试：`canvas.layout --plan` 计划执行器
// （groups → containers → positions 一次算完、一次写入、一条撤销）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliCanvasLayoutPlan, CliProxyCommandResponse } from '@iart/contracts';
import { useCanvasStore } from '../../store/canvasStore';
import { executeCliProxyCommand } from '../cliProxyReceiver';
import { clearCliOperations, getCliOperationCount } from '../cliOperationRegistry';
import { addAgentNode, addCollapsedGroupNode } from './cliProxyReceiver.planFixtures';
import {
  addGroupNode,
  addTextInputNode,
  createTestGraph,
  historyLength,
  parseResponse,
  positionOf,
  resetStore,
} from './cliProxyReceiver.writeOpsFixtures';

type XY = { x: number; y: number };

const runLayout = async (
  requestId: string,
  plan: CliCanvasLayoutPlan,
  options: { dryRun?: boolean } = {},
): Promise<CliProxyCommandResponse> =>
  parseResponse(
    await executeCliProxyCommand({
      command: 'canvas.layout',
      request_id: requestId,
      plan,
      ...(options.dryRun === true ? { dry_run: true } : {}),
    }),
  );

const layoutSuccess = (response: CliProxyCommandResponse) => {
  if (response.command !== 'canvas.layout' || 'error' in response) {
    throw new Error('expected canvas.layout success response');
  }
  return response;
};

const layoutError = (response: CliProxyCommandResponse) => {
  if (!('error' in response)) throw new Error('expected error response');
  return response;
};

const posOf = (id: string): XY => {
  const position = positionOf(id);
  if (position === undefined) throw new Error(`node not found: ${id}`);
  return position;
};

const plannedPos = (positions: Record<string, XY>, id: string): XY => {
  const position = positions[id];
  if (position === undefined) throw new Error(`missing planned position: ${id}`);
  return position;
};

const delta = (from: XY, to: XY): XY => ({ x: to.x - from.x, y: to.y - from.y });

describe('CLI canvas.layout --plan 计划执行器（批次 1b）', () => {
  beforeEach(async () => {
    clearCliOperations();
    resetStore();
    await useCanvasStore.getState().loadNodeGraph(createTestGraph());
    useCanvasStore.getState().commitDeferredHistoryBaseline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('仅 groups：一个组两个成员按 columns=2 网格落位，历史 +1、operation_id 非空', async () => {
    addGroupNode('g0');
    addTextInputNode('m1', 0, 0, 'g0');
    addTextInputNode('m2', 400, 0, 'g0');
    const historyBefore = historyLength();

    const response = layoutSuccess(
      await runLayout('req-plan-groups', {
        groups: [{ group_id: 'g0', columns: 2, gap: 60 }],
      }),
    );

    const m1 = posOf('m1');
    const m2 = posOf('m2');
    // 网格口径：同一行、列序稳定
    expect(m1.y).toBe(m2.y);
    expect(m2.x).toBeGreaterThan(m1.x);
    // 响应位置 = 写入后 store 现值（叶子节点）
    expect(plannedPos(response.positions, 'm2')).toEqual(m2);
    expect(response.columns).toBeNull();
    expect(response.gap).toBeNull();
    expect(response.dry_run).toBe(false);
    expect(response.operation_id).not.toBeNull();
    expect(response.summary.inspected).toBe(2);
    expect(response.summary.skipped).toEqual([]);
    expect(historyLength()).toBe(historyBefore + 1);
  });

  it('groups + containers：组内先排、再整组被看板平移；最终位置 = 组内结果 + 同一平移向量，历史仍 +1', async () => {
    const buildInitialGraph = (): void => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('m2', 420, 0, 'g0');
      // 第二容器放在视觉序最左，使看板把 g0 从原位移开（平移量非零）
      addGroupNode('g1', -3000, 0);
      addTextInputNode('m3', -3000, 0, 'g1');
    };
    const resetToInitialGraph = async (): Promise<void> => {
      resetStore();
      await useCanvasStore.getState().loadNodeGraph(createTestGraph());
      useCanvasStore.getState().commitDeferredHistoryBaseline();
      buildInitialGraph();
    };

    const groupsPlan: CliCanvasLayoutPlan = {
      groups: [{ group_id: 'g0', columns: 2, gap: 60 }],
    };
    const compositePlan: CliCanvasLayoutPlan = {
      groups: [{ group_id: 'g0', columns: 2, gap: 60 }],
      containers: { columns: 2, gap: 120 },
    };

    // 参照组内结果：先单独执行 groups 段（真实写入后从 store 读全部成员位置，
    // dry-run 只回传发生位移的节点，未位移的成员不在其中）。
    await resetToInitialGraph();
    layoutSuccess(await runLayout('req-plan-groups-only', groupsPlan));
    const internalM1 = posOf('m1');
    const internalM2 = posOf('m2');

    // 回到同一初始图，跑完整计划（两段在同一初始状态下比较）
    await resetToInitialGraph();
    const compositeDry = layoutSuccess(
      await runLayout('req-plan-composite-dry', compositePlan, { dryRun: true }),
    );
    const historyBefore = historyLength();
    const executed = layoutSuccess(
      await runLayout('req-plan-composite', compositePlan),
    );

    const shift1 = delta(internalM1, plannedPos(compositeDry.positions, 'm1'));
    const shift2 = delta(internalM2, plannedPos(compositeDry.positions, 'm2'));
    // 两个成员被同一向量平移：组内相对布局不变（先组内排、再整组平移）
    expect(shift2).toEqual(shift1);
    expect(shift1.x !== 0 || shift1.y !== 0).toBe(true);

    // 执行结果 = 计划值（成员与容器派生渲染框）
    expect(posOf('m1')).toEqual(plannedPos(compositeDry.positions, 'm1'));
    expect(posOf('m2')).toEqual(plannedPos(compositeDry.positions, 'm2'));
    expect(plannedPos(executed.positions, 'm1')).toEqual(plannedPos(compositeDry.positions, 'm1'));
    expect(plannedPos(executed.positions, 'm2')).toEqual(plannedPos(compositeDry.positions, 'm2'));
    expect(plannedPos(executed.positions, 'g0')).toEqual(plannedPos(compositeDry.positions, 'g0'));
    expect(historyLength()).toBe(historyBefore + 1);
    expect(executed.operation_id).not.toBeNull();
  });

  it('仅 positions：两个非容器节点绝对落位，一次写入一条历史', async () => {
    addTextInputNode('n1', 0, 0);
    addTextInputNode('n2', 10, 10);
    const historyBefore = historyLength();

    const response = layoutSuccess(
      await runLayout('req-plan-positions', {
        positions: { n1: { x: 300, y: 400 }, n2: { x: -20, y: 70 } },
      }),
    );

    expect(posOf('n1')).toEqual({ x: 300, y: 400 });
    expect(posOf('n2')).toEqual({ x: -20, y: 70 });
    expect(response.positions).toEqual({ n1: { x: 300, y: 400 }, n2: { x: -20, y: 70 } });
    expect(response.summary).toMatchObject({ inspected: 2, moved: 2, cascaded: 0, unchanged: 0 });
    expect(historyLength()).toBe(historyBefore + 1);
    expect(response.operation_id).not.toBeNull();
  });

  it('groups + positions 不相交：一次写入、一条历史', async () => {
    addGroupNode('g0');
    addTextInputNode('m1', 0, 0, 'g0');
    addTextInputNode('m2', 400, 0, 'g0');
    addTextInputNode('free', 5000, 5000);
    const historyBefore = historyLength();

    const response = layoutSuccess(
      await runLayout('req-plan-mixed', {
        groups: [{ group_id: 'g0', columns: 2, gap: 60 }],
        positions: { free: { x: 900, y: 900 } },
      }),
    );

    expect(posOf('free')).toEqual({ x: 900, y: 900 });
    expect(posOf('m2').x).not.toBe(400);
    expect(response.summary.inspected).toBe(3);
    expect(historyLength()).toBe(historyBefore + 1);
    expect(response.operation_id).not.toBeNull();
  });

  it('dry-run：位置为计划值、历史不变、operation_id 为 null', async () => {
    addTextInputNode('n1', 0, 0);
    const historyBefore = historyLength();

    const response = layoutSuccess(
      await runLayout(
        'req-plan-dry',
        { positions: { n1: { x: 123, y: 456 } } },
        { dryRun: true },
      ),
    );

    expect(response.dry_run).toBe(true);
    expect(response.operation_id).toBeNull();
    expect(plannedPos(response.positions, 'n1')).toEqual({ x: 123, y: 456 });
    expect(response.summary.moved).toBe(1);
    expect(posOf('n1')).toEqual({ x: 0, y: 0 });
    expect(historyLength()).toBe(historyBefore);
    expect(getCliOperationCount()).toBe(0);
  });

  it('positions 命中组内成员 / 容器 → command_rejected，画布零改动、零 operation', async () => {
    addGroupNode('g0');
    addTextInputNode('m1', 0, 0, 'g0');
    addTextInputNode('m2', 400, 0, 'g0');
    const historyBefore = historyLength();
    const beforeM1 = posOf('m1');

    const memberConflict = layoutError(
      await runLayout('req-plan-conflict-member', {
        groups: [{ group_id: 'g0' }],
        positions: { m1: { x: 1, y: 1 } },
      }),
    );
    expect(memberConflict.error.code).toBe('command_rejected');
    expect(memberConflict.error.message).toContain('已被 groups/containers 覆盖');

    const containerConflict = layoutError(
      await runLayout('req-plan-conflict-container', {
        positions: { g0: { x: 1, y: 1 } },
      }),
    );
    expect(containerConflict.error.code).toBe('command_rejected');
    expect(containerConflict.error.message).toContain('容器节点');

    expect(posOf('m1')).toEqual(beforeM1);
    expect(posOf('g0')).toEqual({ x: 0, y: 0 });
    expect(historyLength()).toBe(historyBefore);
    expect(getCliOperationCount()).toBe(0);
  });

  it('未知 group → group_not_found；嵌套容器 / 非容器 → command_rejected；未知 node → node_not_found', async () => {
    addGroupNode('g0');
    addAgentNode('a0', 0, 0, 'g0');
    addTextInputNode('am1', 0, 0, 'a0');
    addTextInputNode('n1', 100, 100);
    const historyBefore = historyLength();

    const unknownGroup = layoutError(
      await runLayout('req-plan-unknown-group', { groups: [{ group_id: 'ghost' }] }),
    );
    expect(unknownGroup.error.code).toBe('group_not_found');

    const nested = layoutError(
      await runLayout('req-plan-nested', { groups: [{ group_id: 'a0' }] }),
    );
    expect(nested.error.code).toBe('command_rejected');
    expect(nested.error.message).toContain('只支持顶层容器');

    const notContainer = layoutError(
      await runLayout('req-plan-not-container', { groups: [{ group_id: 'n1' }] }),
    );
    expect(notContainer.error.code).toBe('command_rejected');
    expect(notContainer.error.message).toContain('不是容器节点');

    const unknownNode = layoutError(
      await runLayout('req-plan-unknown-node', { positions: { ghost: { x: 1, y: 1 } } }),
    );
    expect(unknownNode.error.code).toBe('node_not_found');

    // 全部拒绝路径零写入、零历史、零 operation
    expect(historyLength()).toBe(historyBefore);
    expect(getCliOperationCount()).toBe(0);
  });

  it('重复 group_id → command_rejected，画布零改动', async () => {
    addGroupNode('g0');
    addTextInputNode('m1', 0, 0, 'g0');
    const historyBefore = historyLength();

    const duplicated = layoutError(
      await runLayout('req-plan-duplicate-group', {
        groups: [{ group_id: 'g0' }, { group_id: 'g0' }],
      }),
    );
    expect(duplicated.error.code).toBe('command_rejected');
    expect(duplicated.error.message).toContain('g0');

    expect(posOf('m1')).toEqual({ x: 0, y: 0 });
    expect(historyLength()).toBe(historyBefore);
    expect(getCliOperationCount()).toBe(0);
  });

  it('空组 / 折叠组 → skipped no_layout_output，不阻断其他段', async () => {
    addGroupNode('gEmpty');
    addCollapsedGroupNode('gCollapsed');
    addTextInputNode('cm1', 0, 0, 'gCollapsed');
    addGroupNode('g0');
    addTextInputNode('m1', 0, 0, 'g0');
    addTextInputNode('m2', 400, 0, 'g0');
    addTextInputNode('free', 5000, 5000);
    const historyBefore = historyLength();

    const response = layoutSuccess(
      await runLayout('req-plan-skips', {
        groups: [
          { group_id: 'gEmpty' },
          { group_id: 'gCollapsed' },
          { group_id: 'g0', columns: 2, gap: 60 },
        ],
        positions: { free: { x: 900, y: 900 } },
      }),
    );

    expect(response.summary.skipped).toEqual([
      { node_id: 'gEmpty', reason: 'no_layout_output' },
      { node_id: 'gCollapsed', reason: 'no_layout_output' },
    ]);
    expect(posOf('free')).toEqual({ x: 900, y: 900 });
    expect(posOf('m2').x).not.toBe(400);
    expect(historyLength()).toBe(historyBefore + 1);
  });

  it('content_reordered / order_changes：显式 order 与视觉序不一致时汇总为 true 且带明细', async () => {
    addGroupNode('g0');
    addTextInputNode('m1', 0, 0, 'g0');
    addTextInputNode('m2', 500, 0, 'g0');

    const natural = layoutSuccess(
      await runLayout(
        'req-plan-order-natural',
        { groups: [{ group_id: 'g0', columns: 2, gap: 60 }] },
        { dryRun: true },
      ),
    );
    expect(natural.content_reordered).toBe(false);
    expect(natural.order_changes).toEqual([]);

    const reordered = layoutSuccess(
      await runLayout(
        'req-plan-order-explicit',
        {
          groups: [{ group_id: 'g0', columns: 2, gap: 60, order: ['m2', 'm1'] }],
        },
        { dryRun: true },
      ),
    );
    expect(reordered.content_reordered).toBe(true);
    expect(reordered.order_changes).toContainEqual({ node_id: 'm2', from_slot: 1, to_slot: 0 });
    // 显式序生效：m2 排在 m1 之前（视觉列序反转）
    expect(plannedPos(reordered.positions, 'm2').x).toBeLessThan(
      plannedPos(reordered.positions, 'm1').x,
    );
  });

  it('summary：moved / cascaded / unchanged / inspected 与 skipped 口径', async () => {
    addGroupNode('gEmpty');
    addTextInputNode('n1', 0, 0);
    addTextInputNode('n2', 250, 250);
    const historyBefore = historyLength();

    const response = layoutSuccess(
      await runLayout('req-plan-summary', {
        groups: [{ group_id: 'gEmpty' }],
        // n2 给出与现值相同的坐标：inspected 但 unchanged
        positions: { n1: { x: 100, y: 100 }, n2: { x: 250, y: 250 } },
      }),
    );

    expect(response.summary).toEqual({
      inspected: 2,
      moved: 1,
      cascaded: 0,
      unchanged: 1,
      skipped: [{ node_id: 'gEmpty', reason: 'no_layout_output' }],
    });
    expect(posOf('n1')).toEqual({ x: 100, y: 100 });
    expect(posOf('n2')).toEqual({ x: 250, y: 250 });
    expect(historyLength()).toBe(historyBefore + 1);
  });
});
