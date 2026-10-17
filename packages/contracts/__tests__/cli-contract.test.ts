// @spec: CLI-014, CLI-027, CLI-028, CLI-029, CLI-030
import { describe, expect, it } from 'vitest';

import {
  CLI_COMMANDS,
  CLI_ERROR_CODES,
  CliCommandLogEntrySchema,
  CliCommandRequestSchema,
  CliCommandResponseSchema,
  CliCommandNameSchema,
  CliEntryOperationResultSchema,
  CliErrorSchema,
  CliProxyCommandErrorSchema,
  CliProxyCommandResultSchema,
  CliProxyCommandSchema,
  CliStatusDtoSchema,
  type CliCommandName,
} from '../src/cli-contract';
import {
  CLI_GET_STATUS_CHANNEL,
  CLI_PROXY_REQUEST_CHANNEL,
  CLI_PROXY_RESPONSE_CHANNEL,
  CLI_REGISTER_ENTRY_CHANNEL,
  CLI_UNREGISTER_ENTRY_CHANNEL,
} from '../src/cli-settings-channels';
import * as contracts from '../src';

/**
 * CLI 与本地 Agent 集成契约测试。
 *
 * 口径：docs/integrations/CLI与本地Agent集成.md §5 命令面、§6.3 代理执行通道、
 * §6.2/§8 设置页 DTO、§9 错误码。
 * - 每条命令变体 schema 的合法样例 parse 通过；
 * - 关键必填缺失 / 非法值 parse 失败（边界即失败，不流入下游）；
 * - 错误码枚举与 spec §9 一一对应；
 * - 判别联合误判别值拒绝。
 */

const PROJECT = '/tmp/demo-project';
const ISO = '2026-10-07T00:00:00.000Z';

const mediaAsset = (): Record<string, unknown> => ({
  assetId: 'asset_1',
  mediaType: 'image',
  original: {
    url: 'local-media://demo/img.png',
    projectRef: null,
    fileKey: 'img.png',
    sourceUrl: null,
    mimeType: 'image/png',
    sizeBytes: 10,
    width: 8,
    height: 8,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: null,
    mimeType: null,
    width: null,
    height: null,
    status: 'missing',
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 1, updatedAt: 2 },
});

const taskView = (): Record<string, unknown> => ({
  taskId: 'task_1',
  status: 'succeeded',
  projectPath: PROJECT,
  createdAt: 1,
  updatedAt: 2,
});

const modelEntry = (): Record<string, unknown> => ({
  model_id: 'model-a',
  model_version: 'v1',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [] },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
});

const canvasNode = (): Record<string, unknown> => ({
  node_id: 'node_1',
  node_type: 'asset',
  position: { x: 10, y: 20 },
  group_id: null,
  asset_id: 'asset_1',
  task_id: null,
});

const generationArchive = (): Record<string, unknown> => ({
  batch_id: 'batch_1',
  model_id: 'model-a',
  prompt: '一只猫在窗台',
  params: { aspect_ratio: '1:1' },
  references: [
    { asset_id: 'asset_ref_1', media_kind: 'image', file_key: 'ref.png', local_file_path: '/tmp/media/ref.png' },
  ],
  task_ids: ['task_1'],
  created_at: ISO,
});

const requestSamples: Record<CliCommandName, Record<string, unknown>> = {
  'project.list': {},
  'project.status': { project: PROJECT },
  'project.create': { name: '新项目', path: '/tmp/parent' },
  'project.open': { project: PROJECT },
  'project.close': { project: PROJECT },
  'project.delete': { project: PROJECT, yes: true },
  'model.list': {},
  'model.get': { model_id: 'model-a' },
  'asset.list': { project: PROJECT },
  'asset.get': { project: PROJECT, asset_id: 'asset_1' },
  'canvas.nodes.list': { project: PROJECT },
  'canvas.group.list': { project: PROJECT },
  'asset.import': { project: PROJECT, file: ['/tmp/media/a.png', '/tmp/media/b.mp4'] },
  'canvas.group.create': { project: PROJECT, name: '角色组', members: ['node_1'] },
  'canvas.group.dissolve': { project: PROJECT, group: 'group_1' },
  'canvas.node.move': { project: PROJECT, node: 'node_1', x: -120, y: 240.5 },
  'canvas.node.delete': { project: PROJECT, nodes: ['node_1', 'node_2'] },
  'canvas.layout': { project: PROJECT, scope: 'all' },
  generate: { project: PROJECT, prompt: '一只猫在窗台', model: 'model-a' },
  'task.list': { project: PROJECT },
  'task.get': { project: PROJECT, task_id: 'task_1' },
  'task.cancel': { project: PROJECT, task_id: 'task_1' },
  'task.wait': { project: PROJECT, task_id: 'task_1' },
  'batch.get': { project: PROJECT, batch_id: 'batch_1' },
  'app.status': {},
};

const successSamples: Record<CliCommandName, Record<string, unknown>> = {
  'project.list': { projects: [{ name: 'p', path: PROJECT, last_opened_at: 1 }] },
  'project.status': {
    project: { name: 'p', path: PROJECT },
    registered: true,
    window_open: true,
    active_task_count: 2,
  },
  'project.create': { project: { name: 'p', path: PROJECT } },
  'project.open': { project: { name: 'p', path: PROJECT } },
  'project.close': { closed: true },
  'project.delete': { deleted: true },
  'model.list': { models: [modelEntry()] },
  'model.get': { model: modelEntry() },
  'asset.list': { assets: [{ asset_id: 'asset_1', media_type: 'image', source_summary: 'task_1' }] },
  'asset.get': { asset: mediaAsset(), local_file_path: '/tmp/media/asset_1.png', generation: generationArchive() },
  'canvas.nodes.list': { nodes: [canvasNode()] },
  'canvas.group.list': {
    groups: [
      { group_node_id: 'group_1', name: '角色组', type: 'group', member_count: 2 },
      { group_node_id: 'agent_1', name: '助理', type: 'agent_container', member_count: 0 },
    ],
  },
  'asset.import': {
    imported: [
      { file_name: 'a.png', asset_id: 'asset_1', node_id: 'node_1', media_type: 'image' },
      { file_name: 'b.mp4', asset_id: 'asset_2', node_id: 'node_2', media_type: 'video' },
    ],
  },
  'canvas.group.create': { group_node_id: 'group_1' },
  'canvas.group.dissolve': { dissolved: true, group_node_id: 'group_1', member_ids: ['node_1', 'node_2'] },
  'canvas.node.move': { node_id: 'node_1', position: { x: -120, y: 240.5 }, moved_node_ids: ['node_1'] },
  'canvas.node.delete': { deleted: true, deleted_node_ids: ['node_1'] },
  'canvas.layout': { positions: { node_1: { x: 10, y: 20 } } },
  generate: {
    batch_id: 'batch_1',
    tasks: [{ task_id: 'task_1', task_index: 0, node_id: 'node_t1', group_id: 'group_1' }],
    task_results: [],
  },
  'task.list': { tasks: [taskView()] },
  'task.get': { task: taskView(), node_id: 'node_t1', group_id: 'group_1', generation: generationArchive() },
  'batch.get': { generation: generationArchive() },
  'task.cancel': { accepted: true, task_id: 'task_1', cancelled_at: ISO },
  'task.wait': {
    task_result: {
      task: taskView(),
      assets: [{ asset: mediaAsset(), local_file_path: '/tmp/media/asset_1.png' }],
      node_id: 'node_t1',
      group_id: 'group_1',
    },
  },
  'app.status': {
    opened_projects: [
      { name: 'p', path: PROJECT, focused: true, selection: { node_ids: ['node_1'], annotation_ids: [] } },
      { name: 'q', path: '/tmp/other', focused: false, selection: null },
    ],
  },
};

describe('CLI 错误码枚举（spec §9）', () => {
  it('与 spec §9 表格一一对应（19 个，语义顺序一致）', () => {
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
  it('命令清单共 25 条且判别值唯一', () => {
    expect(CLI_COMMANDS).toHaveLength(25);
    expect(new Set(CLI_COMMANDS).size).toBe(25);
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
      // canvas.group.dissolve：目标组标识必填（spec §5.3 / CLI-027）
      { command: 'canvas.group.dissolve', project: PROJECT },
      // canvas.node.move：node / x / y 必填（spec §5.3 / CLI-028）
      { command: 'canvas.node.move', project: PROJECT, x: 1, y: 2 },
      { command: 'canvas.node.move', project: PROJECT, node: 'node_1', y: 2 },
      { command: 'canvas.node.move', project: PROJECT, node: 'node_1', x: 1 },
      // canvas.node.delete：nodes（≥1）必填（spec §5.3 / CLI-029）
      { command: 'canvas.node.delete', project: PROJECT },
      { command: 'canvas.node.delete', project: PROJECT, nodes: [] },
      // canvas.layout：scope 必填
      { command: 'canvas.layout', project: PROJECT },
    ];
    for (const body of cases) {
      expect(CliCommandRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
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
      // canvas.layout：scope 只接受 all 或 { group }；columns 正整数
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
          node_id: 'node_t1',
          group_id: 'group_1',
        },
        {
          task: { ...taskView(), taskId: 'task_2', status: 'failed' },
          assets: [],
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
        task_results: [{ task: taskView(), assets: [], node_id: null, group_id: null }],
      }).success,
    ).toBe(true);
  });
});

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
    expect(
      CliProxyCommandSchema.safeParse({
        command: 'generate',
        request_id: 'req_4',
        prompt: '一只猫在窗台',
        model: 'model-a',
        count: 2,
        ref: ['asset_1'],
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
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.layout',
        request_id: 'req_2',
        positions: { node_1: { x: 1, y: 2 } },
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

  it('三条新命令的代理结果 parse 通过：成员列表 / 最终坐标与位移集合 / 实删集合', () => {
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.group.dissolve',
        request_id: 'req_d1',
        dissolved: true,
        group_node_id: 'group_1',
        member_ids: ['node_1', 'node_2'],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.node.move',
        request_id: 'req_d2',
        node_id: 'node_1',
        position: { x: -120, y: 240.5 },
        moved_node_ids: ['node_1'],
      }).success,
    ).toBe(true);
    expect(
      CliProxyCommandResultSchema.safeParse({
        command: 'canvas.node.delete',
        request_id: 'req_d3',
        deleted: true,
        deleted_node_ids: ['node_1'],
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

describe('设置页「命令行工具」DTO（spec §6.2/§8）', () => {
  it('命令日志条目：合法样例 parse 通过', () => {
    expect(
      CliCommandLogEntrySchema.safeParse({
        timestamp: ISO,
        command: 'generate',
        paramsSummary: 'model=model-a count=2',
        status: 'success',
        durationMs: 120,
      }).success,
    ).toBe(true);
    expect(
      CliCommandLogEntrySchema.safeParse({
        timestamp: ISO,
        command: 'generate',
        paramsSummary: '',
        status: 'error',
        durationMs: 0,
        errorCode: 'invalid_reference',
      }).success,
    ).toBe(true);
  });

  it('命令日志条目：非法值被拒绝', () => {
    const valid = {
      timestamp: ISO,
      command: 'generate',
      paramsSummary: '',
      status: 'success',
      durationMs: 1,
    };
    expect(
      CliCommandLogEntrySchema.safeParse({ ...valid, timestamp: '2026-10-07 00:00:00' }).success,
    ).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, status: 'ok' }).success).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, durationMs: -1 }).success).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, errorCode: 'timeout' }).success).toBe(false);
    expect(CliCommandLogEntrySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('CLI 状态 DTO：recentCommands 最多 20 条，port 可空，entry 为五态详情', () => {
    const entry = {
      timestamp: ISO,
      command: 'project.list',
      paramsSummary: '',
      status: 'success',
      durationMs: 1,
    };
    const entryDetail = {
      state: 'registered',
      entryPath: '/tmp/example/iart',
      legacyEntryPath: null,
      pathSetupRequired: false,
    };
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: true,
        port: 8765,
        discoveryFileValid: true,
        entry: entryDetail,
        recentCommands: [],
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: false,
        port: null,
        discoveryFileValid: false,
        entry: { state: 'unsupported', entryPath: null, legacyEntryPath: null, pathSetupRequired: false },
        recentCommands: [],
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: true,
        port: 8765,
        discoveryFileValid: true,
        entry: entryDetail,
        recentCommands: Array.from({ length: 20 }, () => entry),
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        serviceRunning: true,
        port: 8765,
        discoveryFileValid: true,
        entry: entryDetail,
        recentCommands: Array.from({ length: 21 }, () => entry),
      }).success,
    ).toBe(false);
  });

  it('CLI 状态 DTO：entry 五态边界——五态合法，缺失/非法被拒绝（spec §8 注册状态）', () => {
    const base = {
      serviceRunning: true,
      port: 8765,
      discoveryFileValid: true,
      recentCommands: [],
    };
    const detail = (state: string) => ({ state, entryPath: '/tmp/example/iart', legacyEntryPath: null, pathSetupRequired: false });
    for (const state of ['unsupported', 'missing', 'registered', 'stale', 'foreign']) {
      expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail(state) }).success).toBe(true);
    }
    expect(CliStatusDtoSchema.safeParse({ ...base }).success).toBe(false);
    // 旧三态命名（modified 等）与旧布尔字段（entryRegistered）不得回归
    expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail('modified') }).success).toBe(false);
    expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail('registered'), entryRegistered: true }).success).toBe(false);
    // entry 详情字段边界：entryPath/legacyEntryPath 可 null；pathSetupRequired 必须布尔；多余键拒绝
    expect(
      CliStatusDtoSchema.safeParse({
        ...base,
        entry: { state: 'stale', entryPath: null, legacyEntryPath: '/usr/local/bin/iart', pathSetupRequired: true },
      }).success,
    ).toBe(true);
    expect(
      CliStatusDtoSchema.safeParse({
        ...base,
        entry: { state: 'registered', entryPath: '/x', legacyEntryPath: '/y', pathSetupRequired: 'yes' },
      }).success,
    ).toBe(false);
    expect(CliStatusDtoSchema.safeParse({ ...base, entry: detail('registered'), extra: 1 }).success).toBe(false);
  });

  it('CLI 设置页通道常量：三条通道命名稳定且经 barrel 导出（spec §8）', () => {
    expect(CLI_GET_STATUS_CHANNEL).toBe('cli:get-status');
    expect(CLI_REGISTER_ENTRY_CHANNEL).toBe('cli:register-entry');
    expect(CLI_UNREGISTER_ENTRY_CHANNEL).toBe('cli:unregister-entry');
    // 与代理执行通道命名空间区分（cli-proxy-* 与 cli:* 两族互不重叠）
    expect(CLI_GET_STATUS_CHANNEL).not.toBe(CLI_PROXY_REQUEST_CHANNEL);
    expect(CLI_GET_STATUS_CHANNEL).not.toBe(CLI_PROXY_RESPONSE_CHANNEL);
    // barrel 导出（消费端统一从 @iart/contracts 取用）
    expect(contracts.CLI_GET_STATUS_CHANNEL).toBe('cli:get-status');
    expect(contracts.CLI_REGISTER_ENTRY_CHANNEL).toBe('cli:register-entry');
    expect(contracts.CLI_UNREGISTER_ENTRY_CHANNEL).toBe('cli:unregister-entry');
  });

  it('入口注册操作结果 DTO：{ ok, message? } 形状边界（spec §8）', () => {
    expect(CliEntryOperationResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: true, message: '已注册。' }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: false, message: '没有权限写入命令入口目录。' }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: false }).success).toBe(true);
    expect(CliEntryOperationResultSchema.safeParse({ ok: 'yes' }).success).toBe(false);
    expect(CliEntryOperationResultSchema.safeParse({ ok: true, message: '' }).success).toBe(false);
    expect(CliEntryOperationResultSchema.safeParse({ ok: true, extra: 1 }).success).toBe(false);
  });
});
