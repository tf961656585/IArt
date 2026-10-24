// @spec: CLI-030, CLI-048
import { describe, expect, it } from 'vitest';

import { CliCanvasLayoutParamsSchema } from '../src/cli-canvas-contract';
import {
  CliCanvasLayoutPlanGroupSchema,
  CliCanvasLayoutPlanSchema,
} from '../src/cli-canvas-plan-contract';
import { CliCommandRequestSchema, CliProxyCommandSchema } from '../src/cli-contract';

/**
 * `canvas layout --plan` 计划文件契约测试（批次 1b 共享层）。
 *
 * 口径：计划文件是严格 schema（未知键拒绝），三段均可选；冲突规则（目标必须是
 * 已存在顶层容器、显式坐标不得命中容器或已被覆盖节点等）由执行侧裁定，schema
 * 只承载形状，不把业务语义降级成边界解析失败。
 */

const FULL_PLAN = {
  groups: [
    { group_id: 'g1', columns: 4, gap: 24, order: ['n1', 'n2'], order_mode: 'position' },
  ],
  containers: { columns: 4, gap: 120, order: ['c1', 'c2'], order_mode: 'position' },
  positions: { n9: { x: 100, y: 200 } },
};

describe('CliCanvasLayoutPlanSchema（计划文件严格形状）', () => {
  it('完整示例 parse 成功', () => {
    expect(CliCanvasLayoutPlanSchema.safeParse(FULL_PLAN).success).toBe(true);
  });

  it('三段均可选：空对象即 no-op，parse 通过', () => {
    expect(CliCanvasLayoutPlanSchema.safeParse({}).success).toBe(true);
  });

  it('未知键被拒绝（根 / groups 条目 / containers / positions 值）', () => {
    const cases: unknown[] = [
      { ...FULL_PLAN, extra: 1 },
      { groups: [{ group_id: 'g1', unknown_key: true }] },
      { containers: { columns: 2, extra: 1 } },
      { positions: { n9: { x: 1, y: 2, z: 3 } } },
    ];
    for (const value of cases) {
      expect(CliCanvasLayoutPlanSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('非法枚举 / 负 gap / 小数 gap / 空 group_id / 非数字坐标 parse 失败', () => {
    const cases: unknown[] = [
      // created 不在计划文件支持范围（仅 position/insertion）
      { groups: [{ group_id: 'g1', order_mode: 'created' }] },
      { groups: [{ group_id: 'g1', order_mode: 'random' }] },
      { containers: { order_mode: 'created' } },
      { groups: [{ group_id: 'g1', gap: -1 }] },
      { groups: [{ group_id: 'g1', gap: 1.5 }] },
      { containers: { gap: -10 } },
      { groups: [{ group_id: '' }] },
      { containers: { columns: 0 } },
      { positions: { n9: { x: '100', y: 200 } } },
      { positions: { n9: { x: 100 } } },
      { positions: { '': { x: 1, y: 2 } } },
      { positions: { n9: { x: 1, y: 2 }, n9b: { x: 1, y: 2, z: 3 } } },
      { groups: [{ group_id: 'g1', order: [] }] },
    ];
    for (const value of cases) {
      expect(CliCanvasLayoutPlanSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('单组条目可只带 group_id（其余字段由执行侧按缺省兜底）', () => {
    expect(CliCanvasLayoutPlanGroupSchema.safeParse({ group_id: 'g1' }).success).toBe(true);
  });
});

describe('canvas layout 参数与代理通道携带计划（批次 1b）', () => {
  it('layout params 可无 scope 带 plan_path（dry_run 两种模式都可用）', () => {
    expect(CliCanvasLayoutParamsSchema.safeParse({ plan_path: '/tmp/plan.json' }).success).toBe(true);
    expect(CliCanvasLayoutParamsSchema.safeParse({ plan_path: '/tmp/plan.json', dry_run: true }).success).toBe(true);
    expect(CliCanvasLayoutParamsSchema.safeParse({ plan_path: '' }).success).toBe(false);
  });

  it('命令面 canvas.layout 带 plan_path、代理通道 canvas.layout 带 plan 均 parse 成功', () => {
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: 'demo',
        plan_path: '/tmp/plan.json',
        dry_run: true,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_plan',
        plan_path: '/tmp/plan.json',
        plan: FULL_PLAN,
      }).success,
    ).toBe(true);
  });

  it('不带 plan 的旧形状仍 parse 通过（既有 --scope 行为不变）', () => {
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.layout', project: 'demo', scope: 'all' }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.layout', request_id: 'req_old', scope: { group: 'g1' } })
        .success,
    ).toBe(true);
  });
});
