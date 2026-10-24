// CLI 契约测试共享样例（纯数据夹具，不含断言）。
//
// 口径：docs/integrations/CLI与本地Agent集成.md §5 命令面、§6.3 代理执行通道。
// 供 cli-contract.commands.test.ts 逐命令比对请求 / 响应判别联合。
import type { CliCommandName } from '../../src/cli-contract';

export const PROJECT = '/tmp/demo-project';
export const ISO = '2026-10-07T00:00:00.000Z';

export const mediaAsset = (): Record<string, unknown> => ({
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

export const taskView = (): Record<string, unknown> => ({
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
  name: '结果图',
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

export const requestSamples: Record<CliCommandName, Record<string, unknown>> = {
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
  'canvas.inspect': { project: PROJECT },
  'asset.import': { project: PROJECT, file: ['/tmp/media/a.png', '/tmp/media/b.mp4'] },
  'canvas.group.create': { project: PROJECT, name: '角色组', members: ['node_1'] },
  'canvas.group.rename': { project: PROJECT, group: 'group_1', name: '新组名' },
  'canvas.group.dissolve': { project: PROJECT, group: 'group_1' },
  'canvas.group.add': { project: PROJECT, group: 'group_1', members: ['node_1', 'node_2'] },
  'canvas.group.remove': { project: PROJECT, group: 'group_1', members: ['node_1'] },
  'canvas.node.move': { project: PROJECT, node: 'node_1', x: -120, y: 240.5 },
  'canvas.nodes.move': { project: PROJECT, nodes: ['node_1', 'node_2'], dx: 10, dy: -20 },
  'canvas.group.move': { project: PROJECT, group: 'group_1', dx: 10, dy: -20 },
  'canvas.node.delete': { project: PROJECT, nodes: ['node_1', 'node_2'] },
  'canvas.node.create': { project: PROJECT, asset: 'asset_1', group: 'group_1', x: 10, y: 20 },
  'canvas.layout': { project: PROJECT, scope: 'all' },
  'canvas.undo': { project: PROJECT, operation: 'op-1' },
  generate: { project: PROJECT, prompt: '一只猫在窗台', model: 'model-a' },
  'task.list': { project: PROJECT },
  'task.get': { project: PROJECT, task_id: 'task_1' },
  'task.cancel': { project: PROJECT, task_id: 'task_1' },
  'task.wait': { project: PROJECT, task_id: 'task_1' },
  'batch.get': { project: PROJECT, batch_id: 'batch_1' },
  'app.status': {},
};

export const successSamples: Record<CliCommandName, Record<string, unknown>> = {
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
  'asset.list': {
    assets: [
      {
        asset_id: 'asset_1',
        media_type: 'image',
        source_summary: 'task_1',
        node_ids: ['node_1'],
        batch_id: 'batch_1',
      },
    ],
  },
  'asset.get': { asset: mediaAsset(), local_file_path: '/tmp/media/asset_1.png', generation: generationArchive() },
  'canvas.nodes.list': { nodes: [canvasNode()] },
  'canvas.group.list': {
    groups: [
      { group_node_id: 'group_1', name: '角色组', type: 'group', member_count: 2 },
      { group_node_id: 'agent_1', name: '助理', type: 'agent_container', member_count: 0 },
    ],
  },
  'canvas.inspect': {
    fidelity: 'exact',
    nodes: [
      {
        node_id: 'node_1', node_type: 'asset', name: '结果图', position: { x: 10, y: 20 },
        size: { width: 320, height: 240 }, bbox: { x: 10, y: 20, width: 320, height: 240 },
        group_id: 'group_1', asset_id: 'asset_1', task_id: null, batch_id: null,
        asset: {
          asset_id: 'asset_1', media_type: 'image', width: 1024, height: 768, file_name: 'cat.png',
          batch_id: 'batch_1', task_id: 'task_1', model_id: 'model-a', prompt_preview: '一只猫在窗台',
          created_at: ISO, local_file_path: '/tmp/media/cat.png',
        },
      },
    ],
    containers: [
      {
        group_node_id: 'group_1', name: '角色组', type: 'group', member_ids: ['node_1'],
        position: { x: -2, y: -20 }, size: { width: 334, height: 280 },
        bbox: { x: -2, y: -20, width: 334, height: 280 }, collapsed: false,
      },
    ],
    assets_not_on_canvas: [
      { asset_id: 'asset_2', media_type: 'video', file_name: null, created_at: ISO, batch_id: null },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: { node_ids: ['node_1'], annotation_ids: [] },
  },
  'asset.import': {
    imported: [
      { file_name: 'a.png', asset_id: 'asset_1', node_id: 'node_1', media_type: 'image' },
      { file_name: 'b.mp4', asset_id: 'asset_2', node_id: 'node_2', media_type: 'video' },
    ],
    operation_id: 'op-import',
  },
  'canvas.group.create': { group_node_id: 'group_1', member_ids: ['node_1'], operation_id: 'op-create' },
  'canvas.group.rename': { group_node_id: 'group_1', name: '新组名', operation_id: null },
  'canvas.group.dissolve': { dissolved: true, group_node_id: 'group_1', member_ids: ['node_1', 'node_2'], operation_id: 'op-dissolve' },
  'canvas.group.add': {
    group_node_id: 'group_1',
    added_node_ids: ['node_1'],
    moved_node_ids: ['node_2'],
    unchanged_node_ids: ['node_3'],
    operation_id: 'op-add',
  },
  'canvas.group.remove': { group_node_id: 'group_1', removed_node_ids: ['node_1'], operation_id: 'op-remove' },
  'canvas.node.move': {
    node_id: 'node_1',
    position: { x: -120, y: 240.5 },
    moved_node_ids: ['node_1'],
    summary: { inspected: 2, moved: 1, unchanged: 1, skipped: [] },
    operation_id: 'op-move',
    dry_run: false,
  },
  'canvas.nodes.move': {
    positions: { node_1: { x: 10, y: 20 } },
    moved_node_ids: ['node_1'],
    summary: { inspected: 2, moved: 1, unchanged: 1, skipped: [] },
    operation_id: 'op-nodes-move',
    dry_run: false,
  },
  'canvas.group.move': {
    group_node_id: 'group_1',
    positions: { group_1: { x: 0, y: 0 }, node_1: { x: 10, y: 20 } },
    moved_node_ids: ['group_1', 'node_1'],
    summary: { inspected: 2, moved: 1, unchanged: 1, skipped: [] },
    operation_id: 'op-group-move',
    dry_run: false,
  },
  'canvas.node.delete': { deleted: true, deleted_node_ids: ['node_1'], operation_id: 'op-delete' },
  'canvas.node.create': {
    node_id: 'node_new',
    asset_id: 'asset_1',
    position: { x: 10, y: 20 },
    group_id: 'group_1',
    operation_id: 'op-create',
    dry_run: false,
  },
  'canvas.layout': {
    positions: { node_1: { x: 10, y: 20 } },
    columns: null,
    gap: null,
    summary: { inspected: 2, moved: 1, unchanged: 1, skipped: [] },
    operation_id: 'op-layout',
    dry_run: false,
  },
  'canvas.undo': { undone: true, operation_id: 'op-move', positions: { node_1: { x: 0, y: 0 } } },
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
      warnings: [],
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
