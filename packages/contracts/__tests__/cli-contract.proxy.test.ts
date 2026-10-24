// @spec: CLI-014, CLI-027, CLI-028, CLI-029, CLI-030, CLI-048, CLI-051
import { describe, expect, it } from 'vitest';

import {
  CliCommandResponseSchema,
  CliProxyCommandErrorSchema,
  CliProxyCommandResultSchema,
  CliProxyCommandSchema,
} from '../src/cli-contract';
import { ISO, PROJECT } from './fixtures/cli-contract-samples';

/**
 * 代理执行通道契约测试。
 *
 * 口径：docs/integrations/CLI与本地Agent集成.md §6.3 代理执行通道。
 * - 代理命令与 B 命令面同形（不带 project），request_id 必填；
 * - 结果与错误原路返回，错误复用 §9 错误码。
 */

describe('代理执行通道命令契约（spec §6.3）', () => {
  it('五类命令的合法样例 parse 通过', () => {
    // 素材导入（CLI-047）：file 为路径列表（至少一个），参数与 B 命令面同形。
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'asset.import',
        request_id: 'req_0',
        file: ['/tmp/media/a.png'],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.group.create',
        request_id: 'req_1',
        name: '角色组',
        members: ['node_1'],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_2',
        scope: { group: 'group_1' },
        columns: 4,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'task.cancel', request_id: 'req_3', task_id: 'task_1' }).success,
    ).toBe(true);
    // generate：参数与 B 命令面共享同一 schema（prompt/model 必填，count/ref/arg/wait 可选）。
    // ref 为结构化引用条目（素材标识 + 可选用途）：带用途与不带用途两种形状都要能 parse。
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'generate',
        request_id: 'req_4',
        prompt: '一只猫在窗台',
        model: 'model-a',
        count: 2,
        ref: [{ asset_id: 'asset_1', slot_id: 'first_frame' }, { asset_id: 'asset_2' }],
        arg: [{ key: 'size', value: '1024x1024' }],
      }).success,
    ).toBe(true);
    // 画布状态只读查询（spec §6.3 只读查询条款 / §5.5）：仅 request_id，无任何参数。
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.selection.get', request_id: 'req_5' }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.selection.get', request_id: 'req_5', node_ids: ['n'] })
        .success,
    ).toBe(false);
    // 整张画布几何只读查询（canvas.inspect exact 合并输入）：仅 request_id，无参数。
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.geometry.get', request_id: 'req_g1' }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.geometry.get', request_id: 'req_g1', project: PROJECT })
        .success,
    ).toBe(false);
  });

  it('request_id 必填、参数与命令面同形、误判别值被拒绝', () => {
    expect(CliProxyCommandSchema.safeParse({ command: 'canvas.group.create', name: 'g', members: ['n'] }).success).toBe(false);
    // members 空数组合法（CLI-044 空组建组）；request_id 缺失仍被拒绝
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.create', request_id: 'r', name: 'g', members: [] }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.create', name: 'g', members: [] }).success,
    ).toBe(false);
    expect(CliProxyCommandSchema.safeParse({ command: 'canvas.nodes.list', request_id: 'r' }).success).toBe(false);
    // generate：代理命令不带 project（项目上下文由画布窗口承载），prompt/model 必填
    expect(CliProxyCommandSchema.safeParse({ command: 'generate', request_id: 'r', prompt: 'x' }).success).toBe(false);
    expect(CliProxyCommandSchema.safeParse({ command: 'generate', request_id: 'r', model: 'm' }).success).toBe(false);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'generate', request_id: 'r', prompt: 'x', model: 'm', count: 0 }).success,
    ).toBe(false);
  });

  it('结果与错误原路返回：request_id 对齐，错误复用 §9 错误码（含 command_rejected）', () => {
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.create',
        request_id: 'req_1',
        group_node_id: 'group_9',
        member_ids: ['node_1'],
        operation_id: 'op-create',
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_2',
        positions: { node_1: { x: 1, y: 2 } },
        columns: null,
        gap: null,
        summary: { inspected: 1, moved: 1, unchanged: 0, skipped: [] },
        operation_id: 'op-layout',
        dry_run: false,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'task.cancel',
        request_id: 'req_3',
        accepted: true,
        task_id: 'task_1',
        cancelled_at: ISO,
      }).success,
    ).toBe(true);
    // generate 受理结果与 B 命令面同形状（批次标识 + 任务身份列表，无 task_results；CLI-046 投影身份）。
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'generate',
        request_id: 'req_4',
        batch_id: 'batch_1',
        tasks: [{ task_id: 'task_1', task_index: 0, node_id: 'node_t1', group_id: null }],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'generate',
        request_id: 'req_4',
        batch_id: 'batch_1',
        tasks: [{ task_id: 'task_1', task_index: 0 }],
      }).success,
    ).toBe(false);
    // 原子受理恒 ≥1：空任务列表被拒绝。
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'generate',
        request_id: 'req_4',
        batch_id: 'batch_1',
        tasks: [],
      }).success,
    ).toBe(false);
    // 画布状态只读查询结果：分类型选中集合；画布尚未就绪为 null（spec CLI-021）。
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.selection.get',
        request_id: 'req_5',
        selection: { node_ids: ['node_1'], annotation_ids: ['anno_1'] },
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.selection.get',
        request_id: 'req_5',
        selection: null,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.selection.get',
        request_id: 'req_5',
      }).success,
    ).toBe(false);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.group.create',
        request_id: 'req_1',
        error: { code: 'command_rejected', message: '成员节点不存在' },
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.selection.get',
        request_id: 'req_5',
        error: { code: 'internal_error', message: '意外失败' },
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'generate',
        request_id: 'req_4',
        error: { code: 'invalid_reference', message: '引用的素材 asset_1 不可用' },
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_2',
        error: { code: 'unknown_code', message: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('代理执行通道画布操作命令契约（spec §6.3，CLI-027/028/029/030）', () => {
  it('三条新命令的代理请求 parse 通过：参数与命令面同形、不带 project', () => {
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.dissolve', request_id: 'req_d1', group: 'group_1' })
        .success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.node.move',
        request_id: 'req_d2',
        node: 'node_1',
        x: -120,
        y: 240.5,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.node.delete',
        request_id: 'req_d3',
        nodes: ['node_1'],
        yes: true,
      }).success,
    ).toBe(true);
    // 不带 project（项目上下文由画布窗口承载）；request_id 缺失被拒绝
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.dissolve', group: 'g' }).success,
    ).toBe(false);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.node.delete', request_id: 'r', nodes: [] }).success,
    ).toBe(false);
  });

  it('canvas.layout 代理命令携带可选 order：缺省与既有形状一致（CLI-030）', () => {
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.layout', request_id: 'req_o1', scope: 'all', order: ['n3', 'n1'] })
        .success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.layout', request_id: 'req_o2', scope: 'all' }).success,
    ).toBe(true);
  });

  it('canvas.layout 代理命令携带可选 plan（批次 1b）：计划内容随代理命令下发', () => {
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_plan_1',
        plan_path: '/tmp/plan.json',
        plan: {
          groups: [{ group_id: 'g1', columns: 2, gap: 24, order: ['n1', 'n2'], order_mode: 'position' }],
          containers: { columns: 3, gap: 80, order_mode: 'insertion' },
          positions: { n9: { x: 100, y: 200 } },
        },
      }).success,
    ).toBe(true);
    // 旧形状（不带 plan）仍 parse 通过
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.layout', request_id: 'req_plan_2', scope: 'all' }).success,
    ).toBe(true);
    // 计划内容形状非法（负 gap）被拒绝
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_plan_3',
        plan_path: '/tmp/plan.json',
        plan: { groups: [{ group_id: 'g1', gap: -1 }] },
      }).success,
    ).toBe(false);
  });

  it('三条新命令的代理结果 parse 通过：成员列表 / 最终坐标与位移集合 / 实删集合', () => {
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.dissolve',
        request_id: 'req_d1',
        dissolved: true,
        group_node_id: 'group_1',
        member_ids: ['node_1', 'node_2'],
        operation_id: 'op-dissolve',
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.node.move',
        request_id: 'req_d2',
        node_id: 'node_1',
        position: { x: -120, y: 240.5 },
        moved_node_ids: ['node_1'],
        summary: { inspected: 1, moved: 1, unchanged: 0, skipped: [] },
        operation_id: 'op-move',
        dry_run: false,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.node.delete',
        request_id: 'req_d3',
        deleted: true,
        deleted_node_ids: ['node_1'],
        operation_id: 'op-delete',
      }).success,
    ).toBe(true);
    // 缺结果字段被拒绝
    expect(
      CliProxyCommandResultSchema.safeParse({ command: 'canvas.group.dissolve', request_id: 'r', dissolved: true })
        .success,
    ).toBe(false);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.node.move',
        request_id: 'r',
        node_id: 'n',
        position: { x: 0, y: 0 },
      }).success,
    ).toBe(false);
  });

  it('三条新命令的代理错误与 B 命令面错误响应 parse 通过（错误码走 §9 枚举）', () => {
    for (const command of ['canvas.group.dissolve', 'canvas.node.move', 'canvas.node.delete']) {
      expect(
        CliProxyCommandErrorSchema.safeParse({
          command,
          request_id: 'req_e1',
          error: { code: 'node_not_found', message: '画布上找不到这些节点。' },
        }).success,
      ).toBe(true);
      expect(
        CliCommandResponseSchema.safeParse({
          command,
          ok: false,
          error: { code: 'command_rejected', message: '被画布侧校验拦截。' },
        }).success,
      ).toBe(true);
    }
  });
});

describe('代理执行通道组成员命令契约（spec §6.3 / CLI-049）', () => {
  it('canvas.group.add / remove 的代理请求与结果 parse 通过，缺字段被拒绝', () => {
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.group.add',
        request_id: 'req_a1',
        group: 'group_1',
        members: ['node_1', 'node_2'],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.group.remove',
        request_id: 'req_r1',
        group: 'group_1',
        members: ['node_1'],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.add', request_id: 'r', group: 'g', members: [] })
        .success,
    ).toBe(false);

    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.add',
        request_id: 'req_a1',
        group_node_id: 'group_1',
        added_node_ids: ['node_1'],
        moved_node_ids: ['node_2'],
        unchanged_node_ids: ['node_3'],
        operation_id: 'op-add',
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.add',
        request_id: 'req_a1',
        group_node_id: 'group_1',
        added_node_ids: ['node_1'],
      }).success,
    ).toBe(false);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.remove',
        request_id: 'req_r1',
        group_node_id: 'group_1',
        removed_node_ids: ['node_1'],
        operation_id: 'op-remove',
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.group.remove',
        request_id: 'req_r1',
        error: { code: 'command_rejected', message: '这些节点当前不属于这个组。' },
      }).success,
    ).toBe(true);
  });
});

describe('代理执行通道批次 1a 形状（nodes move 双族 / layout 顺序报告）', () => {
  it('canvas.nodes.move 相对族与绝对坐标族在代理通道同形；request_id 必填', () => {
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.nodes.move',
        request_id: 'req_rel',
        nodes: ['n1'],
        dx: 10,
        dy: -10,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.nodes.move',
        request_id: 'req_abs',
        positions: [{ node_id: 'n1', x: 0, y: 0 }],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.nodes.move',
        positions: [{ node_id: 'n1', x: 0, y: 0 }],
      }).success,
    ).toBe(false);
  });

  it('canvas.layout 代理结果携带 content_reordered / order_changes 与 summary.cascaded', () => {
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_l1',
        positions: { n1: { x: 0, y: 0 } },
        columns: 2,
        gap: 120,
        content_reordered: true,
        order_changes: [{ node_id: 'n1', from_slot: 1, to_slot: 0 }],
        summary: { inspected: 2, moved: 2, cascaded: 1, unchanged: 0, skipped: [] },
        operation_id: 'op-l1',
        dry_run: false,
      }).success,
    ).toBe(true);
  });
});

describe('代理执行通道组重命名契约（spec §6.3 / CLI-057）', () => {
  it('canvas.group.rename 的代理请求 / 结果 / 错误 parse 通过；operation_id 只接受 null', () => {
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.rename', request_id: 'r', group: 'g1', name: '新名' })
        .success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.rename', request_id: 'r', group: 'g1' }).success,
    ).toBe(false);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.rename',
        request_id: 'r',
        group_node_id: 'g1',
        name: '新名',
        operation_id: null,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.rename',
        request_id: 'r',
        group_node_id: 'g1',
        name: '新名',
        operation_id: 'op-1',
      }).success,
    ).toBe(false);
    expect(
      CliProxyCommandErrorSchema.safeParse({
        command: 'canvas.group.rename',
        request_id: 'r',
        error: { code: 'group_not_found', message: '画布上找不到这个组。' },
      }).success,
    ).toBe(true);
  });
});
