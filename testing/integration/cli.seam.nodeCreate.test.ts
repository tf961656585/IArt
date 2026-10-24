// @vitest-environment node
// @spec: CLI-056
//
// CLI 与本地 Agent 集成 · 资产回填画布（canvas node create）主链接缝：
// CLI 客户端 → 真实控制服务 → 执行器（真实存储投影：生成来源索引 / 资产清单）→
// 代理通道 → 真实画布接收器 → 真实 store addNode。
//
// 两端真实，只在最外层挡掉 Electron 窗口传输层（cli.seam.harness 既有台架）；资产与生成
// 来源由 harness 的存储投影 fixture 提供（与生产 read-model 读取同一注入面）。
// 断言覆盖：创建成功（资产节点 + 来源三字段 + 一条撤销记录 + operation_id 拒按操作撤销）、
// dry-run 零副作用、canvas inspect 能读到新节点、asset list --on-canvas 双向过滤与 batch_id。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AssetNodeData } from '@/features/canvas/types/node';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import {
  OPEN_PROJECT_NAME,
  SEAM_GENERATED_ASSET_ID,
  SEAM_GENERATION_BATCH_ID,
  SEAM_IMPORTED_ASSET_ID,
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

const createNodeViaCli = async (assetId: string, extra: readonly string[] = []) =>
  runCli(['canvas', 'node', 'create', '--project', OPEN_PROJECT_NAME, '--asset', assetId, ...extra, '--json']);

const findAssetNode = (nodeId: string): AssetNodeData | null => {
  const node = (useCanvasStore.getState().nodeGraph?.nodes ?? []).find(
    (candidate) => candidate.id === nodeId && candidate.type === 'asset',
  );
  return node === undefined ? null : (node.data as AssetNodeData);
};

describe('canvas node create 全链（CLI-056）', () => {
  it('创建资产节点：来源三字段落画布、一条撤销记录；canvas inspect 能读到该节点', async () => {
    const historyBefore = useCanvasStore.getState().history.length;
    const result = await createNodeViaCli(SEAM_GENERATED_ASSET_ID);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.node.create') {
      throw new Error(`expected canvas.node.create success response, got ${result.stdout}`);
    }
    expect(response.dry_run).toBe(false);
    expect(response.asset_id).toBe(SEAM_GENERATED_ASSET_ID);
    expect(typeof response.node_id).toBe('string');
    expect(typeof response.operation_id).toBe('string');

    const nodeId = response.node_id;
    if (nodeId === null) throw new Error('expected real node id');
    // 真实 store：资产节点 + 生成来源（批次/任务/模型由主进程反查后随代理命令补充）
    expect(findAssetNode(nodeId)).toMatchObject({
      assetId: SEAM_GENERATED_ASSET_ID,
      mediaType: 'image',
      sourceBatchId: SEAM_GENERATION_BATCH_ID,
      sourceTaskId: 'task-seam-1',
      sourceModelId: 'model-seam',
    });
    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);

    // 新节点可被 canvas inspect 读到（存储投影读的是真实 store 现值）
    const inspect = await runCli(['canvas', 'inspect', '--project', OPEN_PROJECT_NAME, '--json']);
    expect(inspect.exitCode).toBe(0);
    const inspected = parseCliResponse(inspect);
    if (!inspected.ok || inspected.command !== 'canvas.inspect') {
      throw new Error(`expected canvas.inspect success response, got ${inspect.stdout}`);
    }
    const inspectedNode = inspected.nodes.find((node) => node.node_id === nodeId);
    expect(inspectedNode).toMatchObject({
      node_type: 'asset',
      asset_id: SEAM_GENERATED_ASSET_ID,
    });
    expect(inspectedNode?.batch_id).toBe(SEAM_GENERATION_BATCH_ID);
    // 默认紧凑模式不返回嵌套资产摘要；节点级 batch_id 已承载来源批次。
    expect(inspectedNode?.asset).toBeNull();

    // --full 才返回嵌套资产摘要（批次 1a 默认精简、细节按需展开）。
    const fullInspect = await runCli([
      'canvas', 'inspect', '--project', OPEN_PROJECT_NAME, '--full', '--json',
    ]);
    expect(fullInspect.exitCode).toBe(0);
    const fullInspected = parseCliResponse(fullInspect);
    if (!fullInspected.ok || fullInspected.command !== 'canvas.inspect') {
      throw new Error(`expected canvas.inspect --full success response, got ${fullInspect.stdout}`);
    }
    const fullNode = fullInspected.nodes.find((node) => node.node_id === nodeId);
    expect(fullNode?.asset?.batch_id).toBe(SEAM_GENERATION_BATCH_ID);
    // 已上画布的资产不再出现在未落画布清单；导入素材仍是未上画布（batch_id 为 null）
    const unplacedIds = inspected.assets_not_on_canvas.map((asset) => asset.asset_id);
    expect(unplacedIds).not.toContain(SEAM_GENERATED_ASSET_ID);
    expect(unplacedIds).toContain(SEAM_IMPORTED_ASSET_ID);
    expect(
      inspected.assets_not_on_canvas.find((asset) => asset.asset_id === SEAM_IMPORTED_ASSET_ID)?.batch_id,
    ).toBeNull();
  });

  it('operation_id 属创建类：canvas undo 以 command_rejected 拒绝（不支持按操作撤销）', async () => {
    const created = await createNodeViaCli(SEAM_GENERATED_ASSET_ID);
    const response = parseCliResponse(created);
    if (!response.ok || response.command !== 'canvas.node.create' || response.operation_id === null) {
      throw new Error(`expected create response with operation id, got ${created.stdout}`);
    }
    const undo = await runCli([
      'canvas', 'undo',
      '--project', OPEN_PROJECT_NAME,
      '--operation', response.operation_id,
      '--json',
    ]);
    expect(undo.exitCode).toBe(1);
    expect(parseCliFailure(undo).code).toBe('command_rejected');
  });

  it('dry-run 零副作用：不建节点、不写撤销记录，node_id/operation_id 为 null', async () => {
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;
    const historyBefore = useCanvasStore.getState().history.length;
    const result = await createNodeViaCli(SEAM_IMPORTED_ASSET_ID, ['--dry-run']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.node.create') {
      throw new Error(`expected create response, got ${result.stdout}`);
    }
    expect(response.dry_run).toBe(true);
    expect(response.node_id).toBeNull();
    expect(response.operation_id).toBeNull();
    expect(useCanvasStore.getState().nodeGraph?.nodes.length ?? 0).toBe(nodesBefore);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
  });

  it('asset list --on-canvas 双向过滤：node_ids join 与 batch_id 走真实存储投影', async () => {
    const created = await createNodeViaCli(SEAM_GENERATED_ASSET_ID);
    const response = parseCliResponse(created);
    if (!response.ok || response.command !== 'canvas.node.create' || response.node_id === null) {
      throw new Error(`expected create response, got ${created.stdout}`);
    }
    const nodeId = response.node_id;

    const onCanvas = await runCli([
      'asset', 'list', '--project', OPEN_PROJECT_NAME, '--on-canvas', 'true', '--json',
    ]);
    expect(onCanvas.exitCode).toBe(0);
    const onCanvasResponse = parseCliResponse(onCanvas);
    if (!onCanvasResponse.ok || onCanvasResponse.command !== 'asset.list') {
      throw new Error(`expected asset.list response, got ${onCanvas.stdout}`);
    }
    expect(onCanvasResponse.assets).toHaveLength(1);
    expect(onCanvasResponse.assets[0]).toMatchObject({
      asset_id: SEAM_GENERATED_ASSET_ID,
      node_ids: [nodeId],
      batch_id: SEAM_GENERATION_BATCH_ID,
    });

    const offCanvas = await runCli([
      'asset', 'list', '--project', OPEN_PROJECT_NAME, '--on-canvas', 'false', '--json',
    ]);
    expect(offCanvas.exitCode).toBe(0);
    const offCanvasResponse = parseCliResponse(offCanvas);
    if (!offCanvasResponse.ok || offCanvasResponse.command !== 'asset.list') {
      throw new Error(`expected asset.list response, got ${offCanvas.stdout}`);
    }
    expect(offCanvasResponse.assets).toHaveLength(1);
    expect(offCanvasResponse.assets[0]).toMatchObject({
      asset_id: SEAM_IMPORTED_ASSET_ID,
      node_ids: [],
      batch_id: null,
    });
  });
});
