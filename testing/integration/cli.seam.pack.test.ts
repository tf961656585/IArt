// @vitest-environment node
// @spec: CLI-055
//
// CLI 与本地 Agent 集成 · canvas layout --scope containers --pack 主链接缝：
// CLI 客户端 → 真实控制服务 → 执行器 → 代理通道 → 真实画布接收器 → store 看板排布。
// 两端真实，只在最外层挡掉 Electron 窗口传输层（cli.seam.harness 既有台架）。
//
// 断言口径：初始相交场景下每个容器都要挪位（summary.moved === summary.inspected），
// 排布后容器派生框两两不相交；响应 positions 与 store 最终位置一致。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { buildGroupDerivedSize } from '@/features/canvas/components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { rectsIntersect } from '@/features/canvas/utils/taskNodePlacement';
import {
  OPEN_PROJECT_NAME,
  createMemberNodeViaStoreAction,
  parseCliFailure,
  parseCliResponse,
  resetSeamForTest,
  runCli,
  startCliSeamService,
  stopCliSeamService,
} from './cli.seam.harness';

beforeAll(async () => {
  await startCliSeamService();
});

afterAll(async () => {
  await stopCliSeamService();
});

beforeEach(async () => {
  await resetSeamForTest();
});

const createGroupViaCli = async (name: string, memberIds: readonly string[]): Promise<string> => {
  const result = await runCli([
    'canvas', 'group', 'create',
    '--project', OPEN_PROJECT_NAME,
    '--name', name,
    '--members', memberIds.join(','),
    '--json',
  ]);
  expect(result.exitCode).toBe(0);
  const response = parseCliResponse(result);
  if (!response.ok || response.command !== 'canvas.group.create') {
    throw new Error(`expected canvas.group.create success response, got ${result.stdout}`);
  }
  return response.group_node_id;
};

const derivedFrames = (): Record<
  string,
  { position: { x: number; y: number }; size: { width: number; height: number } }
> => {
  const store = useCanvasStore.getState();
  const graph = store.nodeGraph;
  if (!graph) throw new Error('nodeGraph 为空');
  return buildGroupDerivedSize({
    nodes: graph.nodes,
    sizeSources: buildCanvasSizeSources(store),
  }).byGroupId;
};

const asRect = (entry: { position: { x: number; y: number }; size: { width: number; height: number } }) => ({
  x: entry.position.x,
  y: entry.position.y,
  width: entry.size.width,
  height: entry.size.height,
});

describe('canvas layout --scope containers --pack（CLI-055）', () => {
  it('两个相交组走 CLI 全链排成看板：容器不相交、moved === inspected、一条撤销记录', async () => {
    const a1 = createMemberNodeViaStoreAction(0, 0);
    const a2 = createMemberNodeViaStoreAction(500, 0);
    const groupA = await createGroupViaCli('看板组 A', [a1, a2]);
    const b1 = createMemberNodeViaStoreAction(100, 100);
    const b2 = createMemberNodeViaStoreAction(600, 100);
    const groupB = await createGroupViaCli('看板组 B', [b1, b2]);

    const before = derivedFrames();
    const beforeA = before[groupA];
    const beforeB = before[groupB];
    if (!beforeA || !beforeB) throw new Error('建组后容器派生 entry 缺失');
    // 构造前提：整理前两组确实相交（否则 moved === inspected 不成立）
    expect(rectsIntersect(asRect(beforeA), asRect(beforeB))).toBe(true);

    const historyBefore = useCanvasStore.getState().history.length;

    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--scope', 'containers',
      '--pack',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }

    // 两个容器 ⇒ 缺省列数 ceil(sqrt(2)) = 2；缺省间距 = NODE_GAP(120)
    expect(response.columns).toBe(2);
    expect(response.gap).toBe(120);
    expect(response.dry_run).toBe(false);
    expect(response.operation_id).not.toBeNull();
    expect(response.summary.inspected).toBe(2);
    expect(response.summary.moved).toBe(response.summary.inspected);
    expect(response.summary.skipped).toEqual([]);

    const after = derivedFrames();
    const afterA = after[groupA];
    const afterB = after[groupB];
    if (!afterA || !afterB) throw new Error('排布后容器派生 entry 缺失');
    expect(rectsIntersect(asRect(afterA), asRect(afterB))).toBe(false);

    // 响应位置 = store 最终位置（代理执行通道回读口径）
    const graph = useCanvasStore.getState().nodeGraph;
    if (!graph) throw new Error('nodeGraph 为空');
    for (const [nodeId, position] of Object.entries(response.positions)) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.position).toEqual(position);
    }
    // 一次命令 = 一条撤销记录
    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
  });

  it('--order-mode created 与 --pack 组合 → command_rejected，画布零改动（spec 只承诺 all/group）', async () => {
    const a1 = createMemberNodeViaStoreAction(0, 0);
    const groupA = await createGroupViaCli('看板组 A', [a1]);
    const before = derivedFrames();
    const beforeA = before[groupA];
    if (!beforeA) throw new Error('建组后容器派生 entry 缺失');
    const historyBefore = useCanvasStore.getState().history.length;

    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--scope', 'containers',
      '--pack',
      '--order-mode', 'created',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    const failure = parseCliFailure(result);
    expect(failure.code).toBe('command_rejected');
    expect(failure.message).toContain('--order');

    // 画布零改动：位置不变、无新增历史。
    const after = derivedFrames();
    expect(after[groupA]?.position).toEqual(beforeA.position);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
  });
});
