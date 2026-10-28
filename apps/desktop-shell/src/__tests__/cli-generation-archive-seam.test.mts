// @vitest-environment node
// @spec: CLI-038, CLI-039, CLI-040, CLI-041, CLI-042, CLI-050
//
// 生成档案读取接缝测试（spec docs/integrations/CLI与本地Agent集成.md §5.2 batch get /
// asset get 内联 / task get 内联、§5.5 --version、解析失败输出口径）。
//
// 使命：把「CLI 客户端 → 本地控制服务（真实 HTTP）→ 执行器 → 存储读取函数 → 真实 SQLite
// 项目库」主链在生成档案维度真实跑通一遍（AGENTS.md 接缝范式：真实引擎 + 真实适配器 +
// 假 HTTP 上游，只在外层挡掉网络与真实数据库/存储）：
// - 真实存储：临时项目目录 + 真实 DDL（dist initSchema）+ 真实写路径（dist
//   executeRuntimeTransaction 写批次行/任务行/资产行/task_outputs）——读取链的记录由真实
//   写路径产生，不由测试徒手构造后喂给被测函数；
// - 真实读取链：执行器 storage 依赖注入真实 read-model 读函数（dist readBatchById /
//   readTaskById / readTaskOutputAssetIndex / readMediaAssetById），与生产 cli-storage-queries
//   同一底座；唯一替身点是「打开 db 的原生模块句柄」——desktop-shell 加载器固定 electron ABI
//   （sqlite-loader），vitest 纯 Node 进程装不上，改用 npm better-sqlite3（node ABI）打开
//   同一 project.sqlite 文件交给同一批真实读函数；
// - 真实执行器与控制服务：dist 模块、真实 HTTP（runCliClient → 127.0.0.1:<port>）；
// - 假 HTTP 上游仅一处：task get 的运行域任务读取——载荷由真实存储 readTaskById 产出
//   （真实数据源，只替 backend HTTP 传输段）。
//
// 不变量机械守护（CLI-038 单一构建出口）：batch get、asset get 内联、task get 内联三入口
// 的 generation 都经同一 CliGenerationArchiveSchema parse 且三处 deep-equal——任何一入口
// 少给字段（字段子集）测试即红。

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  CLI_COMMANDS,
  CliCommandResponseSchema,
  CliGenerationArchiveSchema,
  type CliGenerationArchive,
  type CliCommandResponse,
} from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const clientEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client.cjs`;
const serviceEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-control-service.cjs`;
const storageSchemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;
const runtimeWriterEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-runtime-writer.cjs`;
const readModelEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-read-model.cjs`;

type CliClientRunResult = { exitCode: number; stdout: string; stderr: string };
type ClientModule = {
  runCliClient: (
    argv: readonly string[],
    deps?: { discoveryFilePath?: string; pollIntervalMs?: number },
  ) => Promise<CliClientRunResult>;
};
type ServiceHandle = { port: number; discoveryFilePath: string; stop: () => Promise<void> };
type Db = InstanceType<typeof Database>;
type StorageSchemaModule = { initSchema: (db: unknown) => void };
type RuntimeWriterModule = {
  executeRuntimeTransaction: (db: unknown, payload: Record<string, unknown>) => { success: boolean; error?: string };
};
type ReadModelModule = {
  readBatchById: (db: unknown, batchId: string) => Record<string, unknown> | null;
  readTaskById: (db: unknown, taskId: string) => Record<string, unknown> | null;
  readTaskOutputAssetIndex: (db: unknown) => Map<string, string>;
  readMediaAssetsByTaskId: (db: unknown, taskId: string) => Record<string, unknown>[];
  readMediaAssetById: (db: unknown, assetId: string) => Record<string, unknown> | null;
  readAllMediaAssets: (db: unknown) => Record<string, unknown>[];
};

const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;
const loadServiceModule = (): Record<string, unknown> => requireDesktop(serviceEntry);
const loadStorageSchema = (): StorageSchemaModule => requireDesktop(storageSchemaEntry) as StorageSchemaModule;
const loadRuntimeWriter = (): RuntimeWriterModule => requireDesktop(runtimeWriterEntry) as RuntimeWriterModule;
const loadReadModel = (): ReadModelModule => requireDesktop(readModelEntry) as ReadModelModule;

// ── 夹具（标识全部为本地合成值，不含任何真实服务商域名） ─────────────────────────

const tempRoot = mkdtempSync(join(tmpdir(), "cli-archive-seam-"));
const projectPath = join(tempRoot, "archive-seam-project");
const discoveryFilePath = join(tempRoot, "cli-runtime.json");

/** 提交提示词全文（> 512 字符：任务 metadata 预览是 512 截断摘要，档案必须承载全文）。 */
const FULL_PROMPT = "黄昏的海岸线上，一艘白色帆船缓缓驶向落日，电影感构图，柔和的暖色光，胶片质感。".repeat(20);

const BATCH_ID = "batch-seam-1";
const BATCH_LEGACY_ID = "batch-seam-legacy";
/** 新快照：media_refs 自带资产身份/用途/字段绑定（2026-10-26 起的提交面形态）。 */
const BATCH_BOUND_ID = "batch-seam-bound";
const TASK_A = "task-seam-1";
const TASK_B = "task-seam-2";
const TASK_LEGACY = "task-seam-3";
const TASK_NO_BATCH = "task-seam-4";
const TASK_BOUND = "task-seam-5";
/** 生成产物资产（task_outputs 关联到 TASK_A）。 */
const OUT_ASSET_ID = "out-seam-asset-1";
const OUT_FILE_KEY = "cafebeef02.png";
/** 参考资产（现行批次：reference_asset_ids 直接携带）。 */
const REF_ASSET_ID = "ref-seam-asset-1";
const REF_FILE_KEY = "deadbeef01.png";
/** 参考资产（旧快照：只有 media_refs，由 fileKey 内容指纹反查）。 */
const REF2_ASSET_ID = "ref-seam-asset-2";
const REF2_FILE_KEY = "0123abcd04.png";

const makeMediaAssetPayload = (fileKey: string): string =>
  JSON.stringify({
    original: {
      url: `local-media://spid_0123456789abcdef01234567/${fileKey}`,
      projectRef: null,
      fileKey,
      sourceUrl: null,
      mimeType: fileKey.endsWith(".png") ? "image/png" : "image/jpeg",
      sizeBytes: 128,
      width: 8,
      height: 8,
      durationMs: null,
      fps: null,
      sourceFileName: null,
    },
    thumbnail: { url: null, mimeType: null, width: null, height: null, status: "missing", generatedAt: null, error: null },
  });

const makeBatchSnapshot = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  batch_id: BATCH_ID,
  model_id: "seam-model.example",
  model_version: "1.0.0",
  prompt: FULL_PROMPT,
  params: { aspect_ratio: "1:1", steps: "30" },
  task_count: 2,
  task_ids: [TASK_A, TASK_B],
  created_at: "2026-10-15T02:00:00.000Z",
  ...overrides,
});

// 红绿自证开关：BREAK_READ_CHAIN=1 时把执行器→存储读取链的批次读取断链（恒 null，
// 复现「未接线」状态）——用于先红证据；正常接线时不设置。
const BREAK_READ_CHAIN = process.env["BREAK_READ_CHAIN"] === "1";

let db: Db;
let serviceHandle: ServiceHandle | null = null;
let clientModule: ClientModule;

const seedRealRecords = (): void => {
  const schema = loadStorageSchema();
  const writer = loadRuntimeWriter();
  mkdirSync(projectPath, { recursive: true });
  db = new Database(join(projectPath, "project.sqlite"));
  schema.initSchema(db);
  const payload = {
    projectPath,
    transactionId: "tx-seam-1",
    type: "runtime:execute-transaction",
    tasks: [
      {
        taskId: TASK_A,
        status: "succeeded",
        projectPath,
        batchId: BATCH_ID,
        metadataJson: JSON.stringify({ batchId: BATCH_ID, taskIndex: 0 }),
        // 请求尺寸（multipart 摘要形态）16x9，真实产物 8x8：task wait 终态尺寸提示的接缝数据源。
        requestJson: JSON.stringify({
          method: "POST",
          body: {
            __formData: {
              kind: "form_data_summary",
              fieldCount: 1,
              fields: [{ name: "size", filename: null, contentType: null, hasDataBase64: false, value: "16x9" }],
            },
          },
        }),
        createdAt: 10,
        updatedAt: 20,
      },
      {
        taskId: TASK_B,
        status: "failed",
        projectPath,
        batchId: BATCH_ID,
        metadataJson: JSON.stringify({ batchId: BATCH_ID, taskIndex: 1 }),
        createdAt: 11,
        updatedAt: 21,
        errorMessage: "上游 example.invalid 返回失败",
      },
      {
        taskId: TASK_LEGACY,
        status: "succeeded",
        projectPath,
        batchId: BATCH_LEGACY_ID,
        metadataJson: JSON.stringify({ batchId: BATCH_LEGACY_ID, taskIndex: 0 }),
        createdAt: 12,
        updatedAt: 22,
      },
      {
        taskId: TASK_BOUND,
        status: "succeeded",
        projectPath,
        batchId: BATCH_BOUND_ID,
        metadataJson: JSON.stringify({ batchId: BATCH_BOUND_ID, taskIndex: 0 }),
        createdAt: 14,
        updatedAt: 24,
      },
      { taskId: TASK_NO_BATCH, status: "succeeded", projectPath, createdAt: 13, updatedAt: 23 },
    ],
    taskOutputs: [{ outputId: "out-seam-1", taskId: TASK_A, mediaType: "image", assetId: OUT_ASSET_ID, sortOrder: 0 }],
    mediaAssets: [
      { assetId: OUT_ASSET_ID, mediaType: "image", payloadJson: makeMediaAssetPayload(OUT_FILE_KEY), createdAt: 10, updatedAt: 20 },
      { assetId: REF_ASSET_ID, mediaType: "image", payloadJson: makeMediaAssetPayload(REF_FILE_KEY), createdAt: 10, updatedAt: 20 },
      { assetId: REF2_ASSET_ID, mediaType: "image", payloadJson: makeMediaAssetPayload(REF2_FILE_KEY), createdAt: 10, updatedAt: 20 },
    ],
    batches: [
      {
        batchId: BATCH_ID,
        payloadJson: JSON.stringify(
          makeBatchSnapshot({
            media_refs: [
              { media_kind: "image", source_kind: "attachment", value: `local-media://spid_0123456789abcdef01234567/${REF_FILE_KEY}`, mime_type: "image/png", filename: null },
            ],
            reference_asset_ids: [REF_ASSET_ID],
          }),
        ),
        clientRequestId: "req-seam-1",
        createdAt: 10,
        updatedAt: 20,
      },
      {
        batchId: BATCH_LEGACY_ID,
        payloadJson: JSON.stringify(
          makeBatchSnapshot({
            batch_id: BATCH_LEGACY_ID,
            task_count: 1,
            task_ids: [TASK_LEGACY],
            // 旧快照：无 reference_asset_ids，仅 media_refs（fileKey 内容指纹反查兜底路径）
            media_refs: [
              { media_kind: "image", source_kind: "attachment", value: `local-media://spid_0123456789abcdef01234567/${REF2_FILE_KEY}`, mime_type: "image/jpeg", filename: null },
            ],
          }),
        ),
        createdAt: 11,
        updatedAt: 21,
      },
      {
        batchId: BATCH_BOUND_ID,
        payloadJson: JSON.stringify(
          makeBatchSnapshot({
            batch_id: BATCH_BOUND_ID,
            task_count: 1,
            task_ids: [TASK_BOUND],
            // 参数表单把媒体位默认值（空数组）写进快照；媒体真实内容走 media_refs。
            params: { referenceImage: [], aspect_ratio: "16:9" },
            media_refs: [
              {
                media_kind: "image",
                source_kind: "attachment",
                value: `local-media://spid_0123456789abcdef01234567/${REF_FILE_KEY}`,
                mime_type: "image/png",
                filename: null,
                field_key: "referenceImage",
                asset_id: REF_ASSET_ID,
                slot_id: "reference_image",
              },
            ],
            reference_asset_ids: [REF_ASSET_ID],
          }),
        ),
        clientRequestId: "req-seam-bound",
        createdAt: 12,
        updatedAt: 22,
      },
    ],
  };
  const result = writer.executeRuntimeTransaction(db, payload);
  if (!result.success) throw new Error(`fixture seed failed: ${result.error ?? "unknown"}`);
};

// ── 真实执行器依赖（读取函数全部真实；断链开关只动注入点） ─────────────────────────

const buildExecutorDeps = (): Record<string, unknown> => {
  const readModel = loadReadModel();
  const readBatchById = BREAK_READ_CHAIN
    ? (_path: string, _batchId: string): unknown => null
    : (path: string, batchId: string): unknown => {
        if (path !== projectPath) return null;
        return readModel.readBatchById(db, batchId);
      };
  return {
    readProjects: () => [{ nodeGraphId: "ng-seam", name: "archive-seam-project", path: projectPath, createdAt: 1, savedAt: 2, lastOpenedAt: 3 }],
    windows: {
      openOrFocus: async () => ({ ok: true as const }),
      hasOpenWindow: () => false,
      closeByProjectPath: () => true,
      listOpenEditorProjects: () => [],
    },
    forwarder: {
      // 假 HTTP 上游：/api/tasks/:id 的载荷由真实存储 readTaskById 产出（真实数据源，
      // 只替 backend HTTP 传输段）；其余路径一律断网形态。
      getJson: async (pathname: string) => {
        const match = /^\/api\/tasks\/([^?]+)/.exec(pathname);
        if (match !== null) {
          const taskId = decodeURIComponent(match[1] ?? "");
          const view = readModel.readTaskById(db, taskId);
          if (view === null) return { ok: false as const, reason: "http_error", status: 404, detail: "not found" };
          return { ok: true as const, payload: { task: view } };
        }
        return { ok: false as const, reason: "network_error", detail: "seam: forwarder not wired" };
      },
      postJson: async () => ({ ok: false as const, reason: "network_error", detail: "seam: forwarder not wired" }),
    },
    storage: {
      createProject: () => ({ projectPath }),
      deleteProject: () => undefined,
      touchProjectOpenedAt: () => undefined,
      readMediaAssets: (path: string) => (path === projectPath ? readModel.readAllMediaAssets(db) : []),
      readMediaAssetById: (path: string, assetId: string) =>
        path === projectPath ? readModel.readMediaAssetById(db, assetId) : null,
      readAssetTaskIndex: (path: string) => (path === projectPath ? readModel.readTaskOutputAssetIndex(db) : new Map()),
      // task wait 的产物资产走真实读取链（task_outputs → media_assets）；尺寸提示据此对照请求尺寸。
      readTaskOutputAssets: (path: string, taskId: string) =>
        path === projectPath ? readModel.readMediaAssetsByTaskId(db, taskId) : [],
      readBatchByClientRequestId: () => null,
      readTaskViewsByBatchId: () => [],
      readTaskById: (path: string, taskId: string): unknown =>
        path === projectPath ? readModel.readTaskById(db, taskId) : null,
      readBatchById,
      readCanvasNodePayloads: () => [],
    },
    proxy: { dispatch: async () => ({ ok: false as const, reason: "no_window", detail: "seam: proxy not wired" }) },
  };
};

const startService = async (): Promise<void> => {
  const serviceModule = loadServiceModule();
  const start = serviceModule["startCliControlService"] as (options: Record<string, unknown>) => Promise<ServiceHandle>;
  serviceHandle = await start({
    port: 0,
    discoveryFilePath,
    version: "0.6.10-seam",
    executorDeps: buildExecutorDeps(),
  });
  clientModule = loadClientModule();
};

const runCli = async (argv: readonly string[]): Promise<CliClientRunResult> => {
  if (serviceHandle === null) throw new Error("service not started");
  return clientModule.runCliClient(argv, { discoveryFilePath: serviceHandle.discoveryFilePath });
};

/** CLI --json 成功输出 = 完整 CliCommandResponse，逐条过契约 schema（CLI-014 客户端侧口径）。 */
const parseCliResponse = (result: CliClientRunResult): CliCommandResponse => {
  const raw: unknown = JSON.parse(result.stdout);
  return CliCommandResponseSchema.parse(raw);
};

let batchArchive: CliGenerationArchive;

// 文件级清理：最后停服务、关库、删临时目录（不能挂在某个 describe 上——先行的 afterAll
// 会抢在下个 describe 跑完前删掉发现文件与服务）。
afterAll(async () => {
  await serviceHandle?.stop();
  db?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("生成档案读取接缝（真实存储 + 真实读取链 + 真实执行器，CLI-038/039/040）", () => {
  beforeAll(async () => {
    seedRealRecords();
    await startService();
  });

  it("batch get：批次快照投影为生成档案，prompt 承载全文（非 512 摘要）", async () => {
    const result = await runCli(["batch", "get", BATCH_ID, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "batch.get") throw new Error("unexpected response");
    const archive = CliGenerationArchiveSchema.parse(parsed.generation);
    expect(archive.batch_id).toBe(BATCH_ID);
    expect(archive.model_id).toBe("seam-model.example");
    expect(archive.prompt).toBe(FULL_PROMPT);
    expect(archive.prompt.length).toBeGreaterThan(512);
    expect(archive.params).toEqual({ aspect_ratio: "1:1", steps: "30" });
    expect(archive.task_ids).toEqual([TASK_A, TASK_B]);
    expect(archive.created_at).toBe("2026-10-15T02:00:00.000Z");
    expect(archive.references).toEqual([
      {
        asset_id: REF_ASSET_ID,
        media_kind: "image",
        file_key: REF_FILE_KEY,
        local_file_path: join(projectPath, "media", REF_FILE_KEY),
      },
    ]);
    batchArchive = archive;
  });

  it("asset get：生成产物内联同一档案（deep-equal batch get）", async () => {
    const result = await runCli(["asset", "get", OUT_ASSET_ID, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "asset.get") throw new Error("unexpected response");
    const archive = CliGenerationArchiveSchema.parse(parsed.generation);
    // 深等：任何一入口少给字段（字段子集）即红（CLI-038 单一构建出口的机械守护）。
    expect(archive).toEqual(batchArchive);
  });

  it("task get：任务内联同一档案（deep-equal batch get）", async () => {
    const result = await runCli(["task", "get", TASK_A, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "task.get") throw new Error("unexpected response");
    const archive = CliGenerationArchiveSchema.parse(parsed.generation);
    expect(archive).toEqual(batchArchive);
  });

  it("task wait：请求 16x9、真实产物 8x8 → warnings 非空，ok 与任务状态不变（CLI-050）", async () => {
    const result = await runCli(["task", "wait", TASK_A, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "task.wait") throw new Error("unexpected response");
    expect(parsed.task_result.task.status).toBe("succeeded");
    expect(parsed.task_result.assets).toHaveLength(1);
    expect(parsed.task_result.warnings).toEqual([
      {
        code: "requested_size_not_honored",
        message: "请求尺寸 16x9，实际产出 8x8。生成任务已成功，尺寸以实际产物为准。",
        requested_size: "16x9",
        actual_sizes: ["8x8"],
      },
    ]);
  });

  it("旧快照（无 reference_asset_ids）：由 media_refs fileKey 内容指纹反查资产", async () => {
    const result = await runCli(["task", "get", TASK_LEGACY, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "task.get") throw new Error("unexpected response");
    const archive = CliGenerationArchiveSchema.parse(parsed.generation);
    expect(archive.batch_id).toBe(BATCH_LEGACY_ID);
    expect(archive.references).toEqual([
      {
        asset_id: REF2_ASSET_ID,
        media_kind: "image",
        file_key: REF2_FILE_KEY,
        local_file_path: join(projectPath, "media", REF2_FILE_KEY),
      },
    ]);
  });

  it("新快照：media_refs 带资产身份与用途 → 引用带 slot_id/field_key，已绑定的参数键被剥离", async () => {
    const result = await runCli(["batch", "get", BATCH_BOUND_ID, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "batch.get") throw new Error("unexpected response");
    const archive = CliGenerationArchiveSchema.parse(parsed.generation);
    // 引用一次拿到资产 + 用途 + 字段绑定；reference_asset_ids 里的同一资产不重复追加。
    expect(archive.references).toEqual([
      {
        asset_id: REF_ASSET_ID,
        media_kind: "image",
        file_key: REF_FILE_KEY,
        local_file_path: join(projectPath, "media", REF_FILE_KEY),
        slot_id: "reference_image",
        field_key: "referenceImage",
      },
    ]);
    // 媒体位默认值（[]）与实际绑定并存会形成「有图却是空数组」的假事实，投影层剥离。
    expect(archive.params).toEqual({ aspect_ratio: "16:9" });
  });

  it("asset get：导入素材（无产出来源任务）不带 generation 字段", async () => {
    const result = await runCli(["asset", "get", REF_ASSET_ID, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "asset.get") throw new Error("unexpected response");
    expect(parsed.generation).toBeUndefined();
  });

  it("task get：任务无批次归属时缺省 generation 字段（回退现状）", async () => {
    const result = await runCli(["task", "get", TASK_NO_BATCH, "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = parseCliResponse(result);
    if (!parsed.ok || parsed.command !== "task.get") throw new Error("unexpected response");
    expect(parsed.task.taskId).toBe(TASK_NO_BATCH);
    expect(parsed.generation).toBeUndefined();
  });

  it("batch get：批次不存在 → batch_not_found（退出码 1，遵循 task get 未知 id 先例）", async () => {
    const result = await runCli(["batch", "get", "batch-ghost", "--project", projectPath, "--json"]);
    expect(result.exitCode).toBe(1);
    // 客户端错误 JSON 是文档化形状 { ok: false, error }（不带 command 信封）
    const raw: unknown = JSON.parse(result.stdout);
    expect(raw).toMatchObject({
      ok: false,
      error: { code: "batch_not_found", message: expect.stringContaining("批次 batch-ghost 不存在") },
    });
  });

  it("命令表共 33 条且含 batch.get / canvas.group.list / canvas.inspect / asset.import / canvas.node.create / canvas.group.rename（契约命令表守卫）", () => {
    expect(CLI_COMMANDS.length).toBe(33);
    expect(CLI_COMMANDS).toContain("canvas.group.list");
    expect(CLI_COMMANDS).toContain("canvas.inspect");
    expect(CLI_COMMANDS).toContain("batch.get");
    expect(CLI_COMMANDS).toContain("asset.import");
    expect(CLI_COMMANDS).toContain("canvas.node.create");
    expect(CLI_COMMANDS).toContain("canvas.group.rename");
  });
});

describe("--version 与解析失败输出口径（CLI-041/042）", () => {
  beforeAll(async () => {
    if (serviceHandle === null) {
      seedRealRecords();
      await startService();
    }
  });

  it("--version --json：输出发现在文件中的应用版本", async () => {
    const result = await runCli(["--version", "--json"]);
    expect(result.exitCode).toBe(0);
    const raw: unknown = JSON.parse(result.stdout);
    expect(raw).toEqual({ version: "0.6.10-seam" });
  });

  it("--version 人读模式：输出应用版本", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("IARTStudio 版本：");
  });

  it("参数解析失败：stderr 只给错误信息 + 单行用法指引，不全量倾倒 help", async () => {
    const result = await runCli(["task", "get"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("缺少必填参数");
    expect(result.stderr).toContain("用法见 iart --help");
    // CLI_USAGE_TEXT 的收尾行只出现在全量用法提示里——出现即说明又开始了全量倾倒
    expect(result.stderr).not.toContain("退出码：");
  });

  it("--help 行为不变（退出码 0，全量用法提示，含 batch get 与 --status 七枚举）", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("batch get");
    expect(result.stdout).toContain("--version");
    for (const status of ["submitting", "generating", "polling", "downloading", "succeeded", "failed", "cancelled"]) {
      expect(result.stdout).toContain(status);
    }
  });
});
