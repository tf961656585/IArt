// @vitest-environment node
// @spec: CLI-005, CLI-007, CLI-008, CLI-010, CLI-012, CLI-014, CLI-020, CLI-021, CLI-027, CLI-030, CLI-047
//
// CLI 与本地 Agent 集成 · 主链接缝测试（spec docs/integrations/CLI与本地Agent集成.md
// §4 架构 / §6 通道契约 / §10 边界条件）。
//
// 使命：在没有真实 Electron 运行时的前提下，把「CLI 客户端 → 本地控制服务 → 执行器 →
// 代理执行通道 → 画布窗口接收器 → 程序化提交 / 素材导入」主链首尾真实跑通一遍。
//
// 共享台架（真实两端加载、假传输层直通、临时数据根 fixture、执行器依赖注入面）承载在
// ./cli.seam.harness.ts（max-lines 行数预算拆分）；本文件只保留各链路的断言组织。
//
// 只在最外层挡掉真实边界（假替身清单）：
// - Electron 窗口传输层（webContents.send / ipcMain.on）：假传输层直通——捕获分发器发出的
//   命令载荷喂给真实 handleCliProxyPayload，接收器的 send 回调原样回注真实
//   dispatcher.consumeResponsePayload（红→绿断链注入点就在这一腿）；
// - promptDockApi HTTP 边界（submitGenerationBatch / cancelTask）：vi.mock，受理响应按
//   PromptDockBatchSubmitResponseSchema 字段构造并当场 parse（真实响应喂消费端同一份契约
//   schema 的合法形态：字段从 schema 产生、边界 parse 为真）；
// - 缩略图生成 HTTP/WS 边界（链路 E 导入完成后的 fire-and-forget 修复，非本链路断言面）：
//   vi.mock 挡掉；
// - 主进程存储服务与 recent-projects 注册表：临时目录 fixture + 假存储适配（创建链重名守卫
//   属存储服务职责，此处按其契约抛 PROJECT_NAME_CONFLICT）；链路 E 另以假 storage IPC 桥承载
//   storage:read-file-bytes / storage:import-local-media / storage:upsert-media-asset。
//
// 输入从真实链路源头产生：建组成员 id 经真实 canvasStore.addNode action 创建后从 store 读回，
// 不手工捏造 id 直塞断言层。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CliProxyCommandResponseSchema,
  CliProxyCommandSchema,
  PromptDockBatchSubmitResponseSchema,
  TaskCancelAcceptedResponseSchema,
  type MediaAsset,
} from '@iart/contracts';
import type {
  StorageImportLocalMediaParams,
  StorageImportLocalMediaResult,
  StorageReadFileBytesParams,
  StorageReadFileBytesResult,
  StorageUpsertMediaAssetParams,
  StorageUpsertMediaAssetResult,
} from '@iart/contracts/editor-storage-contract';

// promptDockApi 是 Editor 侧的 HTTP 边界（submitGenerationBatch / cancelTask）：本接缝在这条
// 边界上用替身承载「真实形状的受理/取消响应」，其余（前置校验、受理回执投影、画布 action）
// 全部走真实实现。工厂只提供被消费的两个导出（沿 cliProxyReceiver.generate.test.ts 惯例）。
// guard-seam-mock-exempt: 外部 HTTP 边界替身——被测主链两端真实，仅 HTTP facade 按 schema 真实形态替身；消除条件：promptDockApi 改为可注入 fetch 上游后移除本替身
vi.mock('@/client/api/promptDockApi', () => ({
  __esModule: true,
  cancelTask: vi.fn(),
  submitGenerationBatch: vi.fn(),
}));

// 缩略图生成是远端媒体加工边界（真实部署下经 Backend 媒体管线 / 本地 ffmpeg），且调用发生在
// 导入写盘登记完成之后（scheduleImportedMediaThumbnailRepair 的 fire-and-forget 修复），
// 不属本接缝断言面；jsdom/node 测试环境无真实加工链路，用替身挡掉（消除条件：媒体加工改为
// 可注入上游后移除本替身）。
// guard-seam-mock-exempt: 外部媒体加工边界替身——导入主链两端真实，仅缩略图修复请求短路
vi.mock('@/client/api/imageThumbnail', () => ({
  __esModule: true,
  createImageThumbnail: vi.fn(),
}));
// guard-seam-mock-exempt: 外部媒体加工边界替身——导入主链两端真实，仅缩略图修复请求短路
vi.mock('@/client/api/videoThumbnail', () => ({
  __esModule: true,
  createVideoThumbnail: vi.fn(),
}));

import { cancelTask, submitGenerationBatch } from '@/client/api/promptDockApi';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import {
  createCatalogEntryWithSlots,
  multiImageRefSlots,
} from '@/features/promptdock/__tests__/fixtures/promptDockCatalogEntry';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import {
  CLOSED_PROJECT_NAME,
  OPEN_PROJECT_NAME,
  closedProjectDir,
  createMemberNodeViaStoreAction,
  createProxyWiring,
  findTaskNodeData,
  getWiring,
  groupNodes,
  openProjectDir,
  parseCliFailure,
  parseCliResponse,
  projectsRoot,
  readRegistryFixture,
  resetSeamForTest,
  runCli,
  seamState,
  settleWithin,
  sleep,
  startCliSeamService,
  stopCliSeamService,
  tempRoot,
} from './cli.seam.harness';

const cancelTaskMock = vi.mocked(cancelTask);
const submitGenerationBatchMock = vi.mocked(submitGenerationBatch);

beforeAll(async () => {
  await startCliSeamService();
});

afterAll(async () => {
  await stopCliSeamService();
});

beforeEach(async () => {
  cancelTaskMock.mockReset();
  submitGenerationBatchMock.mockReset();
  await resetSeamForTest();
});

// ---------------------------------------------------------------------------
// 链路 A：Main 直链（项目生命周期 + 重名守卫）
// ---------------------------------------------------------------------------

describe('链路 A：CLI 客户端 → 真实控制服务 → 项目生命周期执行器', () => {
  it('project create 目标目录已存在同名项目目录 → project_name_conflict 且既有目录内容与注册表不变（CLI-005 主链）', async () => {
    const conflictDir = path.join(projectsRoot, '重名项目');
    fs.mkdirSync(conflictDir, { recursive: true });
    fs.writeFileSync(path.join(conflictDir, '既有内容.txt'), 'must-survive', 'utf-8');
    const registryBefore = readRegistryFixture();

    const result = await runCli(['project', 'create', '--name', '重名项目', '--path', projectsRoot, '--json']);

    expect(result.exitCode).toBe(1);
    const error = parseCliFailure(result);
    expect(error.code).toBe('project_name_conflict');
    expect(error.message).toContain('同名项目');
    // 既有目录内容不变：marker 原样、无新增文件；注册表 fixture 无新增条目
    expect(fs.readdirSync(conflictDir)).toEqual(['既有内容.txt']);
    expect(fs.readFileSync(path.join(conflictDir, '既有内容.txt'), 'utf-8')).toBe('must-survive');
    expect(readRegistryFixture()).toEqual(registryBefore);
  });

  it('project create 无冲突 → 创建成功且出现在注册表 fixture（CLI-005 成功半边）', async () => {
    const result = await runCli(['project', 'create', '--name', '全新项目', '--path', projectsRoot, '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'project.create') {
      throw new Error(`expected project.create success response, got ${result.stdout}`);
    }
    expect(response.project).toEqual({ name: '全新项目', path: path.join(projectsRoot, '全新项目') });
    expect(fs.existsSync(path.join(projectsRoot, '全新项目'))).toBe(true);
    expect(readRegistryFixture().some((entry) => entry.name === '全新项目')).toBe(true);
  });

  it('project list → 响应含 fixture 项目，两端 schema 校验（服务端出站校验 + 客户端响应 parse）', async () => {
    const result = await runCli(['project', 'list', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'project.list') {
      throw new Error(`expected project.list success response, got ${result.stdout}`);
    }
    const openEntry = response.projects.find((project) => project.name === OPEN_PROJECT_NAME);
    expect(openEntry).toMatchObject({ path: openProjectDir, last_opened_at: 1700000000000 });
    // 客户端侧契约校验是真实实现的内嵌行为：响应非法时 runCliClient 以退出码 2 拒绝，
    // 走不到这里——上面的 parseCliResponse 断言 stdout 本身就是契约形状。
  });
});

// ---------------------------------------------------------------------------
// 链路 B：代理执行链（CLI → 控制服务 → 执行器 → 分发器 → 假传输层 → 真实接收器 → 回注）
// ---------------------------------------------------------------------------

describe('链路 B：代理执行通道断链敏感性（红→绿自证）', () => {
  it('假传输层丢弃响应回注 → 分发器 pending 永不收口；request_id 改错被丢弃且留痕', async () => {
    // 专用分发器/传输层：悬挂的 pending 不影响共享接缝
    const brokenWiring = createProxyWiring((projectPath) => seamState.openWindowProjectPath === projectPath);
    brokenWiring.setMode('drop');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const first = brokenWiring.dispatcher
        .dispatch(openProjectDir, { command: 'canvas.group.create', name: '红证组', members: ['ghost-node'] })
        .catch(() => undefined);
      // Editor 接收器真实执行并产出了响应（成员不存在 → node_not_found），但回注腿被掐断
      await sleep(50);
      expect(brokenWiring.capturedResponses).toHaveLength(1);
      expect(brokenWiring.capturedResponses[0]).toMatchObject({
        command: 'canvas.group.create',
        error: { code: 'node_not_found' },
      });
      await expect(settleWithin(first, 250)).resolves.toBe('pending');

      // 断链注入点 2：响应回注但 request_id 改错 → 无配对挂起命令，丢弃 + debug 留痕
      brokenWiring.setMode('wrong_request_id');
      const second = brokenWiring.dispatcher
        .dispatch(openProjectDir, { command: 'canvas.group.create', name: '红证组二', members: ['ghost-node'] })
        .catch(() => undefined);
      await sleep(50);
      expect(brokenWiring.capturedResponses).toHaveLength(2);
      await expect(settleWithin(second, 250)).resolves.toBe('pending');
      expect(
        debugSpy.mock.calls.some((call) =>
          String(call[0]).includes('响应 request_id 无配对挂起命令，丢弃'),
        ),
      ).toBe(true);

      // 清理：用捕获到的真实响应（正确 request_id）收口两条悬挂 pending，避免跨用例悬挂
      brokenWiring.setMode('pass');
      for (const response of brokenWiring.capturedResponses) {
        brokenWiring.dispatcher.consumeResponsePayload(response);
      }
      await expect(first).resolves.toMatchObject({
        ok: true,
        response: { command: 'canvas.group.create', error: { code: 'node_not_found' } },
      });
      await expect(second).resolves.toMatchObject({
        ok: true,
        response: { command: 'canvas.group.create', error: { code: 'node_not_found' } },
      });
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe('链路 B：画布命令 / 任务取消全链', () => {
  it('canvas group create 全链：真实 store 建成员 → CLI → 控制服务 → 分发器 → 接收器建组 → 响应回 CLI（CLI-010 主链）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10);
    const requestsBefore = getWiring().capturedRequests.length;

    const result = await runCli([
      'canvas',
      'group',
      'create',
      '--project',
      OPEN_PROJECT_NAME,
      '--name',
      '接缝组',
      '--members',
      `${memberA},${memberB}`,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.group.create') {
      throw new Error(`expected canvas.group.create success response, got ${result.stdout}`);
    }
    // 分发器真实发出了命令载荷（主进程 → 画布窗口腿）
    expect(getWiring().capturedRequests.length).toBe(requestsBefore + 1);
    // 新组 id 即真实 store 中创建的组节点 id；成员归属指向新组
    const graph = useCanvasStore.getState().nodeGraph;
    const groupNode = graph?.nodes.find((candidate) => candidate.id === response.group_node_id);
    expect(groupNode?.type).toBe('group');
    expect(groupNodes()).toHaveLength(1);
    expect(graph?.nodes.find((candidate) => candidate.id === memberA)?.groupId).toBe(
      response.group_node_id,
    );
    expect(graph?.nodes.find((candidate) => candidate.id === memberB)?.groupId).toBe(
      response.group_node_id,
    );
    // 组名经 renameGroup 落到组节点（CLI-010 与画布节点组 spec 同语义）
    expect((groupNode?.data as { name?: string }).name).toBe('接缝组');
  });

  it('canvas group dissolve 全链：CLI 建组 → CLI 解散 → 组节点删除、成员保留原位且归属解除（CLI-027 主链）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10);
    const created = await runCli([
      'canvas', 'group', 'create',
      '--project', OPEN_PROJECT_NAME,
      '--name', '待解散组',
      '--members', `${memberA},${memberB}`,
      '--json',
    ]);
    expect(created.exitCode).toBe(0);
    const createdResponse = parseCliResponse(created);
    if (!createdResponse.ok || createdResponse.command !== 'canvas.group.create') {
      throw new Error(`expected canvas.group.create success response, got ${created.stdout}`);
    }
    const groupId = createdResponse.group_node_id;
    expect(useCanvasStore.getState().nodeGraph?.nodes.find((c) => c.id === memberA)?.groupId).toBe(groupId);
    // 解散走真实全链：CLI → 控制服务 → 分发器 → 接收器 → 删除咽喉 removeNodes
    const dissolved = await runCli([
      'canvas', 'group', 'dissolve',
      '--project', OPEN_PROJECT_NAME,
      '--group', groupId,
      '--json',
    ]);
    expect(dissolved.exitCode).toBe(0);
    const response = parseCliResponse(dissolved);
    if (!response.ok || response.command !== 'canvas.group.dissolve') {
      throw new Error(`expected canvas.group.dissolve success response, got ${dissolved.stdout}`);
    }
    expect(response.dissolved).toBe(true);
    expect(response.group_node_id).toBe(groupId);
    expect(response.member_ids).toEqual([memberA, memberB]);
    // 解散语义（画布节点组 spec「解散」）：组节点删除，成员保留原位、归属解除
    const graph = useCanvasStore.getState().nodeGraph;
    expect(graph?.nodes.find((c) => c.id === groupId)).toBeUndefined();
    expect(groupNodes()).toHaveLength(0);
    expect(graph?.nodes.find((c) => c.id === memberA)).toMatchObject({ groupId: undefined, position: { x: 10, y: 10 } });
    expect(graph?.nodes.find((c) => c.id === memberB)).toMatchObject({ groupId: undefined, position: { x: 300, y: 10 } });
  });

  it('canvas layout --order 全链：CLI 建组建员 → 显式顺序整理组内 → 成员按指定序占格（CLI-030 主链）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10), memberC = createMemberNodeViaStoreAction(600, 10);
    const created = await runCli([
      'canvas', 'group', 'create',
      '--project', OPEN_PROJECT_NAME,
      '--name', '顺序组',
      '--members', `${memberA},${memberB},${memberC}`,
      '--json',
    ]);
    expect(created.exitCode).toBe(0);
    const createdResponse = parseCliResponse(created);
    if (!createdResponse.ok || createdResponse.command !== 'canvas.group.create') {
      throw new Error(`expected canvas.group.create success response, got ${created.stdout}`);
    }
    const groupId = createdResponse.group_node_id;
    const result = await runCli([
      'canvas', 'layout',
      '--project', OPEN_PROJECT_NAME,
      '--scope', `group:${groupId}`,
      '--order', `${memberC},${memberA}`,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'canvas.layout') {
      throw new Error(`expected canvas.layout success response, got ${result.stdout}`);
    }
    const graph = useCanvasStore.getState().nodeGraph;
    const yOf = (id: string): number => {
      const node = graph?.nodes.find((c) => c.id === id);
      if (!node) throw new Error(`node missing: ${id}`);
      return node.position.y;
    };
    // order 首位 memberC 占第一行（y 最小），其次 memberA；未指定的 memberB 跟排最后
    expect(Object.keys(response.positions).sort()).toEqual([memberA, memberB, memberC].sort());
    expect(yOf(memberC)).toBeLessThan(yOf(memberA));
    expect(yOf(memberA)).toBeLessThan(yOf(memberB));
    for (const [nodeId, position] of Object.entries(response.positions)) {
      const node = graph?.nodes.find((c) => c.id === nodeId);
      expect(node?.position).toEqual(position);
    }
  });

  it('task cancel 有窗形态全链：CLI → 代理通道 → 真实接收器 → 用户取消链受理 → 响应回 CLI（CLI-012 有窗形态主链）', async () => {
    // 取消受理响应按 TaskCancelAcceptedResponseSchema 构造并当场 parse（真实 HTTP 边界语义）
    const accepted = TaskCancelAcceptedResponseSchema.parse({
      accepted: true,
      task_id: 'task-seam-cancel-1',
      cancelled_at: '2026-10-07T00:00:00.000Z',
    });
    cancelTaskMock.mockResolvedValue(accepted);

    const result = await runCli(['task', 'cancel', 'task-seam-cancel-1', '--project', OPEN_PROJECT_NAME, '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'task.cancel') {
      throw new Error(`expected task.cancel success response, got ${result.stdout}`);
    }
    expect(response.accepted).toBe(true);
    expect(response.task_id).toBe('task-seam-cancel-1');
    expect(response.cancelled_at).toBe('2026-10-07T00:00:00.000Z');
    // 走的是代理执行通道（用户取消链），不是运行域取消端点
    expect(cancelTaskMock).toHaveBeenCalledTimes(1);
    expect(cancelTaskMock.mock.calls[0]?.[0]).toBe('task-seam-cancel-1');
  });

  it('画布命令项目未打开守卫：CLI 收到 project_not_open，画布无任何写入、代理通道未被触达（CLI-007 主链）', async () => {
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;
    const requestsBefore = getWiring().capturedRequests.length;

    const result = await runCli([
      'canvas',
      'group',
      'create',
      '--project',
      closedProjectDir,
      '--name',
      '不该存在的组',
      '--members',
      'ghost-node',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    const error = parseCliFailure(result);
    expect(error.code).toBe('project_not_open');
    // 编辑域存储无任何写入、命令未进入代理执行通道
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
    expect(groupNodes()).toHaveLength(0);
    expect(getWiring().capturedRequests.length).toBe(requestsBefore);
  });
});

// ---------------------------------------------------------------------------
// 链路 C：generate 主链（程序化提交 → 受理回执 → 任务节点投影）
// ---------------------------------------------------------------------------

describe('链路 C：generate 主链（程序化提交）', () => {
  it('generate 全链：CLI → 代理通道 → 程序化提交 → 契约形状受理 → 任务节点投影落位 → 创作面草稿不变（CLI-008 主链可测部分）', async () => {
    // 媒体资产与模型目录种床（真实 store 状态；mediaAsset/catalogEntry 沿 cliProxyReceiver.generate.test.ts）
    const mediaAsset = {
      id: 'asset_seam_1',
      mediaType: 'image',
      original: {
        url: `local-media://seam/asset_seam_1.png`,
        projectRef: null,
        fileKey: 'asset_seam_1.png',
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
    };
    useCanvasStore.setState((state) => {
      state.mediaAssets = { asset_seam_1: mediaAsset };
    });
    usePromptDockStore.setState({
      catalog: [
        // 真实目录形状：带一个多张参考位。seam 若用不带素材位的退化条目，`--ref` 的用途判据
        // 恒不生效，用途链断裂在 seam 层不可见（0.6.5 回归的漏网位置）。
        createCatalogEntryWithSlots(multiImageRefSlots, { model_id: 'seam-model-a' }),
      ],
    });
    // 用户正在编辑的草稿快照（CLI-008「草稿不变」断言基线）
    const draftBefore = usePromptDockStore.getState().draft;

    // 提交受理替身：响应按 PromptDockBatchSubmitResponseSchema 字段构造并当场 parse——
    // 真实 HTTP 边界（promptDockApi）正是这样把响应喂给下游的；字段从 schema 产生，
    // 构造漂移会在 parse 处立刻炸红而不是静默流入投影。
    const buildAcceptanceResponse = (batchId: string, taskIds: string[]) =>
      PromptDockBatchSubmitResponseSchema.parse({
        batch_id: batchId,
        intent_snapshot: {
          batch_id: batchId,
          model_id: 'seam-model-a',
          model_version: '1.0.0',
          prompt: '一只猫在窗台',
          params: {},
          task_count: taskIds.length,
          task_ids: taskIds,
          created_at: '2026-10-07T00:00:00.000Z',
        },
        tasks: taskIds.map((task_id, index) => ({ task_id, task_index: index })),
      });
    const submitRequests: unknown[] = [];
    submitGenerationBatchMock.mockImplementation(async (request) => {
      submitRequests.push(request);
      return buildAcceptanceResponse('batch-seam-1', ['task_seam_1', 'task_seam_2']);
    });

    const result = await runCli([
      'generate',
      '--project',
      OPEN_PROJECT_NAME,
      '--prompt',
      '一只猫在窗台',
      '--model',
      'seam-model-a',
      '--count',
      '2',
      '--ref',
      'asset_seam_1',
      '--arg',
      'size=1024x1024',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'generate') {
      throw new Error(`expected generate success response, got ${result.stdout}`);
    }
    expect(response.batch_id).toBe('batch-seam-1');
    expect(response.tasks.map((task) => task.task_id)).toEqual(['task_seam_1', 'task_seam_2']);
    // 受理回执是任务节点投影的唯一创建触发事实：画布出现任务节点投影（与界面提交一致）
    expect(findTaskNodeData('task_seam_1')?.batchId).toBe('batch-seam-1');
    expect(findTaskNodeData('task_seam_2')?.batchId).toBe('batch-seam-1');
    // 提交只发生一次：不自动重试（提交受理非幂等，spec §5.4）
    expect(submitGenerationBatchMock).toHaveBeenCalledTimes(1);
    expect(submitRequests[0]).toMatchObject({
      model_id: 'seam-model-a',
      task_count: 2,
      reference_asset_ids: ['asset_seam_1'],
      project_path: openProjectDir,
    });
    // 程序化提交不读写创作面草稿、不触发创作面 UI 状态（spec §6.4/§13）
    expect(usePromptDockStore.getState().draft).toEqual(draftBefore);
    expect(usePromptDockStore.getState().submitting).toBe(false);
    expect(usePromptDockStore.getState().preflightIssues).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 链路 D：app status 应用状态感知（CLI-020/CLI-021：主进程直答打开集合 + 代理只读查询选中态）
// ---------------------------------------------------------------------------

describe('链路 D：app status 应用状态感知（CLI-020/CLI-021 主链）', () => {
  it('选中态全链：真实 store 选中 → CLI → 控制服务 → 代理只读查询 → 接收器直读 store → 分类型回传（CLI-021 主链）', async () => {
    // 输入从真实链路源头产生：节点经真实 addNode action 创建，选中经真实
    // projectSelectionContract action 建立（与界面选择投影同一入口），不手工构造理想输入。
    const memberA = createMemberNodeViaStoreAction(10, 10);
    const memberB = createMemberNodeViaStoreAction(300, 10);
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [memberA, memberB],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
    const storeBefore = useCanvasStore.getState();
    const requestsBefore = getWiring().capturedRequests.length;

    const result = await runCli(['app', 'status', '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${result.stdout}`);
    }
    const entry = response.opened_projects.find((project) => project.path === openProjectDir);
    // 响应选中态 == store 真相源现值（分类型：节点/注释），且真实选中了两个节点
    const storeAfter = useCanvasStore.getState();
    expect(storeAfter.selectedNodeIds).toHaveLength(2);
    expect(entry?.selection).toEqual({
      node_ids: [...storeAfter.selectedNodeIds],
      annotation_ids: [...storeAfter.selectedAnnotationIds],
    });
    expect(entry).toMatchObject({ name: OPEN_PROJECT_NAME, focused: true });
    // 代理只读命令真实发出（主进程 → 画布窗口腿）
    expect(getWiring().capturedRequests.length).toBe(requestsBefore + 1);
    expect(getWiring().capturedRequests.at(-1)).toMatchObject({ command: 'canvas.selection.get' });
    // 只读不写：历史与画布结构不变（不进撤销栈、不产生任何写入，spec §6.3 只读查询条款）
    expect(useCanvasStore.getState().history.length).toBe(storeBefore.history.length);
    expect(useCanvasStore.getState().historyIndex).toBe(storeBefore.historyIndex);
    expect(
      (useCanvasStore.getState().nodeGraph?.nodes.length ?? 0) === (storeBefore.nodeGraph?.nodes.length ?? 0),
    ).toBe(true);
  });

  it('人读输出：逐项列出名称/路径/焦点标记/选中摘要（CLI-020 人读形态）', async () => {
    const memberA = createMemberNodeViaStoreAction(10, 10);
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [memberA],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });

    const result = await runCli(['app', 'status']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('已打开 1 个项目');
    expect(result.stdout).toContain(OPEN_PROJECT_NAME);
    expect(result.stdout).toContain(openProjectDir);
    expect(result.stdout).toContain('持有焦点');
    expect(result.stdout).toContain('选中节点 1 个');
  });

  it('多项目并存逐项列出，焦点标记按查询时点逐窗口判定（CLI-020 主链）', async () => {
    seamState.extraOpenProjectPaths = [closedProjectDir];
    seamState.focusedProjectPath = closedProjectDir;

    const result = await runCli(['app', 'status', '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${result.stdout}`);
    }
    expect(response.opened_projects.map((project) => project.path)).toEqual([openProjectDir, closedProjectDir]);
    expect(response.opened_projects.map((project) => project.focused)).toEqual([false, true]);
    // 名称：注册表在册名优先；未在册项目回退路径末段（两项目都在注册表 fixture 中）
    expect(response.opened_projects.map((project) => project.name)).toEqual([OPEN_PROJECT_NAME, CLOSED_PROJECT_NAME]);
  });

  it('无项目打开 → 空集合且命令成功，不触达代理通道（CLI-020）', async () => {
    seamState.openWindowProjectPath = null;
    seamState.extraOpenProjectPaths = [];
    const requestsBefore = getWiring().capturedRequests.length;

    const result = await runCli(['app', 'status', '--json']);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${result.stdout}`);
    }
    expect(response.opened_projects).toEqual([]);
    expect(getWiring().capturedRequests.length).toBe(requestsBefore);
  });

  it('画布未就绪两形态 → 选中态 null 且命令成功（CLI-021）：页面加载中不分发查询；nodeGraph 未载入由接收器回 null', async () => {
    // 形态 1：画布页面仍在加载（主进程侧 isLoading）→ 不向该窗口分发查询，选中态 null
    seamState.canvasLoading = true;
    const requestsBefore = getWiring().capturedRequests.length;
    const loadingResult = await runCli(['app', 'status', '--json']);
    expect(loadingResult.exitCode).toBe(0);
    const loadingResponse = parseCliResponse(loadingResult);
    if (!loadingResponse.ok || loadingResponse.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${loadingResult.stdout}`);
    }
    expect(loadingResponse.opened_projects).toHaveLength(1);
    expect(loadingResponse.opened_projects[0]?.selection).toBeNull();
    expect(getWiring().capturedRequests.length).toBe(requestsBefore);

    // 形态 2：页面已加载完但画布数据未就绪（nodeGraph null）→ 查询分发到接收器，原路返回 selection null
    seamState.canvasLoading = false;
    useCanvasStore.setState((state) => {
      state.nodeGraph = null;
      state.selectedNodeIds = [];
      state.selectedAnnotationIds = [];
    });
    const notReadyResult = await runCli(['app', 'status', '--json']);
    expect(notReadyResult.exitCode).toBe(0);
    const notReadyResponse = parseCliResponse(notReadyResult);
    if (!notReadyResponse.ok || notReadyResponse.command !== 'app.status') {
      throw new Error(`expected app.status success response, got ${notReadyResult.stdout}`);
    }
    expect(notReadyResponse.opened_projects).toHaveLength(1);
    expect(notReadyResponse.opened_projects[0]?.selection).toBeNull();
    expect(getWiring().capturedRequests.length).toBe(requestsBefore + 1);
    expect(getWiring().capturedRequests.at(-1)).toMatchObject({ command: 'canvas.selection.get' });
  });
});

// ---------------------------------------------------------------------------
// 链路 E：asset import 素材导入全链（CLI-047）
// ---------------------------------------------------------------------------

// 假 storage IPC 桥（Electron 桥边界替身，沿 cliProxyReceiver.assetImport.test.ts 惯例）：
// 真实链路里 storage:* 通道由 preload 暴露、Main 存储服务实现；本接缝只提供按契约构造的
// 响应。挂/卸时机：共享 beforeEach 的 resetStores（loadNodeGraph）依赖 window.electron
// 缺席判定非 Hub 运行时、不拉启动设置，故本 describe 在用例级挂桥、afterEach 卸桥
// （内层 afterEach 先于下一用例的共享 beforeEach 执行）。
// 另：图片尺寸测量用的 Image 是 node 环境缺失的浏览器原语（真实窗口由浏览器提供），
// 按界面语义替身；缩略图生成的远端边界已由文件级 vi.mock 挡掉。

type ReadFileBytesInvoke = (args: StorageReadFileBytesParams) => Promise<StorageReadFileBytesResult>;
type ImportLocalMediaInvoke = (args: StorageImportLocalMediaParams) => Promise<StorageImportLocalMediaResult>;
type UpsertMediaAssetInvoke = (args: StorageUpsertMediaAssetParams) => Promise<StorageUpsertMediaAssetResult>;

const readFileBytesMock = vi.fn<ReadFileBytesInvoke>();
const importLocalMediaMock = vi.fn<ImportLocalMediaInvoke>();
const upsertMediaAssetMock = vi.fn<UpsertMediaAssetInvoke>();

/** 真实可解析的 1x1 PNG 字节（存储边界返回什么，导入链就原样消费什么）。 */
const SEAM_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SEAM_PNG_BYTES = Buffer.from(SEAM_PNG_BASE64, 'base64').length;

/** 挂载假 storage IPC 桥 + 浏览器 Image 原语替身（见上方时机说明）。 */
const installFakeStorageBridge = (): void => {
  vi.stubGlobal('window', {
    electron: {
      storage: {
        'storage:read-file-bytes': (args: StorageReadFileBytesParams) => readFileBytesMock(args),
        'storage:import-local-media': (args: StorageImportLocalMediaParams) => importLocalMediaMock(args),
        'storage:upsert-media-asset': (args: StorageUpsertMediaAssetParams) => upsertMediaAssetMock(args),
      },
    },
  });
  vi.stubGlobal(
    'Image',
    class SeamMeasurementImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
};

/** 存储侧资产登记结果（形状对齐 MediaAsset 契约，字段语义同 schema）。 */
const buildStoredMediaAsset = (overrides: {
  id: string;
  mediaType: MediaAsset['mediaType'];
  url: string;
  width?: number | null;
  height?: number | null;
}): MediaAsset => ({
  id: overrides.id,
  mediaType: overrides.mediaType,
  original: {
    url: overrides.url,
    projectRef: null,
    fileKey: overrides.url.startsWith('local-media://') ? overrides.url.slice('local-media://'.length) : null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType:
      overrides.mediaType === 'image' ? 'image/png' : overrides.mediaType === 'audio' ? 'audio/mpeg' : 'video/mp4',
    sizeBytes: SEAM_PNG_BYTES,
    width: overrides.width ?? null,
    height: overrides.height ?? null,
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
  lifecycle: { createdAt: 1, updatedAt: 1 },
});

describe('链路 E：asset import 素材导入全链（CLI-047）', () => {
  beforeEach(() => {
    readFileBytesMock.mockReset();
    importLocalMediaMock.mockReset();
    upsertMediaAssetMock.mockReset();
    installFakeStorageBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asset import 全链：CLI → 控制服务 → 执行器 → 分发器 → 接收器真实执行 → 既有导入链写盘登记 → 图片素材节点落图 → 响应回 CLI（CLI-047 主链）', async () => {
    const photoPath = path.join(tempRoot, '导入源', 'cli-photo.png');
    readFileBytesMock.mockResolvedValue({ dataBase64: SEAM_PNG_BASE64, sizeBytes: SEAM_PNG_BYTES });
    importLocalMediaMock.mockResolvedValue({
      url: 'local-media://image/cli-photo.png',
      fileName: 'cli-photo.png',
      isNew: true,
      sizeBytes: SEAM_PNG_BYTES,
    });
    upsertMediaAssetMock.mockResolvedValue({
      assetId: 'asset_seam_import_1',
      asset: buildStoredMediaAsset({
        id: 'asset_seam_import_1',
        mediaType: 'image',
        url: 'local-media://image/cli-photo.png',
        width: 800,
        height: 600,
      }),
    });
    const requestsBefore = getWiring().capturedRequests.length;
    const responsesBefore = getWiring().capturedResponses.length;
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;

    const result = await runCli([
      'asset', 'import',
      '--project', OPEN_PROJECT_NAME,
      '--file', photoPath,
      '--json',
    ]);

    // B 命令面：CLI --json 成功响应 = 完整 CliCommandResponse，逐条过契约 schema
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'asset.import') {
      throw new Error(`expected asset.import success response, got ${result.stdout}`);
    }
    expect(response.imported).toHaveLength(1);
    const entry = response.imported[0];
    if (entry === undefined) throw new Error('expected one imported entry');
    expect(entry).toMatchObject({
      file_name: 'cli-photo.png',
      asset_id: 'asset_seam_import_1',
      media_type: 'image',
    });

    // C 代理面（主进程 → 画布窗口腿）：分发器真实发出的命令载荷过 CliProxyCommandSchema
    expect(getWiring().capturedRequests.length).toBe(requestsBefore + 1);
    const command = CliProxyCommandSchema.parse(getWiring().capturedRequests.at(-1));
    if (command.command !== 'asset.import') {
      throw new Error(`expected asset.import proxy command, got ${JSON.stringify(command)}`);
    }
    expect(command.file).toEqual([photoPath]);
    // C 代理面（画布窗口 → 主进程腿）：接收器真实产出的响应载荷独立过 CliProxyCommandResponseSchema
    //（接收器发送前已自校验；此处再喂消费者同一份契约 schema，防形状漂移），imported 与 B 面一致
    expect(getWiring().capturedResponses.length).toBe(responsesBefore + 1);
    const proxyResponse = CliProxyCommandResponseSchema.parse(getWiring().capturedResponses.at(-1));
    expect(proxyResponse).toMatchObject({ command: 'asset.import', request_id: command.request_id });
    if (!('imported' in proxyResponse)) throw new Error('expected proxy asset.import result payload');
    expect(proxyResponse.imported).toEqual(response.imported);

    // 画布产物：素材节点经真实 addNode 落图（类型 + 资产标识 + 持久化 URL，与界面拖入同一 data 形状）
    const graph = useCanvasStore.getState().nodeGraph;
    expect(graph?.nodes.length).toBe(nodesBefore + 1);
    const node = graph?.nodes.find((candidate) => candidate.id === entry.node_id);
    expect(node?.type).toBe('imageInput');
    expect(node?.data).toMatchObject({
      assetId: 'asset_seam_import_1',
      imageUrl: 'local-media://image/cli-photo.png',
      valueSource: 'upload',
    });

    // storage 边界载荷：读字节 → 写盘登记（原始文件名 + MIME）→ 资产登记（图片尺寸对齐界面语义）
    expect(readFileBytesMock).toHaveBeenCalledTimes(1);
    expect(readFileBytesMock).toHaveBeenCalledWith({ filePath: photoPath });
    expect(importLocalMediaMock).toHaveBeenCalledWith({
      projectPath: openProjectDir,
      fileDataBase64: SEAM_PNG_BASE64,
      mimeType: 'image/png',
      originalFileName: 'cli-photo.png',
    });
    const upsertCall = upsertMediaAssetMock.mock.calls[0]?.[0];
    expect(upsertCall?.projectPath).toBe(openProjectDir);
    expect(upsertCall?.params).toMatchObject({
      mediaType: 'image',
      url: 'local-media://image/cli-photo.png',
      sourceFileName: 'cli-photo.png',
      width: 800,
      height: 600,
    });

    // 整批导入合批（与界面导入同机制）：合批位已复位，一步撤销移除导入节点
    expect(useCanvasStore.getState().historyBatchActive).toBe(false);
    useCanvasStore.getState().undo();
    expect(
      useCanvasStore.getState().nodeGraph?.nodes.find((candidate) => candidate.id === entry.node_id),
    ).toBeUndefined();
  });

  it('asset import --file 可重复且路径不按逗号拆分（pathList）：批量逐文件建对应类型素材节点、整批排成一块、一步撤销（CLI-047 参数面 + 批量链）', async () => {
    // 带逗号路径：pathList 语义整项原样累积——若被当 stringList 拆分会立刻断链（读字节未命中）
    const imagePath = path.join(tempRoot, '导入源,备份', 'cli-photo,副本.png');
    const audioPath = path.join(tempRoot, '导入源', 'cli-voice.mp3');
    readFileBytesMock.mockImplementation(async (args) => {
      if (args.filePath === imagePath) return { dataBase64: SEAM_PNG_BASE64, sizeBytes: SEAM_PNG_BYTES };
      if (args.filePath === audioPath) return { dataBase64: 'BwgJ', sizeBytes: 3 };
      throw new Error(`unexpected path: ${args.filePath}`);
    });
    importLocalMediaMock.mockImplementation(async (args) => ({
      url: `local-media://${args.originalFileName}`,
      fileName: args.originalFileName,
      isNew: true,
      sizeBytes: 3,
    }));
    upsertMediaAssetMock.mockImplementation(async (args) => ({
      assetId: `asset_seam_${args.params.mediaType}`,
      asset: buildStoredMediaAsset({
        id: `asset_seam_${args.params.mediaType}`,
        mediaType: args.params.mediaType,
        url: args.params.url,
      }),
    }));

    const result = await runCli([
      'asset', 'import',
      '--project', OPEN_PROJECT_NAME,
      '--file', imagePath,
      '--file', audioPath,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const response = parseCliResponse(result);
    if (!response.ok || response.command !== 'asset.import') {
      throw new Error(`expected asset.import success response, got ${result.stdout}`);
    }
    // 按输入顺序逐文件回传：文件名含逗号原样保留（未被拆分），媒体类型按扩展名判定
    expect(response.imported.map((entry) => [entry.file_name, entry.media_type])).toEqual([
      ['cli-photo,副本.png', 'image'],
      ['cli-voice.mp3', 'audio'],
    ]);
    const command = CliProxyCommandSchema.parse(getWiring().capturedRequests.at(-1));
    if (command.command !== 'asset.import') {
      throw new Error(`expected asset.import proxy command, got ${JSON.stringify(command)}`);
    }
    expect(command.file).toEqual([imagePath, audioPath]);

    // 节点类型一一对应；同批排成一块（同行 y 相同、横向步进）
    const graph = useCanvasStore.getState().nodeGraph;
    const nodes = response.imported.map((entry) =>
      graph?.nodes.find((candidate) => candidate.id === entry.node_id),
    );
    expect(nodes.map((node) => node?.type)).toEqual(['imageInput', 'audioInput']);
    const positions = nodes.map((node) => node?.position);
    expect(positions[0]?.y).toBe(positions[1]?.y);
    expect(positions[1]?.x ?? 0).toBeGreaterThan(positions[0]?.x ?? 0);

    // 整批一条撤销：一次 undo 移除全部导入节点（合批语义）
    useCanvasStore.getState().undo();
    for (const entry of response.imported) {
      expect(
        useCanvasStore.getState().nodeGraph?.nodes.find((candidate) => candidate.id === entry.node_id),
      ).toBeUndefined();
    }
  });

  it('asset import 文件不可读：画布侧前置校验 file_not_found 一路透传到 CLI 响应、点名文件，零写盘零建节点（CLI-047 错误链）', async () => {
    const readablePath = path.join(tempRoot, '导入源', 'cli-photo.png');
    const missingPath = path.join(tempRoot, '导入源', 'missing-photo.png');
    readFileBytesMock.mockImplementation(async (args) => {
      if (args.filePath === readablePath) return { dataBase64: SEAM_PNG_BASE64, sizeBytes: SEAM_PNG_BYTES };
      throw new Error(`ENOENT: no such file or directory, open '${args.filePath}'`);
    });
    const responsesBefore = getWiring().capturedResponses.length;
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;
    const historyBefore = useCanvasStore.getState().history.length;

    const result = await runCli([
      'asset', 'import',
      '--project', OPEN_PROJECT_NAME,
      '--file', readablePath,
      '--file', missingPath,
      '--json',
    ]);

    // CLI 面：退出码 1 + file_not_found，message 点名不可读文件（错误源自画布侧前置校验、原样透传）
    expect(result.exitCode).toBe(1);
    const error = parseCliFailure(result);
    expect(error.code).toBe('file_not_found');
    expect(error.message).toContain(missingPath);
    // C 代理面：接收器真实产出的响应载荷同为 file_not_found（同一响应独立过契约 schema）
    expect(getWiring().capturedResponses.length).toBe(responsesBefore + 1);
    const proxyResponse = CliProxyCommandResponseSchema.parse(getWiring().capturedResponses.at(-1));
    expect(proxyResponse).toMatchObject({ command: 'asset.import', error: { code: 'file_not_found' } });
    if (!('error' in proxyResponse)) throw new Error('expected proxy asset.import error payload');
    expect(proxyResponse.error.message).toContain(missingPath);

    // 前置校验原子性（零副作用）：可读文件先被读过（整批校验先于任何写入），第二件失败即整体拒绝，
    // 不发生任何写盘/登记/建节点/入历史
    expect(readFileBytesMock).toHaveBeenCalledTimes(2);
    expect(importLocalMediaMock).not.toHaveBeenCalled();
    expect(upsertMediaAssetMock).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
    expect(useCanvasStore.getState().historyBatchActive).toBe(false);
  });
});
