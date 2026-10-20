// @vitest-environment node
// @spec: CLI-048
//
// CLI 与本地 Agent 集成 · canvas layout --scope containers 主链接缝：
// CLI 客户端 → 真实控制服务 → 执行器 → 代理通道 → 真实画布接收器 → store 容器让位。
// 两端真实，只在最外层挡掉 Electron 窗口传输层（cli.seam.harness 既有台架）。
//
// 从旧文件拆出：cli.seam.test.ts 已接近 max-lines 预算；本文件只承载容器作用域两条用例。

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

describe('canvas layout --scope containers（CLI-048）', () => {
  it('两个相交组走 CLI 全链整组让位：容器派生框不相交、返回最终位置', async () => {
    const a1 = createMemberNodeViaStoreAction(0, 0);
    const a2 = createMemberNodeViaStoreAction(500, 0);
    const groupA = await createGroupViaCli('容器作用域 A', [a1, a2]);
    const b1 = createMemberNodeViaStoreAction(100, 100);
    const b2 = createMemberNodeViaStoreAction(600, 100);
    const groupB = await createGroupViaCli('容器作用域 B', [b1, b2]);

    const rectOf = (entry: {
      position: { x: number; y: number };
      size: { width: number; height: number };
    }) => ({
      x: entry.position.x,
      y: entry.position.y,
      width: entry.size.width,
      height: entry.size.height,
    });
    const derived = () => {
      const graph = useCanvasStore.getState().nodeGraph;
      if (!graph) throw new Error('nodeGraph 为空');
      return buildGroupDerivedSize({
        nodes: graph.nodes,
        sizeSources: buildCanvasSizeSources(useCanvasStore.getState()),
      }).byGroupId;
    };

    const beforeA = derived()[groupA];
    const beforeB = derived()[groupB];
    if (!beforeA || !beforeB) throw new Error('建组后容器派生 entry 缺失');
    // 构造前提：两组整理前确实相交（否则用例不覆盖让位路径）
    expect(rectsIntersect(rectOf(beforeA), rectOf(beforeB))).toBe(true);

    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--scope', 'containers',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }
    expect(Object.keys(response.positions).length).toBeGreaterThan(0);

    const graph = useCanvasStore.getState().nodeGraph;
    if (!graph) throw new Error('nodeGraph 为空');
    const afterA = derived()[groupA];
    const afterB = derived()[groupB];
    if (!afterA || !afterB) throw new Error('整理后容器派生 entry 缺失');
    expect(rectsIntersect(rectOf(afterA), rectOf(afterB))).toBe(false);
    // 响应位置 = store 最终位置（代理执行通道回读口径）
    for (const [nodeId, position] of Object.entries(response.positions)) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.position).toEqual(position);
    }
  });

  it('携带 --columns 以 command_rejected 失败（容器作用域不重排成员）', async () => {
    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--scope', 'containers',
      '--columns', '2',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    const error = parseCliFailure(result);
    expect(error.code).toBe('command_rejected');
  });
});
