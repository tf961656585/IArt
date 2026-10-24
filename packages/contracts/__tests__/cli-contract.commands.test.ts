// @spec: CLI-014, CLI-027, CLI-028, CLI-029, CLI-030, CLI-048, CLI-051
import { describe, expect, it } from 'vitest';

import {
  CLI_COMMANDS,
  CLI_ERROR_CODES,
  CliCommandResponseSchema,
  CliCommandRequestSchema,
  CliCommandNameSchema,
  CliErrorSchema,
  CliProxyCommandResultSchema,
  CliProxyCommandSchema,
  type CliCommandName,
} from '../src/cli-contract';
import { PROJECT, mediaAsset, requestSamples, successSamples, taskView } from './fixtures/cli-contract-samples';

/**
 * CLI 与本地 Agent 集成契约测试：命令面与统一信封。
 *
 * 口径：docs/integrations/CLI与本地Agent集成.md §5 命令面、§9 错误码。
 * - 每条命令变体 schema 的合法样例 parse 通过；
 * - 关键必填缺失 / 非法值 parse 失败（边界即失败，不流入下游）；
 * - 错误码枚举与 spec §9 一一对应；
 * - 判别联合误判别值拒绝。
 */

describe('CLI 错误码枚举（spec §9）', () => {
  it('与 spec §9 表格一一对应（20 个，语义顺序一致）', () => {
    expect([...CLI_ERROR_CODES]).toEqual([
      'not_running',
      'auth_failed',
      'project_not_found',
      'project_name_ambiguous',
      'project_name_conflict',
      'project_not_open',
      'asset_not_found',
      'file_not_found',
      'unsupported_file_type',
      'batch_not_found',
      'node_not_found',
      'group_not_found',
      'group_name_ambiguous',
      'invalid_reference',
      'model_not_available',
      'task_not_found',
      'wait_timeout',
      'command_rejected',
      'operation_not_found',
      'internal_error',
    ]);
  });

  it('错误响应形状 { code, message }；未知错误码被拒绝', () => {
    expect(CliErrorSchema.safeParse({ code: 'not_running', message: '应用未在运行' }).success).toBe(true);
    expect(CliErrorSchema.safeParse({ code: 'timeout', message: 'x' }).success).toBe(false);
    expect(CliErrorSchema.safeParse({ code: 'not_running' }).success).toBe(false);
  });
});

describe('CLI 命令请求判别联合（spec §5）', () => {
  it('命令清单共 33 条且判别值唯一', () => {
    expect(CLI_COMMANDS).toHaveLength(33);
    expect(new Set(CLI_COMMANDS).size).toBe(33);
    expect(() => CliCommandNameSchema.parse('project.list')).not.toThrow();
  });

  it('app.status 无参数：携带任何额外字段都被拒绝（spec §5.5 全局只读）', () => {
    expect(CliCommandRequestSchema.safeParse({ command: 'app.status' }).success).toBe(true);
    expect(CliCommandRequestSchema.safeParse({ command: 'app.status', project: PROJECT }).success).toBe(false);
  });

  it('每条命令的合法样例请求 parse 通过', () => {
    for (const command of CLI_COMMANDS) {
      const parsed = CliCommandRequestSchema.safeParse({ command, ...requestSamples[command] });
      expect(parsed.success, `command=${command}`).toBe(true);
    }
  });

  it('误判别值与未知命令被拒绝', () => {
    expect(CliCommandRequestSchema.safeParse({ command: 'project.rename' }).success).toBe(false);
    expect(CliCommandRequestSchema.safeParse({ command: 'generate' }).success).toBe(false);
  });

  it('strict：未声明字段被拒绝', () => {
    expect(
      CliCommandRequestSchema.safeParse({ command: 'project.list', extra: true }).success,
    ).toBe(false);
  });

  it('project.list：分页参数与 asset list 同形，缺省 limit=null/offset=0（spec §5.1 / CLI-057）', () => {
    const bare = CliCommandRequestSchema.safeParse({ command: 'project.list' });
    expect(bare.success).toBe(true);
    if (!bare.success || bare.data.command !== 'project.list') throw new Error('unreachable');
    expect(bare.data.limit).toBeNull();
    expect(bare.data.offset).toBe(0);

    const paged = CliCommandRequestSchema.safeParse({ command: 'project.list', limit: 5, offset: 10 });
    expect(paged.success).toBe(true);
    expect(CliCommandRequestSchema.safeParse({ command: 'project.list', limit: 0 }).success).toBe(false);
    expect(CliCommandRequestSchema.safeParse({ command: 'project.list', offset: -1 }).success).toBe(false);
  });

  it('关键必填缺失被拒绝', () => {
    const cases: Array<Record<string, unknown>> = [
      // project.create：name / path 必填
      { command: 'project.create', path: '/tmp/parent' },
      { command: 'project.create', name: 'p' },
      // project.status：--project 必填
      { command: 'project.status' },
      // project.delete：--yes 是必须的显式确认
      { command: 'project.delete', project: PROJECT },
      { command: 'project.delete', project: PROJECT, yes: false },
      // model.get / asset.get / task.get / task.cancel / task.wait：目标标识必填
      { command: 'model.get' },
      { command: 'asset.get', project: PROJECT },
      { command: 'task.get', project: PROJECT },
      { command: 'task.cancel', project: PROJECT },
      { command: 'task.wait', project: PROJECT },
      // generate：prompt / model 必填
      { command: 'generate', project: PROJECT, model: 'model-a' },
      { command: 'generate', project: PROJECT, prompt: 'x' },
      // canvas.group.create：name 必填；members 字段必填但允许空数组（CLI-044 空组建组）
      { command: 'canvas.group.create', project: PROJECT, members: ['node_1'] },
      { command: 'canvas.group.create', project: PROJECT, name: 'g' },
      // canvas.group.rename：目标组标识与新组名必填（spec §5.3 / CLI-057）
      { command: 'canvas.group.rename', project: PROJECT, name: '新组名' },
      { command: 'canvas.group.rename', project: PROJECT, group: 'group_1' },
      { command: 'canvas.group.rename', project: PROJECT, group: 'group_1', name: '' },
      // canvas.group.dissolve：目标组标识必填（spec §5.3 / CLI-027）
      { command: 'canvas.group.dissolve', project: PROJECT },
      // canvas.group.add / remove：目标组标识与成员清单（≥1）必填（spec §5.3 / CLI-049）
      { command: 'canvas.group.add', project: PROJECT, members: ['node_1'] },
      { command: 'canvas.group.add', project: PROJECT, group: 'group_1' },
      { command: 'canvas.group.add', project: PROJECT, group: 'group_1', members: [] },
      { command: 'canvas.group.remove', project: PROJECT, members: ['node_1'] },
      { command: 'canvas.group.remove', project: PROJECT, group: 'group_1', members: [] },
      // canvas.node.move：node / x / y 必填（spec §5.3 / CLI-028）
      { command: 'canvas.node.move', project: PROJECT, x: 1, y: 2 },
      { command: 'canvas.node.move', project: PROJECT, node: 'node_1', y: 2 },
      { command: 'canvas.node.move', project: PROJECT, node: 'node_1', x: 1 },
      // canvas.node.delete：nodes（≥1）必填（spec §5.3 / CLI-029）
      { command: 'canvas.node.delete', project: PROJECT },
      { command: 'canvas.node.delete', project: PROJECT, nodes: [] },
      // canvas.nodes.move：nodes 至少一项（批次 1a 改为可选字段，互斥由解析器/执行侧裁定）
      { command: 'canvas.nodes.move', project: PROJECT, nodes: [], dx: 1, dy: 2 },
      { command: 'canvas.nodes.move', project: PROJECT, positions: [] },
      // canvas.group.move：group 必填
      { command: 'canvas.group.move', project: PROJECT, dx: 1 },
      // canvas.undo：operation 必填
      { command: 'canvas.undo', project: PROJECT },
      // canvas.node.create：asset 必填（spec §5.3 / CLI-056）
      { command: 'canvas.node.create', project: PROJECT },
      { command: 'canvas.node.create', project: PROJECT, asset: '' },
      // canvas.layout：scope 与 plan_path 均可缺省（二选一约束由解析器按用法错误裁定，
      // schema 只承载形状）；显式空 plan_path 仍是非法值。
      { command: 'canvas.layout', project: PROJECT, plan_path: '' },
    ];
    for (const body of cases) {
      expect(CliCommandRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('canvas.layout scope=containers 被契约接受（CLI-048）', () => {
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: PROJECT,
        scope: 'containers',
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_containers',
        scope: 'containers',
      }).success,
    ).toBe(true);
  });

  it('非法值被拒绝', () => {
    const cases: Array<Record<string, unknown>> = [
      // 项目名净化：路径分隔符与点条目非法（spec §5.1）
      { command: 'project.create', name: 'a/b', path: '/tmp' },
      { command: 'project.create', name: 'a\\b', path: '/tmp' },
      { command: 'project.create', name: '..', path: '/tmp' },
      // generate：count 正整数、ref 资产标识、arg 键值对、wait 布尔
      { command: 'generate', project: PROJECT, prompt: 'x', model: 'm', count: 0 },
      { command: 'generate', project: PROJECT, prompt: 'x', model: 'm', count: 1.5 },
      { command: 'generate', project: PROJECT, prompt: 'x', model: 'm', ref: [123] },
      { command: 'generate', project: PROJECT, prompt: 'x', model: 'm', arg: [{ key: 'k' }] },
      { command: 'generate', project: PROJECT, prompt: 'x', model: 'm', wait: 'yes' },
      // canvas.layout：scope 只接受 all/containers 或 { group }；columns 正整数
      { command: 'canvas.layout', project: PROJECT, scope: 'group:abc' },
      { command: 'canvas.layout', project: PROJECT, scope: { group: '' } },
      { command: 'canvas.layout', project: PROJECT, scope: 'all', columns: 0 },
      // canvas.layout：order 必须是非空节点标识数组（spec CLI-030）
      { command: 'canvas.layout', project: PROJECT, scope: 'all', order: [] },
      { command: 'canvas.layout', project: PROJECT, scope: 'all', order: ['node_1', 2] },
      { command: 'canvas.layout', project: PROJECT, scope: 'all', order: [''] },
      // canvas.node.move：坐标必须是有限数值（可负、可小数）
      { command: 'canvas.node.move', project: PROJECT, node: 'node_1', x: 'a', y: 1 },
      { command: 'canvas.node.move', project: PROJECT, node: 'node_1', x: 1, y: null },
      // canvas.node.delete：yes 是布尔显式确认（Agent 节点删除）
      { command: 'canvas.node.delete', project: PROJECT, nodes: ['node_1'], yes: 'yes' },
      // task.wait：timeout 正整数秒
      { command: 'task.wait', project: PROJECT, task_id: 't', timeout: 0 },
      // asset.list --on-canvas 只接受布尔值（缺省 null = 不过滤）
      { command: 'asset.list', project: PROJECT, on_canvas: 'true' },
      // canvas.node.create：坐标必须是数值
      { command: 'canvas.node.create', project: PROJECT, asset: 'asset_1', x: '1', y: 2 },
      // --project 空串非法
      { command: 'project.open', project: '' },
    ];
    for (const body of cases) {
      expect(CliCommandRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('CLI 命令响应判别联合（spec §5 统一信封）', () => {
  it('每条命令的成功样例响应 parse 通过', () => {
    for (const command of CLI_COMMANDS) {
      const body = { command, ok: true, ...successSamples[command] };
      const parsed = CliCommandResponseSchema.safeParse(body);
      expect(parsed.success, `command=${command}`).toBe(true);
    }
  });

  it('每条命令的错误响应 parse 通过（错误码走 §9 枚举）', () => {
    for (const command of CLI_COMMANDS) {
      const body = { command, ok: false, error: { code: 'project_not_found', message: '项目不存在' } };
      const parsed = CliCommandResponseSchema.safeParse(body);
      expect(parsed.success, `command=${command}`).toBe(true);
    }
  });

  it('成功变体缺结果字段被拒绝', () => {
    expect(CliCommandResponseSchema.safeParse({ command: 'project.list', ok: true }).success).toBe(false);
    expect(
      CliCommandResponseSchema.safeParse({ command: 'generate', ok: true, batch_id: 'b', tasks: [] }).success,
    ).toBe(false);
  });

  it('错误响应非法形状被拒绝', () => {
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'project.open',
        ok: false,
        error: { code: 'timeout', message: 'x' },
      }).success,
    ).toBe(false);
    expect(
      CliCommandResponseSchema.safeParse({ command: 'project.open', ok: false, error: { code: 'not_running' } }).success,
    ).toBe(false);
    expect(
      CliCommandResponseSchema.safeParse({ command: 'no.such.command', ok: false, error: { code: 'not_running', message: 'x' } })
        .success,
    ).toBe(false);
  });

  it('generate --wait 样例：逐任务终态与产物资产（spec §5.4 / CLI-009 / CLI-046）', () => {
    const body = {
      command: 'generate',
      ok: true,
      batch_id: 'batch_1',
      tasks: [
        { task_id: 'task_1', task_index: 0, node_id: 'node_t1', group_id: 'group_1' },
        { task_id: 'task_2', task_index: 1, node_id: 'node_t2', group_id: 'group_1' },
      ],
      task_results: [
        {
          task: taskView(),
          assets: [{ asset: mediaAsset(), local_file_path: '/tmp/media/asset_1.png' }],
          warnings: [],
          node_id: 'node_t1',
          group_id: 'group_1',
        },
        {
          task: { ...taskView(), taskId: 'task_2', status: 'failed' },
          assets: [],
          warnings: [],
          node_id: 'node_t2',
          group_id: 'group_1',
        },
      ],
    };
    expect(CliCommandResponseSchema.safeParse(body).success).toBe(true);
    // 画布投影身份 null 合法（无投影/项目已关闭，缺省不伪造，CLI-046）
    expect(
      CliCommandResponseSchema.safeParse({
        ...body,
        task_results: [{ task: taskView(), assets: [], warnings: [], node_id: null, group_id: null }],
      }).success,
    ).toBe(true);
    // 信息性 warning（CLI-050）：形状合法，不改变 ok 与任务状态
    expect(
      CliCommandResponseSchema.safeParse({
        ...body,
        task_results: [
          {
            task: taskView(),
            assets: [{ asset: mediaAsset(), local_file_path: '/tmp/media/asset_1.png' }],
            warnings: [
              {
                code: 'requested_size_not_honored',
                message: '请求尺寸 2560x1440，实际产出 1903x2560。生成任务已成功，尺寸以实际产物为准。',
                requested_size: '2560x1440',
                actual_sizes: ['1903x2560'],
              },
            ],
            node_id: 'node_t1',
            group_id: 'group_1',
          },
        ],
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 批次二：画布写原语（group move / nodes move / dry-run / 执行报告 / 按操作撤销）
// ---------------------------------------------------------------------------

describe('画布写原语契约（批次二，spec §5.3 / CLI-052/053/054）', () => {
  const summary = { inspected: 3, moved: 2, unchanged: 1, skipped: [{ node_id: 'group_2', reason: 'no_derived_box' }] };

  it('canvas.group.move：相对位移与绝对落点在契约层都被接受（互斥是执行侧 command_rejected）', () => {
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.group.move', project: PROJECT, group: 'g', dx: 10 }).success,
    ).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.group.move', project: PROJECT, group: 'g', x: 0, y: 0 }).success,
    ).toBe(true);
    // 契约不承载互斥 refine（业务拒绝走 command_rejected，不降级为边界失败）。
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.group.move', project: PROJECT, group: 'g', dx: 1, y: 2 })
        .success,
    ).toBe(true);
    // group 必填；坐标必须是数值
    expect(CliCommandRequestSchema.safeParse({ command: 'canvas.group.move', project: PROJECT, dx: 1 }).success).toBe(
      false,
    );
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.group.move', project: PROJECT, group: 'g', dx: '1' }).success,
    ).toBe(false);
  });

  it('canvas.nodes.move：nodes 至少一项、dx/dy 必填（可负、可小数）', () => {
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.nodes.move',
        project: PROJECT,
        nodes: ['a'],
        dx: -1.5,
        dy: 0,
        dry_run: true,
      }).success,
    ).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.nodes.move', project: PROJECT, nodes: [], dx: 1, dy: 1 })
        .success,
    ).toBe(false);
  });

  it('dry-run 响应形状：四个位置写命令都带 summary / operation_id / dry_run，dry-run 的 operation_id 为 null', () => {
    const drySamples: Array<{ command: CliCommandName; body: Record<string, unknown> }> = [
      {
        command: 'canvas.layout',
        body: {
          command: 'canvas.layout',
          ok: true,
          positions: {},
          columns: null,
          gap: null,
          summary,
          operation_id: null,
          dry_run: true,
        },
      },
      {
        command: 'canvas.node.move',
        body: {
          command: 'canvas.node.move',
          ok: true,
          node_id: 'n',
          position: { x: 0, y: 0 },
          moved_node_ids: [],
          summary,
          operation_id: null,
          dry_run: true,
        },
      },
      {
        command: 'canvas.nodes.move',
        body: {
          command: 'canvas.nodes.move',
          ok: true,
          positions: {},
          moved_node_ids: [],
          summary,
          operation_id: null,
          dry_run: true,
        },
      },
      {
        command: 'canvas.group.move',
        body: {
          command: 'canvas.group.move',
          ok: true,
          group_node_id: 'g',
          positions: {},
          moved_node_ids: [],
          summary,
          operation_id: null,
          dry_run: true,
        },
      },
    ];
    for (const sample of drySamples) {
      expect(CliCommandResponseSchema.safeParse(sample.body).success, sample.command).toBe(true);
    }
    // 三字段缺一即拒绝（operation_id 是必填可空，不是 optional）
    const missingSummary = {
      command: 'canvas.layout',
      ok: true,
      positions: {},
      operation_id: null,
      dry_run: true,
    };
    expect(CliCommandResponseSchema.safeParse(missingSummary).success).toBe(false);
    const missingDryRun = { command: 'canvas.layout', ok: true, positions: {}, summary, operation_id: null };
    expect(CliCommandResponseSchema.safeParse(missingDryRun).success).toBe(false);
  });

  it('canvas.group.rename：请求/响应形状；operation_id 恒为 null（非位置类不登记撤销）', () => {
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
    // operation_id 只接受 null：本命令不产生可撤销操作标识
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
      CliCommandResponseSchema.safeParse({
        command: 'canvas.group.rename',
        ok: true,
        group_node_id: 'g1',
        name: '新名',
        operation_id: null,
      }).success,
    ).toBe(true);
  });

  it('canvas.nodes.list 条目必须携带 name；canvas.group.create 结果必须携带 member_ids', () => {
    const nodeEntry = {
      node_id: 'n1',
      node_type: 'asset',
      name: '',
      position: { x: 0, y: 0 },
      group_id: null,
      asset_id: null,
      task_id: null,
    };
    expect(
      CliCommandResponseSchema.safeParse({ command: 'canvas.nodes.list', ok: true, nodes: [nodeEntry] }).success,
    ).toBe(true);
    const withoutName = { node_id: 'n1', node_type: 'asset', position: { x: 0, y: 0 }, group_id: null, asset_id: null, task_id: null };
    expect(
      CliCommandResponseSchema.safeParse({ command: 'canvas.nodes.list', ok: true, nodes: [withoutName] }).success,
    ).toBe(false);

    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.group.create',
        ok: true,
        group_node_id: 'g1',
        member_ids: [],
        operation_id: 'op-create',
      }).success,
    ).toBe(true);
    expect(
      CliCommandResponseSchema.safeParse({ command: 'canvas.group.create', ok: true, group_node_id: 'g1', operation_id: 'op-create' })
        .success,
    ).toBe(false);
  });

  it('canvas.undo：参数与响应形状；operation_not_found 是合法错误码', () => {
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.undo', request_id: 'r', operation: 'op-1' }).success,
    ).toBe(true);
    expect(CliProxyCommandSchema.safeParse({ command: 'canvas.undo', request_id: 'r' }).success).toBe(false);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.undo',
        request_id: 'r',
        undone: true,
        operation_id: 'op-1',
        positions: { n1: { x: 0, y: 0 } },
      }).success,
    ).toBe(true);
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.undo',
        ok: false,
        error: { code: 'operation_not_found', message: '操作记录已失效或不存在。' },
      }).success,
    ).toBe(true);
  });

  it('代理通道新命令参数与结果同形（不带 project）', () => {
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.nodes.move',
        request_id: 'r',
        nodes: ['n1', 'n2'],
        dx: 1,
        dy: 2,
        dry_run: false,
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.move', request_id: 'r', group: 'g', y: 12 }).success,
    ).toBe(true);
    expect(
      CliProxyCommandSchema.safeParse({ command: 'canvas.group.move', request_id: 'r', group: 'g', project: PROJECT })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 资产回填与画布引用（CLI-056）
// ---------------------------------------------------------------------------

describe('资产回填与画布引用契约（CLI-056）', () => {
  it('asset.list 条目必带 node_ids 与 batch_id；未上画布为空数组、导入素材 batch_id 为 null', () => {
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'asset.list',
        ok: true,
        assets: [
          { asset_id: 'a1', media_type: 'image', source_summary: '', node_ids: ['n1', 'n2'], batch_id: 'b1' },
          { asset_id: 'a2', media_type: 'video', source_summary: '', node_ids: [], batch_id: null },
        ],
      }).success,
    ).toBe(true);
    // 两个新字段都是必填（缺一即拒绝，不以 optional 静默兼容）
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'asset.list',
        ok: true,
        assets: [{ asset_id: 'a1', media_type: 'image', source_summary: '' }],
      }).success,
    ).toBe(false);
  });

  it('asset.list --on-canvas 接受 true/false，缺省物化为 null（不过滤）', () => {
    expect(CliCommandRequestSchema.safeParse({ command: 'asset.list', project: PROJECT, on_canvas: true }).success).toBe(
      true,
    );
    expect(CliCommandRequestSchema.safeParse({ command: 'asset.list', project: PROJECT, on_canvas: false }).success).toBe(
      true,
    );
    const omitted = CliCommandRequestSchema.parse({ command: 'asset.list', project: PROJECT });
    expect(omitted.command === 'asset.list' ? omitted.on_canvas : 'unexpected').toBeNull();
  });

  it('canvas.node.create 请求：asset 必填；group/x/y/dry_run 可选且不带额外字段', () => {
    expect(CliCommandRequestSchema.safeParse({ command: 'canvas.node.create', project: PROJECT, asset: 'a1' }).success).toBe(
      true,
    );
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.node.create',
        project: PROJECT,
        asset: 'a1',
        group: 'g1',
        x: -10.5,
        y: 20,
        dry_run: true,
      }).success,
    ).toBe(true);
    // 单轴在契约层合法（执行侧 command_rejected，不降级为边界失败）
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.node.create', project: PROJECT, asset: 'a1', x: 1 }).success,
    ).toBe(true);
    // 素材节点类型不是参数面：命令只按资产节点物化
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.node.create', project: PROJECT, asset: 'a1', type: 'imageInput' })
        .success,
    ).toBe(false);
  });

  it('canvas.node.create 结果：真实创建给 node_id/operation_id，dry-run 两者为 null', () => {
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.node.create',
        ok: true,
        node_id: 'n1',
        asset_id: 'a1',
        position: { x: 10, y: 20 },
        group_id: 'g1',
        operation_id: 'op-create',
        dry_run: false,
      }).success,
    ).toBe(true);
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.node.create',
        ok: true,
        node_id: null,
        asset_id: 'a1',
        position: { x: 10, y: 20 },
        group_id: null,
        operation_id: null,
        dry_run: true,
      }).success,
    ).toBe(true);
    // 缺 dry_run / group_id 被拒绝（必填可空，不是 optional）
    expect(
      CliCommandResponseSchema.safeParse({
        command: 'canvas.node.create',
        ok: true,
        node_id: 'n1',
        asset_id: 'a1',
        position: { x: 10, y: 20 },
        operation_id: 'op-create',
      }).success,
    ).toBe(false);
  });

  it('代理通道命令可携带主进程补充的生成来源摘要；公共命令面不暴露这些字段', () => {
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'canvas.node.create',
        request_id: 'r1',
        asset: 'a1',
        source_batch_id: 'b1',
        source_task_id: 't1',
        source_model_id: 'model-a',
      }).success,
    ).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.node.create',
        project: PROJECT,
        asset: 'a1',
        source_batch_id: 'b1',
      }).success,
    ).toBe(false);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.node.create',
        request_id: 'r1',
        node_id: 'n1',
        asset_id: 'a1',
        position: { x: 10, y: 20 },
        group_id: null,
        operation_id: 'op-create',
        dry_run: false,
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 批次 1a 共享层：nodes move 双族 / inspect 参数 / 排序模式 / summary.cascaded
// ---------------------------------------------------------------------------

describe('画布共享语义契约（批次 1a）', () => {
  it('canvas.nodes.move 两种形状都被接受：相对族与绝对坐标族', () => {
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.nodes.move',
        project: PROJECT,
        nodes: ['n1', 'n2'],
        dx: -10,
        dy: 0,
      }).success,
    ).toBe(true);
    // 绝对坐标族：positions 至少一项，每条 node_id + x/y
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.nodes.move',
        project: PROJECT,
        positions: [
          { node_id: 'n1', x: 10, y: 20 },
          { node_id: 'n2', x: -30.5, y: 0 },
        ],
      }).success,
    ).toBe(true);
    // 参数形状不承载互斥 refine：两族同时出现由解析器/执行侧拒绝（契约层接受）
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.nodes.move',
        project: PROJECT,
        nodes: ['n1'],
        dx: 1,
        dy: 2,
        positions: [{ node_id: 'n1', x: 0, y: 0 }],
      }).success,
    ).toBe(true);
    // 单条形状错误被拒绝
    for (const positions of [[{}], [{ node_id: 'n1', x: 0 }], [{ node_id: '', x: 0, y: 0 }], [{ node_id: 'n1', x: '0', y: 0 }]]) {
      expect(
        CliCommandRequestSchema.safeParse({ command: 'canvas.nodes.move', project: PROJECT, positions }).success,
        JSON.stringify(positions),
      ).toBe(false);
    }
    // 空字段省略（undefined）通过；显式 null 被拒绝
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.nodes.move', project: PROJECT, dx: 1 }).success,
    ).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.nodes.move', project: PROJECT, dx: null }).success,
    ).toBe(false);
  });

  it('canvas.inspect 请求参数形状：full/group/prompt_limit/include_unplaced 可选且受类型约束', () => {
    const base = { command: 'canvas.inspect' as const, project: PROJECT };
    expect(CliCommandRequestSchema.safeParse(base).success).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({
        ...base,
        full: true,
        group: 'group_1',
        prompt_limit: 0,
        include_unplaced: false,
      }).success,
    ).toBe(true);
    expect(CliCommandRequestSchema.safeParse({ ...base, prompt_limit: 200 }).success).toBe(true);
    // 非法值：负截断、小数、字符串布尔、空组标识、额外字段
    for (const bad of [
      { prompt_limit: -1 },
      { prompt_limit: 1.5 },
      { full: 'yes' },
      { group: '' },
      { include_unplaced: 'false' },
      { prompt_preview: 'x' },
    ]) {
      expect(CliCommandRequestSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('canvas.layout order_mode 只接受 position/created/insertion；显式 order 仍可与模式共存', () => {
    for (const orderMode of ['position', 'created', 'insertion']) {
      expect(
        CliCommandRequestSchema.safeParse({ command: 'canvas.layout', project: PROJECT, scope: 'all', order_mode: orderMode })
          .success,
        orderMode,
      ).toBe(true);
    }
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: PROJECT,
        scope: { group: 'g1' },
        order_mode: 'created',
        order: ['n2', 'n1'],
        gap: 0,
        columns: 2,
      }).success,
    ).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({ command: 'canvas.layout', project: PROJECT, scope: 'all', order_mode: 'random' })
        .success,
    ).toBe(false);
  });

  it('canvas.layout 计划模式：可无 scope 带 plan_path（批次 1b）', () => {
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: PROJECT,
        plan_path: '/tmp/plan.json',
      }).success,
    ).toBe(true);
    expect(
      CliCommandRequestSchema.safeParse({
        command: 'canvas.layout',
        project: PROJECT,
        plan_path: '/tmp/plan.json',
        dry_run: true,
      }).success,
    ).toBe(true);
  });

  it('执行报告 summary.cascaded 为非负整数；旧响应缺省按 0 兜底', () => {
    const base = {
      command: 'canvas.nodes.move',
      ok: true,
      positions: {},
      moved_node_ids: [],
      operation_id: 'op-1',
      dry_run: false,
    };
    const parsed = CliCommandResponseSchema.safeParse({
      ...base,
      summary: { inspected: 1, moved: 3, cascaded: 2, unchanged: 0, skipped: [] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.ok === true && parsed.data.command === 'canvas.nodes.move') {
      expect(parsed.data.summary.cascaded).toBe(2);
    }
    // 旧响应没有 cascaded：解析成功且物化为 0
    const legacy = CliCommandResponseSchema.safeParse({
      ...base,
      summary: { inspected: 1, moved: 1, unchanged: 0, skipped: [] },
    });
    expect(legacy.success).toBe(true);
    if (legacy.success && legacy.data.ok === true && legacy.data.command === 'canvas.nodes.move') {
      expect(legacy.data.summary.cascaded).toBe(0);
    }
    expect(
      CliCommandResponseSchema.safeParse({
        ...base,
        summary: { inspected: 1, moved: 1, cascaded: -1, unchanged: 0, skipped: [] },
      }).success,
    ).toBe(false);
  });
});
