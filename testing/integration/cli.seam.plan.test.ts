// @vitest-environment node
// @spec: CLI-062, CLI-055, CLI-058
//
// CLI 与本地 Agent 集成 · `canvas layout --plan` 计划文件主链接缝（批次 1b）：
// CLI 客户端 → 真实控制服务 → 执行器（真实 fs 读取 + contract schema 校验）→ 代理通道 →
// 真实画布接收器 → 真实 Editor store 一次批量写入。
// 两端真实，只在最外层挡掉 Electron 窗口传输层（cli.seam.harness 既有台架）。
//
// 覆盖：groups + positions 正向（一次写入一条历史）、containers 段、dry-run、
// 非法计划（JSON / schema）、与 --scope 混用、显式坐标命中组内成员冲突。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { buildGroupDerivedSize } from '@/features/canvas/components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { resolveEffectiveSize } from '@/features/canvas/utils/effectiveSize';
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

let planDir = '';
let planSeq = 0;

beforeAll(async () => {
  await startCliSeamService();
  planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-seam-plan-'));
});

afterAll(async () => {
  await stopCliSeamService();
  fs.rmSync(planDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetSeamForTest();
});

/** 每个用例独立计划文件，路径唯一（避免用例间残留串味）。 */
const writePlanFile = (content: unknown): string => {
  planSeq += 1;
  const filePath = path.join(planDir, `plan-${planSeq}.json`);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
  return filePath;
};

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

const layoutWithPlan = (planPath: string, extra: readonly string[] = []) =>
  runCli(['canvas', 'layout', '--project', OPEN_PROJECT_NAME, '--plan', planPath, ...extra, '--json']);

const nodeOf = (nodeId: string) => {
  const node = useCanvasStore.getState().nodeGraph?.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`node not found: ${nodeId}`);
  return node;
};

const positionOf = (nodeId: string): { x: number; y: number } => {
  const { position } = nodeOf(nodeId);
  return { x: position.x, y: position.y };
};

const effectiveWidthOf = (nodeId: string): number =>
  resolveEffectiveSize(nodeOf(nodeId), buildCanvasSizeSources(useCanvasStore.getState())).width;

const derivedFrames = () => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (graph === null) throw new Error('nodeGraph 为空');
  return buildGroupDerivedSize({
    nodes: graph.nodes,
    sizeSources: buildCanvasSizeSources(state),
  }).byGroupId;
};

const asRect = (entry: {
  position: { x: number; y: number };
  size: { width: number; height: number };
}) => ({
  x: entry.position.x,
  y: entry.position.y,
  width: entry.size.width,
  height: entry.size.height,
});

const snapshotPositions = (): Record<string, { x: number; y: number }> =>
  Object.fromEntries(
    (useCanvasStore.getState().nodeGraph?.nodes ?? []).map((node) => [
      node.id,
      { x: node.position.x, y: node.position.y },
    ]),
  );

describe('canvas layout --plan 计划文件全链（CLI-062）', () => {
  it('groups + positions：组内 2 列网格（gap 24）+ 自由节点绝对坐标，一次写入一条历史', async () => {
    const m1 = createMemberNodeViaStoreAction(100, 100);
    const m2 = createMemberNodeViaStoreAction(300, 200);
    const groupId = await createGroupViaCli('计划组', [m1, m2]);
    const free = createMemberNodeViaStoreAction(5000, 5000);
    const widthM1 = effectiveWidthOf(m1);
    const historyBefore = useCanvasStore.getState().history.length;

    const planPath = writePlanFile({
      groups: [{ group_id: groupId, columns: 2, gap: 24, order: [m1, m2] }],
      positions: { [free]: { x: 900, y: 900 } },
    });
    const result = await layoutWithPlan(planPath);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }
    // 计划文件模式判别字段：columns/gap 均为 null
    expect(response.plan_applied).toBe(true);
    expect(response.columns).toBeNull();
    expect(response.gap).toBeNull();
    expect(response.dry_run).toBe(false);
    expect(typeof response.operation_id).toBe('string');

    // 组内 2 列网格：同一行、列序按显式 order，相邻列间距精确等于 24
    const m1Pos = positionOf(m1);
    const m2Pos = positionOf(m2);
    expect(m1Pos.y).toBe(m2Pos.y);
    expect(m2Pos.x).toBeGreaterThan(m1Pos.x);
    expect(m2Pos.x - (m1Pos.x + widthM1)).toBe(24);

    // 自由节点绝对落位
    expect(positionOf(free)).toEqual({ x: 900, y: 900 });

    // 一次批量写入 = 一条撤销记录
    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
    // summary.moved 至少含 2 个组成员 + 自由节点（容器派生位置可能一并计入）
    expect(response.summary.moved).toBeGreaterThanOrEqual(3);
    for (const [nodeId, position] of Object.entries(response.positions)) {
      expect(positionOf(nodeId)).toEqual(position);
    }
  });

  it('containers 段：两个顶层容器按单列看板排布，派生框不重叠、历史 +1', async () => {
    const a1 = createMemberNodeViaStoreAction(0, 0);
    const groupA = await createGroupViaCli('看板组 A', [a1]);
    const b1 = createMemberNodeViaStoreAction(100, 100);
    const groupB = await createGroupViaCli('看板组 B', [b1]);

    const before = derivedFrames();
    const beforeA = before[groupA];
    const beforeB = before[groupB];
    if (beforeA === undefined || beforeB === undefined) throw new Error('建组后容器派生 entry 缺失');
    // 构造前提：整理前两容器相交（否则不覆盖看板平移路径）
    expect(rectsIntersect(asRect(beforeA), asRect(beforeB))).toBe(true);

    const historyBefore = useCanvasStore.getState().history.length;
    const planPath = writePlanFile({ containers: { columns: 1, gap: 120 } });
    const result = await layoutWithPlan(planPath);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }
    expect(response.plan_applied).toBe(true);
    expect(response.columns).toBeNull();
    expect(response.gap).toBeNull();

    const after = derivedFrames();
    const afterA = after[groupA];
    const afterB = after[groupB];
    if (afterA === undefined || afterB === undefined) throw new Error('排布后容器派生 entry 缺失');
    expect(rectsIntersect(asRect(afterA), asRect(afterB))).toBe(false);
    // 单列看板：两容器 x 相同（同一列）
    expect(afterA.position.x).toBe(afterB.position.x);

    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
  });

  it('dry-run：返回计划位置、画布零改动、零撤销记录、operation_id 为 null', async () => {
    const m1 = createMemberNodeViaStoreAction(100, 100);
    const m2 = createMemberNodeViaStoreAction(300, 200);
    const groupId = await createGroupViaCli('干跑组', [m1, m2]);
    const free = createMemberNodeViaStoreAction(5000, 5000);
    const before = snapshotPositions();
    const historyBefore = useCanvasStore.getState().history.length;

    const planPath = writePlanFile({
      groups: [{ group_id: groupId, columns: 2, gap: 24, order: [m1, m2] }],
      positions: { [free]: { x: 900, y: 900 } },
    });
    const result = await layoutWithPlan(planPath, ['--dry-run']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }
    expect(response.plan_applied).toBe(true);
    expect(response.dry_run).toBe(true);
    expect(response.operation_id).toBeNull();
    // 位置为计划值
    expect(response.positions[free]).toEqual({ x: 900, y: 900 });
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
    // 画布零改动
    expect(snapshotPositions()).toEqual(before);
  });

  it('非法计划（非法 JSON / schema 不符）：command_rejected，画布与历史均不变', async () => {
    const m1 = createMemberNodeViaStoreAction(100, 100);
    const groupId = await createGroupViaCli('非法计划组', [m1]);
    const before = snapshotPositions();
    const historyBefore = useCanvasStore.getState().history.length;

    const invalidJson = writePlanFile('{ "groups": [');
    const invalidJsonResult = await layoutWithPlan(invalidJson);
    expect(invalidJsonResult.exitCode).toBe(1);
    expect(parseCliFailure(invalidJsonResult).code).toBe('command_rejected');
    expect(parseCliFailure(invalidJsonResult).message).toContain('不是合法 JSON');

    const invalidSchema = writePlanFile({
      groups: [{ group_id: groupId, gap: -1 }],
    });
    const invalidSchemaResult = await layoutWithPlan(invalidSchema);
    expect(invalidSchemaResult.exitCode).toBe(1);
    expect(parseCliFailure(invalidSchemaResult).code).toBe('command_rejected');
    expect(parseCliFailure(invalidSchemaResult).message).toContain('计划文件格式不正确');

    expect(snapshotPositions()).toEqual(before);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
  });

  it('--plan 与 --scope 混用：用法错误（退出码 2），画布不变', async () => {
    const m1 = createMemberNodeViaStoreAction(100, 100);
    await createGroupViaCli('混用组', [m1]);
    const before = snapshotPositions();
    const historyBefore = useCanvasStore.getState().history.length;

    const planPath = writePlanFile({ positions: { [m1]: { x: 10, y: 10 } } });
    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--plan', planPath,
      '--scope', 'all',
      '--json',
    ]);

    // spec §5.3 / CLI-062：互斥按用法错误（退出码 2）拒绝，stderr 给出定位
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--plan');
    expect(snapshotPositions()).toEqual(before);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
  });

  it('positions 命中组内成员：command_rejected，零写入', async () => {
    const m1 = createMemberNodeViaStoreAction(100, 100);
    const m2 = createMemberNodeViaStoreAction(300, 200);
    const groupId = await createGroupViaCli('冲突组', [m1, m2]);
    const before = snapshotPositions();
    const historyBefore = useCanvasStore.getState().history.length;

    const planPath = writePlanFile({
      groups: [{ group_id: groupId, columns: 2, gap: 24 }],
      positions: { [m1]: { x: 1, y: 1 } },
    });
    const result = await layoutWithPlan(planPath);

    expect(result.exitCode).toBe(1);
    const failure = parseCliFailure(result);
    expect(failure.code).toBe('command_rejected');
    expect(failure.message).toContain('已被 groups/containers 覆盖');

    expect(snapshotPositions()).toEqual(before);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
  });
});
