// @spec: CLI-055
//
// `canvas layout --scope containers --pack` 契约形状（spec docs/integrations/CLI与本地Agent集成.md §5.3）：
// 参数新增 pack/gap、结果新增必填可空的 columns/gap。
//
// 从 cli-contract.test.ts 拆出（该文件已超出 max-lines 预算，本批不再加深）。

import { describe, expect, it } from 'vitest';

import {
  CliCommandRequestSchema,
  CliCommandResponseSchema,
  CliProxyCommandSchema,
} from '../src';

const PROJECT = 'pack-contract-project';

describe('canvas.layout pack 契约（CLI-055）', () => {
  it('pack 是布尔、gap 是非负整数（0 合法），负数/小数/非数值/字符串拒绝', () => {
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: PROJECT,
        scope: 'containers',
        pack: true,
        gap: 0,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_pack',
        scope: 'containers',
        pack: true,
        gap: 120,
        columns: 2,
        order: ['g2', 'g1'],
      }).success,
    ).toBe(true);
    for (const badGap of [-1, 1.5, '120', null]) {
      expect(
        CliCommandRequestSchema.safeParse({
          command: 'canvas.layout',
          project: PROJECT,
          scope: 'containers',
          pack: true,
          gap: badGap,
        }).success,
        String(badGap),
      ).toBe(false);
    }
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: PROJECT,
        scope: 'containers',
        pack: 'yes',
      }).success,
    ).toBe(false);
  });

  it('结果 columns/gap 必填可空：pack 为数字、非 pack 为 null，缺字段或非法值拒绝', () => {
    const trailer = {
      summary: { inspected: 2, moved: 2, unchanged: 0, skipped: [] },
      operation_id: 'op-pack',
      dry_run: false,
    };
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.layout',
        ok: true,
        positions: { g1: { x: 0, y: 0 } },
        columns: 2,
        gap: 120,
        ...trailer,
      }).success,
    ).toBe(true);
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.layout',
        ok: true,
        positions: {},
        columns: null,
        gap: null,
        ...trailer,
      }).success,
    ).toBe(true);
    // 缺 columns/gap 即拒绝（必填可空，不是 optional）
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.layout',
        ok: true,
        positions: {},
        ...trailer,
      }).success,
    ).toBe(false);
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.layout',
        ok: true,
        positions: {},
        columns: 0,
        gap: -1,
        ...trailer,
      }).success,
    ).toBe(false);
  });

  it('整理结果新增 content_reordered / order_changes（批次 1a）：合法形状 parse、旧响应按 false/[] 兜底', () => {
    const trailer = {
      summary: { inspected: 2, moved: 2, cascaded: 0, unchanged: 0, skipped: [] },
      operation_id: 'op-order',
      dry_run: false,
    };
    const parsed = CliCommandResponseSchema.safeParse({
      command: 'canvas.layout',
      ok: true,
      positions: { g1: { x: 0, y: 0 } },
      columns: 1,
      gap: 120,
      content_reordered: true,
      order_changes: [
        { node_id: 'g1', from_slot: 2, to_slot: 0 },
        { node_id: 'g2', from_slot: 0, to_slot: 1 },
      ],
      ...trailer,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.ok !== true || parsed.data.command !== 'canvas.layout') {
      throw new Error('unreachable');
    }
    expect(parsed.data.content_reordered).toBe(true);
    expect(parsed.data.order_changes).toHaveLength(2);
    // 旧响应缺这两个键：解析成功并按 false / 空数组兜底
    const legacy = CliCommandResponseSchema.safeParse({
      command: 'canvas.layout',
      ok: true,
      positions: {},
      columns: null,
      gap: null,
      summary: { inspected: 0, moved: 0, unchanged: 0, skipped: [] },
      operation_id: null,
      dry_run: true,
    });
    expect(legacy.success).toBe(true);
    if (!legacy.success || legacy.data.ok !== true || legacy.data.command !== 'canvas.layout') {
      throw new Error('unreachable');
    }
    expect(legacy.data.content_reordered).toBe(false);
    expect(legacy.data.order_changes).toEqual([]);
    // 非法槽位（负数/小数）被拒绝
    for (const order_changes of [
      [{ node_id: 'g1', from_slot: -1, to_slot: 0 }],
      [{ node_id: 'g1', from_slot: 0, to_slot: 1.5 }],
      [{ node_id: '', from_slot: 0, to_slot: 1 }],
    ]) {
      expect(
        CliCommandResponseSchema.safeParse({
          command: 'canvas.layout',
          ok: true,
          positions: {},
          columns: null,
          gap: null,
          content_reordered: true,
          order_changes,
          ...trailer,
        }).success,
        JSON.stringify(order_changes),
      ).toBe(false);
    }
  });
});
