// @vitest-environment node
// @spec: CLI-052, CLI-053, CLI-054
//
// CLI 与本地 Agent 集成 · 画布写原语（批次二）主链接缝：
// CLI 客户端 → 真实控制服务 → 执行器 → 代理通道 → 真实画布接收器 → store 位置写入 / 按操作撤销。
// 两端真实，只在最外层挡掉 Electron 窗口传输层（cli.seam.harness 既有台架）。
//
// 从 cli.seam.test.ts 拆出（该文件接近 max-lines 预算）：本文件只承载批次二两条链路。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
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

const positionOf = (nodeId: string): { x: number; y: number } | undefined => {
  const node = useCanvasStore.getState().nodeGraph?.nodes.find((candidate) => candidate.id === nodeId);
  return node === undefined ? undefined : { x: node.position.x, y: node.position.y };
};

describe('canvas group move 全链（CLI-052）', () => {
  it('成员与容器整体按 delta 移动；一次命令一条历史；operation_id 可撤销', async () => {
    const m1 = createMemberNodeViaStoreAction(100, 100);
    const m2 = createMemberNodeViaStoreAction(300, 200);
    const groupId = await createGroupViaCli('写原语组', [m1, m2]);
    const historyBefore = useCanvasStore.getState().history.length;

    const result = await runCli([
      'canvas', 'group', 'move',
      '--project', OPEN_PROJECT_NAME,
      '--group', groupId,
      '--dx', '40',
      '--dy', '-10',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.group.move') {
      throw new Error(`expected canvas.group.move success response, got ${result.stdout}`);
    }
    expect(response.dry_run).toBe(false);
    expect(typeof response.operation_id).toBe('string');
    expect(positionOf(m1)).toEqual({ x: 140, y: 90 });
    expect(positionOf(m2)).toEqual({ x: 340, y: 190 });
    expect(new Set(response.moved_node_ids)).toEqual(new Set([groupId, m1, m2]));
    expect(response.summary.inspected).toBe(3);
    // 一条命令 = 一条撤销记录
    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);

    // 按操作撤销：位置回到操作前
    const undo = await runCli([
      'canvas', 'undo',
      '--project', OPEN_PROJECT_NAME,
      '--operation', response.operation_id ?? '',
      '--json',
    ]);
    expect(undo.exitCode).toBe(0);
    const undoResponse = parseCliResponse(undo);
    if (!undoResponse.ok || undoResponse.command !== 'canvas.undo') {
      throw new Error(`expected canvas.undo success response, got ${undo.stdout}`);
    }
    expect(undoResponse.undone).toBe(true);
    expect(positionOf(m1)).toEqual({ x: 100, y: 100 });
    expect(positionOf(m2)).toEqual({ x: 300, y: 200 });

    // 同一标识不可重复撤销
    const again = await runCli([
      'canvas', 'undo',
      '--project', OPEN_PROJECT_NAME,
      '--operation', response.operation_id ?? '',
      '--json',
    ]);
    expect(again.exitCode).toBe(1);
    expect(parseCliFailure(again).code).toBe('operation_not_found');
  });

  it('canvas nodes move --dry-run：计划位置正确、画布零改动', async () => {
    const n1 = createMemberNodeViaStoreAction(0, 0);
    const before = positionOf(n1);

    const result = await runCli([
      'canvas', 'nodes', 'move',
      '--project', OPEN_PROJECT_NAME,
      '--nodes', n1,
      '--dx', '25',
      '--dy', '35',
      '--dry-run',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.nodes.move') {
      throw new Error(`expected canvas.nodes.move success response, got ${result.stdout}`);
    }
    expect(response.dry_run).toBe(true);
    expect(response.operation_id).toBeNull();
    expect(response.positions[n1]).toEqual({
      x: (before?.x ?? 0) + 25,
      y: (before?.y ?? 0) + 35,
    });
    expect(positionOf(n1)).toEqual(before);
  });

  it('canvas nodes move --positions：绝对坐标族逐节点落到目标坐标，一次命令一条历史', async () => {
    const n1 = createMemberNodeViaStoreAction(0, 0);
    const n2 = createMemberNodeViaStoreAction(100, 100);
    const historyBefore = useCanvasStore.getState().history.length;

    const result = await runCli([
      'canvas', 'nodes', 'move',
      '--project', OPEN_PROJECT_NAME,
      '--positions', `${n1}=40,50`,
      '--positions', `${n2}=-10,20`,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.nodes.move') {
      throw new Error(`expected canvas.nodes.move success response, got ${result.stdout}`);
    }
    expect(response.dry_run).toBe(false);
    expect(typeof response.operation_id).toBe('string');
    expect(response.positions[n1]).toEqual({ x: 40, y: 50 });
    expect(response.positions[n2]).toEqual({ x: -10, y: 20 });
    expect(positionOf(n1)).toEqual({ x: 40, y: 50 });
    expect(positionOf(n2)).toEqual({ x: -10, y: 20 });
    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
  });
});
