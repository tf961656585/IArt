// @spec: CLI-014, CLI-051
import { describe, expect, it } from 'vitest';

import {
  CliCommandResponseSchema,
  CliProxyCommandErrorSchema,
  CliProxyCommandResultSchema,
  CliProxyCommandSchema,
} from '../src/cli-contract';

/**
 * 画布场景图契约测试（`canvas.inspect` 结果与 `canvas.geometry.get` 代理结果）。
 *
 * 从 cli-contract.test.ts 拆出（行数预算）：命令清单与通用样例仍在该文件；本文件只承载
 * 整张画布场景图的形状边界（必填、strict、可空、错误变体）。
 */

const PROJECT = '/tmp/demo-project';

const sceneResult = () => ({
  command: 'canvas.inspect',
  ok: true,
  fidelity: 'derived',
  nodes: [
    {
      node_id: 'node_1',
      node_type: 'asset',
      name: '结果图',
      position: { x: 10, y: 20 },
      size: { width: 320, height: 240 },
      bbox: { x: 10, y: 20, width: 320, height: 240 },
      group_id: 'group_1',
      asset_id: 'asset_1',
      task_id: 'task_1',
      batch_id: 'batch_1',
      created_at: '2026-10-07T00:00:00.000Z',
      prompt_preview: '一只猫在窗台',
      source_file_name: 'cat.png',
      asset: {
        asset_id: 'asset_1',
        media_type: 'image',
        width: 1024,
        height: 768,
        file_name: 'cat.png',
        batch_id: 'batch_1',
        task_id: 'task_1',
        model_id: 'model-a',
        prompt_preview: '一只猫在窗台',
        created_at: '2026-10-07T00:00:00.000Z',
        local_file_path: '/tmp/media/cat.png',
      },
    },
  ],
  containers: [
    {
      group_node_id: 'group_1',
      name: '角色组',
      type: 'group',
      member_ids: ['node_1'],
      position: { x: -2, y: -20 },
      size: { width: 334, height: 280 },
      bbox: { x: -2, y: -20, width: 334, height: 280 },
      collapsed: false,
      nearest_neighbor: null,
    },
  ],
  assets_not_on_canvas: [
    { asset_id: 'asset_2', media_type: 'video', file_name: null, created_at: null, batch_id: null },
  ],
  viewport: { x: 0, y: 0, zoom: 1, width: 1600, height: 900 },
  selection: { node_ids: ['node_1'], annotation_ids: [] },
  annotations: [
    {
      annotation_id: 'anno_1',
      content: '这张要放大看',
      position: { x: 0, y: 0 },
      size: { width: 240, height: 120 },
      bound_to_node_id: 'node_1',
    },
  ],
  overlaps: [{ a_id: 'group_1', b_id: 'group_2', overlap_width: 20, overlap_height: 30 }],
  min_gap: { a_id: 'group_1', b_id: 'group_2', gap: -20 },
});

describe('canvas.inspect 结果契约', () => {
  it('完整场景图 parse 通过；derived 下视口/选中态可为 null', () => {
    expect(CliCommandResponseSchema.safeParse(sceneResult()).success).toBe(true);
    expect(
      CliCommandResponseSchema.safeParse({
        ...sceneResult(),
        fidelity: 'derived',
        viewport: null,
        selection: null,
      }).success,
    ).toBe(true);
  });

  it('fidelity 枚举之外的值、缺必填集合、节点缺 bbox 均被拒绝（strict）', () => {
    expect(CliCommandResponseSchema.safeParse({ ...sceneResult(), fidelity: 'approx' }).success).toBe(false);
    const withoutUnplaced: Record<string, unknown> = { ...sceneResult() };
    delete withoutUnplaced.assets_not_on_canvas;
    expect(CliCommandResponseSchema.safeParse(withoutUnplaced).success).toBe(false);
    const node = sceneResult().nodes[0];
    if (node === undefined) throw new Error('unexpected');
    const withoutBBox: Record<string, unknown> = { ...node };
    delete withoutBBox.bbox;
    expect(
      CliCommandResponseSchema.safeParse({ ...sceneResult(), nodes: [withoutBBox] }).success,
    ).toBe(false);
    // 容器 type 只接受 group / agent_container
    const container = sceneResult().containers[0];
    if (container === undefined) throw new Error('unexpected');
    expect(
      CliCommandResponseSchema.safeParse({
        ...sceneResult(),
        containers: [{ ...container, type: 'canvas' }],
      }).success,
    ).toBe(false);
  });

  it('批次 1a 新增字段：节点创建时间/提示词/来源文件名、视口尺寸、注释、重叠与最小间距', () => {
    const parsed = CliCommandResponseSchema.safeParse(sceneResult());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.ok !== true || parsed.data.command !== 'canvas.inspect') {
      throw new Error('unreachable');
    }
    expect(parsed.data.viewport).toEqual({ x: 0, y: 0, zoom: 1, width: 1600, height: 900 });
    const node = parsed.data.nodes[0];
    expect(node?.created_at).toBe('2026-10-07T00:00:00.000Z');
    expect(node?.prompt_preview).toBe('一只猫在窗台');
    expect(node?.source_file_name).toBe('cat.png');
    // 资产节点也填节点级 batch_id / task_id（执行侧取 data.sourceBatchId / sourceTaskId）
    expect(node?.batch_id).toBe('batch_1');
    expect(node?.task_id).toBe('task_1');
    expect(parsed.data.annotations).toHaveLength(1);
    expect(parsed.data.overlaps).toHaveLength(1);
    expect(parsed.data.min_gap).toEqual({ a_id: 'group_1', b_id: 'group_2', gap: -20 });
    // 注释绑定目标可空
    expect(
      CliCommandResponseSchema.safeParse({
        ...sceneResult(),
        annotations: [
          { annotation_id: 'anno_2', content: '', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, bound_to_node_id: null },
        ],
      }).success,
    ).toBe(true);
    // 容器最近邻形状：gap 可为负（相交）
    const container = sceneResult().containers[0];
    if (container === undefined) throw new Error('unexpected');
    expect(
      CliCommandResponseSchema.safeParse({
        ...sceneResult(),
        containers: [{ ...container, nearest_neighbor: { node_id: 'group_2', gap: -20 } }],
      }).success,
    ).toBe(true);
    expect(
      CliCommandResponseSchema.safeParse({
        ...sceneResult(),
        containers: [{ ...container, nearest_neighbor: { node_id: 'group_2' } }],
      }).success,
    ).toBe(false);
    // 视口尺寸独立可空
    expect(
      CliCommandResponseSchema.safeParse({
        ...sceneResult(),
        viewport: { x: 0, y: 0, zoom: 1, width: null, height: null },
      }).success,
    ).toBe(true);
  });

  it('旧响应（缺批次 1a 新字段）仍 parse 成功：新字段按 null/空集合/0 兜底', () => {
    const base = sceneResult();
    const node = base.nodes[0];
    const container = base.containers[0];
    if (node === undefined || container === undefined) throw new Error('unexpected');
    const legacyNode: Record<string, unknown> = { ...node };
    delete legacyNode.created_at;
    delete legacyNode.prompt_preview;
    delete legacyNode.source_file_name;
    const legacyContainer: Record<string, unknown> = { ...container };
    delete legacyContainer.nearest_neighbor;
    const legacyResult: Record<string, unknown> = { ...base };
    delete legacyResult.annotations;
    delete legacyResult.overlaps;
    delete legacyResult.min_gap;
    const parsed = CliCommandResponseSchema.safeParse({
      ...legacyResult,
      nodes: [legacyNode],
      containers: [legacyContainer],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.ok !== true || parsed.data.command !== 'canvas.inspect') {
      throw new Error('unreachable');
    }
    expect(parsed.data.nodes[0]?.created_at).toBeNull();
    expect(parsed.data.nodes[0]?.prompt_preview).toBeNull();
    expect(parsed.data.nodes[0]?.source_file_name).toBeNull();
    expect(parsed.data.containers[0]?.nearest_neighbor).toBeNull();
    expect(parsed.data.viewport).toEqual({ x: 0, y: 0, zoom: 1, width: null, height: null });
    expect(parsed.data.annotations).toEqual([]);
    expect(parsed.data.overlaps).toEqual([]);
    expect(parsed.data.min_gap).toBeNull();
  });
});

describe('canvas.geometry.get 代理契约', () => {
  const snapshot = {
    sizes: { node_1: { width: 320, height: 240 }, group_1: { width: 334, height: 280 } },
    containers: { group_1: { position: { x: -2, y: -20 }, size: { width: 334, height: 280 } } },
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: { node_ids: ['node_1'], annotation_ids: [] },
  };

  it('请求仅 request_id（携带 project 等额外字段被拒绝）', () => {
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.geometry.get', request_id: 'req_g1' }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.geometry.get', request_id: 'req_g1', project: PROJECT })
        .success,
    ).toBe(false);
    expect(CliProxyCommandSchema.safeParse({ command: 'canvas.geometry.get' }).success).toBe(false);
  });

  it('结果携带几何快照且 request_id 配对；缺快照字段被拒绝', () => {
    expect(
      CliProxyCommandResultSchema.safeParse({ command: 'canvas.geometry.get', request_id: 'req_g1', ...snapshot })
        .success,
    ).toBe(true);
    // 视口/选中态可为 null（画布尚未就绪）
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.geometry.get',
        request_id: 'req_g1',
        sizes: {},
        containers: {},
        viewport: null,
        selection: null,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({ command: 'canvas.geometry.get', request_id: 'req_g1', sizes: {} }).success,
    ).toBe(false);
  });

  it('防御性错误变体原路回错误码（§9 枚举）', () => {
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.geometry.get',
        request_id: 'req_g1',
        error: { code: 'internal_error', message: '意外失败' },
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.geometry.get',
        request_id: 'req_g1',
        error: { code: 'unknown_code', message: 'x' },
      }).success,
    ).toBe(false);
  });
});
