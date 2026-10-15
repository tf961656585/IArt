// @vitest-environment node
// @spec: CLI-014, CLI-015
//
// 只读查询命令执行器测试（假 forwarder + 假存储注入）：model.list/get 目录转发与投影、
// asset.list/get 存储只读投影与本地绝对路径、canvas.nodes.list 节点投影、
// task.list/get 代理转发与项目过滤、任务不存在错误码语义。
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliCommandRequestSchema, CliCommandResponseSchema } from "@iart/contracts/cli-contract";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const executorsEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-command-executors.cjs`;

type ExecutorResult = { response: unknown; errorCode: string | null };
type Executor = (request: unknown) => ExecutorResult | Promise<ExecutorResult>;
type Registry = Map<string, Executor>;
type ExecutorModule = { createCliCommandExecutors: (deps: Record<string, unknown>) => Registry };

const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;

const parseResponse = (result: ExecutorResult) => CliCommandResponseSchema.parse(result.response);

const runExecutor = async (registry: Registry, command: string, request: unknown): Promise<ExecutorResult> => {
  const executor = registry.get(command);
  if (executor === undefined) throw new Error(`executor missing: ${command}`);
  return await executor(CliCommandRequestSchema.parse(request));
};

const makeAsset = (assetId: string, fileKey: string) => ({
  assetId,
  mediaType: "image",
  original: { url: `local-media://spid_test/${fileKey}`, fileKey, mimeType: "image/png", width: 10, height: 10 },
  thumbnail: { url: null, status: "ready" },
  lifecycle: { createdAt: 1, updatedAt: 2 },
});

const PROJECT_PATH = join(tmpdir(), `cli-read-queries-proj-${process.pid}`);

type ForwardResponse = { ok: boolean; payload?: unknown; reason?: string; status?: number; detail?: string };

describe("cli-command-executors 只读查询（假 forwarder + 假存储）", () => {
  const modelEntry = {
    model_id: "demo-model",
    model_version: "1",
    default_task_type: "image",
    capability: { input_modalities: ["image"], output_modalities: ["image"] },
    parameter_schema: { fields: [], required_fields: [] },
    deployment: { has_active_deployment: true, active_deployment_id: "up_dep_x", deployable: true, failure_code: "none" },
  };
  let forwardResultOverride: ForwardResponse | null = null;
  const forwardPaths: string[] = [];

  const buildRegistry = (overrides: {
    storage?: Record<string, unknown>;
  } = {}): Registry => {
    const mod = loadExecutorModule();
    return mod.createCliCommandExecutors({
      readProjects: () => [{ nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 }],
      windows: {
        openOrFocus: async () => ({ ok: true }),
        hasOpenWindow: () => false,
        closeByProjectPath: () => true,
      },
      forwarder: {
        getJson: async (pathname: string) => {
          forwardPaths.push(pathname);
          if (forwardResultOverride !== null) {
            return forwardResultOverride.ok
              ? { ok: true, payload: forwardResultOverride.payload }
              : { ok: false, reason: forwardResultOverride.reason ?? "http_error", status: forwardResultOverride.status, detail: forwardResultOverride.detail ?? "x" };
          }
          return { ok: true, payload: {} };
        },
        postJson: async () => ({ ok: true, payload: {} }),
      },
      storage: {
        createProject: () => ({ projectPath: PROJECT_PATH }),
        deleteProject: () => undefined,
        touchProjectOpenedAt: () => undefined,
        readMediaAssets: () => [makeAsset("asset-1", "file-a.png"), makeAsset("asset-2", "file-b.png")],
        readMediaAssetById: (projectPath: string, assetId: string) => (assetId === "asset-1" ? makeAsset("asset-1", "file-a.png") : null),
        readAssetTaskIndex: () => new Map([["asset-1", "task-9"]]),
        readTaskOutputAssets: (_projectPath: string, taskId: string) => (taskId === "task-done" ? [makeAsset("asset-1", "file-a.png")] : []),
        readBatchByClientRequestId: () => null,
        readTaskViewsByBatchId: () => [],
        // 生成档案底座（CLI-038/039/040）：默认假实现无批次归属，档案内联缺省
        readTaskById: () => null,
        readBatchById: () => null,
        readCanvasNodePayloads: () => [
          { id: "n1", type: "asset", position: { x: 10, y: 20 }, groupId: "g1", data: { assetId: "asset-1" } },
          { id: "n2", type: "task", position: { x: 0, y: 0 }, data: { taskId: "task-9" } },
          { id: "n3", type: "textInput", position: { x: 1, y: 2 } },
          { id: "n6", type: "imageInput", position: { x: 3, y: 4 }, data: { assetId: "asset-img-1" } },
          { id: "n7", type: "videoInput", position: { x: 5, y: 6 }, data: { assetId: "asset-video-1" } },
          { id: "n8", type: "imageInput", position: { x: 7, y: 8 }, data: {} },
          { type: "asset", position: { x: 1, y: 1 } },
          { id: "n5", type: "asset", position: "not-a-position" },
        ],
        ...(overrides.storage ?? {}),
      },
    });
  };

  it("model.list：转发可执行模型目录并按契约投影条目", async () => {
    forwardResultOverride = { ok: true, payload: { models: [modelEntry] } };
    const registry = buildRegistry();
    const result = await runExecutor(registry, "model.list", { command: "model.list" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "model.list") throw new Error("unexpected");
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.model_id).toBe("demo-model");
    expect(forwardPaths[0]).toBe("/api/executable-model-catalog");
    forwardResultOverride = null;
  });

  it("model.get：命中返回单条；未命中 → model_not_available（CLI-015）", async () => {
    forwardResultOverride = { ok: true, payload: { models: [modelEntry] } };
    const registry = buildRegistry();
    const hit = await runExecutor(registry, "model.get", { command: "model.get", model_id: "demo-model" });
    const hitParsed = parseResponse(hit);
    if (!hitParsed.ok || hitParsed.command !== "model.get") throw new Error("unexpected");
    expect(hitParsed.model.model_id).toBe("demo-model");

    const miss = await runExecutor(registry, "model.get", { command: "model.get", model_id: "nope" });
    expect(parseResponse(miss)).toMatchObject({ ok: false, error: { code: "model_not_available" } });
    forwardResultOverride = null;
  });

  it("model.list：目录转发失败 → model_not_available（转发目录失败语义，spec §9）", async () => {
    forwardResultOverride = { ok: false, reason: "network_error", detail: "conn refused" };
    const registry = buildRegistry();
    const result = await runExecutor(registry, "model.list", { command: "model.list" });
    expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "model_not_available" } });
    forwardResultOverride = null;
  });

  it("asset.list：存储只读投影摘要，生成来源摘要承载产出任务标识", async () => {
    const registry = buildRegistry();
    const result = await runExecutor(registry, "asset.list", { command: "asset.list", project: "demo" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "asset.list") throw new Error("unexpected");
    expect(parsed.assets).toEqual([
      { asset_id: "asset-1", media_type: "image", source_summary: "任务 task-9" },
      { asset_id: "asset-2", media_type: "image", source_summary: "" },
    ]);
  });

  it("asset.get：返回完整资产与本地媒体文件绝对路径（<项目>/media/<fileKey>）", async () => {
    const registry = buildRegistry();
    const result = await runExecutor(registry, "asset.get", { command: "asset.get", project: "demo", asset_id: "asset-1" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "asset.get") throw new Error("unexpected");
    expect(parsed.local_file_path).toBe(join(PROJECT_PATH, "media", "file-a.png"));
    expect(parsed.asset.assetId).toBe("asset-1");
  });

  it("asset.get：资产不存在或无本地文件承载 → asset_not_found", async () => {
    const registry = buildRegistry();
    const miss = await runExecutor(registry, "asset.get", { command: "asset.get", project: "demo", asset_id: "ghost" });
    expect(parseResponse(miss)).toMatchObject({ ok: false, error: { code: "asset_not_found" } });

    const noFile = buildRegistry({
      storage: {
        readMediaAssetById: () => ({
          assetId: "asset-9",
          mediaType: "image",
          original: { url: "local-media://spid_test/" },
          thumbnail: { url: null, status: "ready" },
          lifecycle: { createdAt: 1, updatedAt: 2 },
        }),
      },
    });
    const noFileResult = await runExecutor(noFile, "asset.get", { command: "asset.get", project: "demo", asset_id: "asset-9" });
    expect(parseResponse(noFileResult)).toMatchObject({ ok: false, error: { code: "asset_not_found" } });
  });

  // ── asset list 筛选分页与等价互查（2026-10-07 素材检索批次）──

  const makeRichAsset = (assetId: string, fileKey: string, extra: { mediaType?: string; sourceFileName?: string } = {}) => ({
    assetId,
    mediaType: extra.mediaType ?? "image",
    original: {
      url: `local-media://spid_test/${fileKey}`,
      fileKey,
      ...(extra.sourceFileName !== undefined ? { sourceFileName: extra.sourceFileName } : {}),
      mimeType: "image/png",
      width: 10,
      height: 10,
    },
    thumbnail: { url: null, status: "ready" },
    lifecycle: { createdAt: 1, updatedAt: 2 },
  });

  const RICH_ASSETS = [
    makeRichAsset("imp-1", "hashaaa.png", { sourceFileName: "夕阳海岸.png" }),
    makeRichAsset("gen-1", "hashbbb.png"),
    makeRichAsset("gen-2", "hashccc.jpg", { mediaType: "video" }),
  ];
  const GENERATION_INDEX = new Map([
    ["gen-1", { taskId: "t-1", modelId: "model-a", prompt: "一只橘猫在草地上奔跑" }],
    ["gen-2", { taskId: "t-2", modelId: "model-b", prompt: "海边日落延时" }],
  ]);

  const listAssets = async (extraParams: Record<string, unknown>, storageOverrides: Record<string, unknown> = {}) => {
    const registry = buildRegistry({
      storage: {
        readMediaAssets: () => RICH_ASSETS,
        readAssetTaskIndex: () => new Map([["gen-1", "t-1"]]),
        readAssetGenerationIndex: () => GENERATION_INDEX,
        ...storageOverrides,
      },
    });
    const result = await runExecutor(registry, "asset.list", { command: "asset.list", project: "demo", ...extraParams });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "asset.list") throw new Error("unexpected");
    return parsed.assets;
  };

  // @spec: CLI-018
  it("asset.list 不带筛选参数输出全量且带登记文件名（向后兼容）", async () => {
    const assets = await listAssets({});
    expect(assets.map((a) => a.asset_id)).toEqual(["imp-1", "gen-1", "gen-2"]);
    expect(assets[0]).toMatchObject({ source_file_name: "夕阳海岸.png" });
    expect(assets[1]).not.toHaveProperty("source_file_name");
  });

  // @spec: CLI-018
  it("asset.list --query 大小写不敏感命中原始文件名与生成提示词", async () => {
    const byFile = await listAssets({ query: "夕阳" });
    expect(byFile.map((a) => a.asset_id)).toEqual(["imp-1"]);
    const byPrompt = await listAssets({ query: "橘猫" });
    expect(byPrompt.map((a) => a.asset_id)).toEqual(["gen-1"]);
    // fileKey（内容哈希名）不是检索面：检索面=原始文件名+提交提示词
    const noHit = await listAssets({ query: "hashbbb" });
    expect(noHit).toEqual([]);
  });

  // @spec: CLI-018
  it("asset.list --media-type 与 --model 结构化过滤", async () => {
    const videos = await listAssets({ media_type: "video" });
    expect(videos.map((a) => a.asset_id)).toEqual(["gen-2"]);
    const byModel = await listAssets({ model: "model-a" });
    expect(byModel.map((a) => a.asset_id)).toEqual(["gen-1"]);
    const noMatch = await listAssets({ model: "model-z" });
    expect(noMatch).toEqual([]);
  });

  // @spec: CLI-018
  it("asset.list --limit/--offset 分页", async () => {
    const page1 = await listAssets({ limit: 2 });
    expect(page1.map((a) => a.asset_id)).toEqual(["imp-1", "gen-1"]);
    const page2 = await listAssets({ limit: 2, offset: 2 });
    expect(page2.map((a) => a.asset_id)).toEqual(["gen-2"]);
  });

  // @spec: CLI-018
  it("契约 schema：asset.list 请求缺省参数经 default 物化为不过滤语义（旧客户端兼容）", () => {
    const parsed = CliCommandRequestSchema.parse({ command: "asset.list", project: "demo" });
    if (parsed.command !== "asset.list") throw new Error("unexpected");
    expect(parsed.query).toBeNull();
    expect(parsed.media_type).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.limit).toBeNull();
    expect(parsed.offset).toBe(0);
  });

  // @spec: CLI-019
  it("asset.get 输出同内容等价 id；无等价项不输出该字段", async () => {
    const dupAssets = [
      makeRichAsset("old-imp", "sharedhash.png", { sourceFileName: "同一张.png" }),
      makeRichAsset("gen-prod", "sharedhash.png"),
      makeRichAsset("other", "differenthash.png"),
    ];
    const registry = buildRegistry({
      storage: {
        readMediaAssetById: (_projectPath: string, assetId: string) => dupAssets.find((a) => a.assetId === assetId) ?? null,
        readMediaAssets: () => dupAssets,
      },
    });
    const hit = await runExecutor(registry, "asset.get", { command: "asset.get", project: "demo", asset_id: "gen-prod" });
    const parsed = parseResponse(hit);
    if (!parsed.ok || parsed.command !== "asset.get") throw new Error("unexpected");
    expect(parsed.equivalent_asset_ids).toEqual(["old-imp"]);

    const lone = await runExecutor(registry, "asset.get", { command: "asset.get", project: "demo", asset_id: "other" });
    const loneParsed = parseResponse(lone);
    if (!loneParsed.ok || loneParsed.command !== "asset.get") throw new Error("unexpected");
    expect(loneParsed).not.toHaveProperty("equivalent_asset_ids");
  });

  it("canvas.nodes.list：节点投影（id/类型/位置/组归属/引用），形状不满足的载荷跳过", async () => {
    const registry = buildRegistry();
    const result = await runExecutor(registry, "canvas.nodes.list", { command: "canvas.nodes.list", project: "demo" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.nodes.list") throw new Error("unexpected");
    expect(parsed.nodes).toHaveLength(6);
    expect(parsed.nodes[0]).toEqual({
      node_id: "n1",
      node_type: "asset",
      position: { x: 10, y: 20 },
      group_id: "g1",
      asset_id: "asset-1",
      task_id: null,
    });
    expect(parsed.nodes[1]).toMatchObject({ node_id: "n2", node_type: "task", task_id: "task-9", asset_id: null, group_id: null });
    expect(parsed.nodes[2]).toMatchObject({ node_id: "n3", node_type: "textInput", asset_id: null, task_id: null });
    // @spec: CLI-017
    // 素材节点与资产节点同样输出 asset_id；未落资产的素材节点为 null
    expect(parsed.nodes[3]).toMatchObject({ node_id: "n6", node_type: "imageInput", asset_id: "asset-img-1", task_id: null });
    expect(parsed.nodes[4]).toMatchObject({ node_id: "n7", node_type: "videoInput", asset_id: "asset-video-1", task_id: null });
    expect(parsed.nodes[5]).toMatchObject({ node_id: "n8", node_type: "imageInput", asset_id: null, task_id: null });
  });

  it("task.list：代理转发任务列表并按项目过滤", async () => {
    forwardResultOverride = {
      ok: true,
      payload: {
        total: 2,
        limit: 2,
        offset: 0,
        tasks: [
          { taskId: "t1", id: "t1", projectPath: PROJECT_PATH, nodeGraphId: null, sourceNodeId: null, targetNodeId: null, executionId: null, modelId: null, remoteRequestId: null, status: "generating", createdAt: 1, updatedAt: 2, errorMessage: null, progress: null },
          { taskId: "t2", id: "t2", projectPath: "/other-project", nodeGraphId: null, sourceNodeId: null, targetNodeId: null, executionId: null, modelId: null, remoteRequestId: null, status: "succeeded", createdAt: 1, updatedAt: 2, errorMessage: null, progress: null },
        ],
      },
    };
    const registry = buildRegistry();
    const result = await runExecutor(registry, "task.list", { command: "task.list", project: "demo" });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.list") throw new Error("unexpected");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.taskId).toBe("t1");
    expect(forwardPaths[forwardPaths.length - 1]).toBe(`/api/tasks?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    forwardResultOverride = null;
  });

  // ── task list 可观测与过滤（spec CLI-034/CLI-033）──

  const makeSummary = (taskId: string, overrides: Record<string, unknown> = {}) => ({
    taskId,
    id: taskId,
    projectPath: PROJECT_PATH,
    nodeGraphId: null,
    sourceNodeId: null,
    targetNodeId: null,
    executionId: null,
    modelId: null,
    remoteRequestId: null,
    status: "succeeded",
    createdAt: 1000,
    updatedAt: 2000,
    errorMessage: null,
    progress: null,
    ...overrides,
  });

  // @spec: CLI-034
  it("task.list 投影恢复 progress_percent（backend 列表已带 progress，forwarder 不再丢弃）", async () => {
    const { parseTaskListPayload } = requireDesktop(
      `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-backend-forwarder.cjs`,
    ) as { parseTaskListPayload: (payload: unknown) => { tasks: Array<Record<string, unknown>> } | null };
    const list = parseTaskListPayload({
      total: 1,
      limit: 1,
      offset: 0,
      tasks: [
        makeSummary("t-progress", { status: "generating", progress: 42 }),
        makeSummary("t-no-progress", { progress: null }),
      ],
    });
    expect(list).not.toBeNull();
    expect(list?.tasks.find((task) => task.taskId === "t-progress")?.progressPercent).toBe(42);
    // 未写入进度的任务：字段缺省（契约 optional），不以 0 或占位虚构。
    expect(list?.tasks.find((task) => task.taskId === "t-no-progress")).not.toHaveProperty("progressPercent");
  });

  // @spec: CLI-034
  it("task.list --status 透传服务端过滤参数并本地幂等收敛", async () => {
    forwardResultOverride = {
      ok: true,
      payload: {
        total: 2,
        limit: 2,
        offset: 0,
        tasks: [makeSummary("t-run", { status: "generating" }), makeSummary("t-done", { status: "succeeded" })],
      },
    };
    const registry = buildRegistry();
    const forwardsBefore = forwardPaths.length;
    const result = await runExecutor(registry, "task.list", {
      command: "task.list",
      project: "demo",
      status: "generating",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.list") throw new Error("unexpected");
    expect(parsed.tasks.map((task) => task.taskId)).toEqual(["t-run"]);
    expect(forwardPaths[forwardPaths.length - 1]).toBe(
      `/api/tasks?${new URLSearchParams({ projectPath: PROJECT_PATH, status: "generating" }).toString()}`,
    );
    expect(forwardPaths.length).toBe(forwardsBefore + 1);
    forwardResultOverride = null;
  });

  // @spec: CLI-034
  it("task.list --since 客户端后滤 createdAt（服务端无该参数，改动面最小）", async () => {
    forwardResultOverride = {
      ok: true,
      payload: {
        total: 3,
        limit: 3,
        offset: 0,
        tasks: [
          makeSummary("t-old", { createdAt: 1700000000000 }),
          makeSummary("t-new-1", { createdAt: 1792000000000 }),
          makeSummary("t-new-2", { createdAt: 1792000000001 }),
        ],
      },
    };
    const registry = buildRegistry();
    const result = await runExecutor(registry, "task.list", {
      command: "task.list",
      project: "demo",
      since: "2026-10-14T00:00:00Z",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.list") throw new Error("unexpected");
    expect(parsed.tasks.map((task) => task.taskId)).toEqual(["t-new-1", "t-new-2"]);
    forwardResultOverride = null;
  });

  // @spec: CLI-034
  it("task.list --since 非法时间 → command_rejected 本地拒绝，不发起请求", async () => {
    const registry = buildRegistry();
    const forwardsBefore = forwardPaths.length;
    const result = await runExecutor(registry, "task.list", {
      command: "task.list",
      project: "demo",
      since: "not-a-date",
    });
    const parsed = parseResponse(result);
    if (parsed.ok) throw new Error("unexpected ok");
    expect(parsed.error.code).toBe("command_rejected");
    expect(parsed.error.message).toContain("--since");
    expect(forwardPaths.length).toBe(forwardsBefore);
  });

  // @spec: CLI-033
  it("task.list --request-id 按幂等键反查批次任务（存储只读投影）；未命中返回空列表且成功", async () => {
    const batchTasks = [
      { taskId: "bt-1", status: "succeeded", projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2 },
      { taskId: "bt-2", status: "failed", projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2, errorMessage: "上游失败" },
    ];
    const registry = buildRegistry({
      storage: {
        readBatchByClientRequestId: (_projectPath: string, clientRequestId: string) =>
          clientRequestId === "req-hit"
            ? { batch_id: "batch-hit", task_ids: ["bt-1", "bt-2"] }
            : null,
        readTaskViewsByBatchId: (_projectPath: string, batchId: string) =>
          batchId === "batch-hit" ? batchTasks : [],
      },
    });
    const forwardsBefore = forwardPaths.length;
    const hit = await runExecutor(registry, "task.list", {
      command: "task.list",
      project: "demo",
      client_request_id: "req-hit",
    });
    const hitParsed = parseResponse(hit);
    if (!hitParsed.ok || hitParsed.command !== "task.list") throw new Error("unexpected");
    expect(hitParsed.tasks.map((task) => task.taskId)).toEqual(["bt-1", "bt-2"]);
    // 反查路径不经运行域转发
    expect(forwardPaths.length).toBe(forwardsBefore);

    // 未命中（提交从未落库）：空列表 + 命令成功（对账答案，不是错误）
    const miss = await runExecutor(registry, "task.list", {
      command: "task.list",
      project: "demo",
      client_request_id: "req-never-landed",
    });
    const missParsed = parseResponse(miss);
    if (!missParsed.ok || missParsed.command !== "task.list") throw new Error("unexpected");
    expect(missParsed.tasks).toEqual([]);
  });

  // @spec: CLI-033
  it("task.list --request-id 与 --status/--since 组合过滤", async () => {
    const batchTasks = [
      { taskId: "bt-1", status: "succeeded", projectPath: PROJECT_PATH, createdAt: 1000, updatedAt: 2 },
      { taskId: "bt-2", status: "failed", projectPath: PROJECT_PATH, createdAt: 5000, updatedAt: 2, errorMessage: "x" },
    ];
    const registry = buildRegistry({
      storage: {
        readBatchByClientRequestId: () => ({ batch_id: "batch-hit", task_ids: ["bt-1", "bt-2"] }),
        readTaskViewsByBatchId: () => batchTasks,
      },
    });
    const result = await runExecutor(registry, "task.list", {
      command: "task.list",
      project: "demo",
      client_request_id: "req-hit",
      status: "failed",
      since: "1970-01-01T00:00:03Z",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.list") throw new Error("unexpected");
    expect(parsed.tasks.map((task) => task.taskId)).toEqual(["bt-2"]);
  });

  it("task.get：命中返回任务状态；任务不存在 → task_not_found 且 message 指明任务不存在", async () => {
    forwardResultOverride = {
      ok: true,
      payload: { task: { taskId: "t1", status: "succeeded", projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2 } },
    };
    const registry = buildRegistry();
    const hit = await runExecutor(registry, "task.get", { command: "task.get", project: "demo", task_id: "t1" });
    const hitParsed = parseResponse(hit);
    if (!hitParsed.ok || hitParsed.command !== "task.get") throw new Error("unexpected");
    expect(hitParsed.task.taskId).toBe("t1");

    forwardResultOverride = { ok: false, reason: "http_error", status: 404, detail: "not found" };
    const miss = await runExecutor(registry, "task.get", { command: "task.get", project: "demo", task_id: "ghost" });
    const missParsed = parseResponse(miss);
    if (missParsed.ok) throw new Error("unexpected ok");
    expect(missParsed.error.code).toBe("task_not_found");
    expect(missParsed.error.message).toContain("任务 ghost 不存在");
    forwardResultOverride = null;
  });

  it("task.wait：轮询至终态后返回终态与产物资产（假 forwarder 两次响应不同状态）", async () => {
    const responses: unknown[] = [
      { task: { taskId: "t1", status: "generating", projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2 } },
      { task: { taskId: "t1", status: "succeeded", projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2 } },
    ];
    let callIndex = 0;
    // 直接构造 deps 覆盖 forwarder（复用本文件的存储假实现形状）
    const mod = loadExecutorModule();
    const pollingRegistry = mod.createCliCommandExecutors({
      readProjects: () => [{ nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 }],
      windows: { openOrFocus: async () => ({ ok: true }), hasOpenWindow: () => false, closeByProjectPath: () => true },
      forwarder: {
        getJson: async () => {
          const payload = responses[Math.min(callIndex, responses.length - 1)];
          callIndex += 1;
          return { ok: true, payload };
        },
        postJson: async () => ({ ok: true, payload: {} }),
      },
      storage: {
        createProject: () => ({ projectPath: PROJECT_PATH }),
        deleteProject: () => undefined,
        touchProjectOpenedAt: () => undefined,
        readMediaAssets: () => [],
        readMediaAssetById: () => null,
        readAssetTaskIndex: () => new Map(),
        readTaskOutputAssets: (_projectPath: string, taskId: string) => (taskId === "t1" ? [makeAsset("asset-1", "file-a.png")] : []),
        readTaskById: () => null,
        readBatchById: () => null,
        readCanvasNodePayloads: () => [],
      },
      pollIntervalMs: 1,
    });
    const result = await runExecutor(pollingRegistry, "task.wait", {
      command: "task.wait",
      project: "demo",
      task_id: "t1",
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "task.wait") throw new Error("unexpected");
    expect(parsed.task_result.task.status).toBe("succeeded");
    expect(parsed.task_result.assets).toHaveLength(1);
    expect(parsed.task_result.assets[0]?.local_file_path).toBe(join(PROJECT_PATH, "media", "file-a.png"));
    expect(callIndex).toBe(2);
  });

  it("task.wait：任务不存在 → task_not_found", async () => {
    forwardResultOverride = { ok: false, reason: "http_error", status: 404, detail: "not found" };
    const registry = buildRegistry();
    const result = await runExecutor(registry, "task.wait", { command: "task.wait", project: "demo", task_id: "ghost" });
    const parsed = parseResponse(result);
    if (parsed.ok) throw new Error("unexpected ok");
    expect(parsed.error.code).toBe("task_not_found");
    expect(parsed.error.message).toContain("任务 ghost 不存在");
    forwardResultOverride = null;
  });
});
