// @vitest-environment node
// @spec: CLI-014, CLI-051
//
// canvas.inspect（整张画布场景图）执行器测试：假 payload + 假注释 + 假资产 + 假生成来源索引，
// 验证节点身份 join、媒体展示尺寸、容器两遍派生框、compact/full/prompt-limit 分档、
// --group/--no-unplaced 过滤、annotations、overlaps/min_gap/nearest_neighbor 与 fidelity 合并语义。
// 几何公式本身由 @iart/utils/canvas-geometry 的单测保护；本文件断言执行器的投影编排结果。
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

type DispatchOutcome =
  | { ok: true; response: unknown }
  | { ok: false; reason: string; detail: string };

const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;
const parseResponse = (result: ExecutorResult) => CliCommandResponseSchema.parse(result.response);

const runInspect = async (
  registry: Registry,
  overrides: Record<string, unknown> = {},
): Promise<ExecutorResult> => {
  const executor = registry.get("canvas.inspect");
  if (executor === undefined) throw new Error("executor missing: canvas.inspect");
  return await executor(CliCommandRequestSchema.parse({ command: "canvas.inspect", project: "demo", ...overrides }));
};

const PROJECT_PATH = join(tmpdir(), `cli-canvas-inspect-proj-${process.pid}`);
const ISO = new Date(1700000000000).toISOString();

const makeAsset = (
  assetId: string,
  overrides: {
    mediaType?: "image" | "video" | "audio";
    width?: number | null;
    height?: number | null;
    sourceFileName?: string | null;
    createdAt?: number;
  } = {},
) => ({
  assetId,
  mediaType: overrides.mediaType ?? "image",
  original: {
    url: `local-media://spid_test/${assetId}.png`,
    fileKey: `${assetId}.png`,
    sourceFileName: overrides.sourceFileName ?? null,
    mimeType: "image/png",
    width: overrides.width ?? 1024,
    height: overrides.height ?? 768,
  },
  thumbnail: { url: null, status: "missing" },
  lifecycle: { createdAt: overrides.createdAt ?? 1700000000000, updatedAt: 1700000000001 },
});

const IMAGE_ASSET = makeAsset("a-img", { sourceFileName: "猫.png" });
const SQUARE_ASSET = makeAsset("a-square", { width: 800, height: 800 });
const UNPLACED_ASSET = makeAsset("a-unplaced", {
  mediaType: "video",
  width: 1920,
  height: 1080,
  sourceFileName: "未使用.mp4",
});

const LONG_PROMPT = "长提示词".repeat(60); // 240 字符

const GENERATION_INDEX = new Map([
  [
    "a-img",
    { taskId: "t-gen", batchId: "batch-1", modelId: "model-a", prompt: LONG_PROMPT, taskCreatedAt: 1690000000000 },
  ],
  // 未落画布的生成产物：来源批次由生成来源索引回填（CLI-056 修好此前恒 null 的遗留）。
  [
    "a-unplaced",
    {
      taskId: "t-unplaced",
      batchId: "batch-unplaced",
      modelId: "model-b",
      prompt: "未使用的片子",
      taskCreatedAt: 1690000000000,
    },
  ],
]);

const ANNOTATIONS: readonly unknown[] = [
  {
    id: "ann-bound",
    content: "绑定在猫图上的说明",
    position: { x: 120, y: 80 },
    size: { width: 200, height: 60 },
    binding: { type: "node", nodeId: "n-asset" },
  },
  {
    id: "ann-free",
    content: "独立注释",
    position: { x: 900, y: 900 },
    size: { width: 180, height: 40 },
    binding: { type: "free" },
  },
  {
    id: "ann-outside",
    content: "绑定在组外任务上",
    position: { x: 300, y: 700 },
    size: { width: 160, height: 40 },
    binding: { type: "node", nodeId: "n-task" },
  },
];

const PAYLOADS: readonly unknown[] = [
  {
    id: "n-asset",
    type: "asset",
    position: { x: 100, y: 100 },
    groupId: "g1",
    data: {
      label: "猫图",
      assetId: "a-img",
      mediaType: "image",
      sourceBatchId: "batch-1",
      sourceTaskId: "t-gen",
    },
  },
  {
    id: "n-img",
    type: "imageInput",
    position: { x: 500, y: 100 },
    groupId: "g1",
    data: { label: "参考图", assetId: "a-square", imageUrl: null },
  },
  {
    id: "n-audio",
    type: "audioInput",
    position: { x: 100, y: 500 },
    data: {
      label: "旁白",
      audioUrl: "local-media://spid_test/voice.mp3",
      segments: [{}, {}, {}],
      segmentModeEnabled: true,
    },
  },
  {
    id: "n-task",
    type: "task",
    position: { x: 100, y: 700 },
    data: { label: "任务", taskId: "t-1", batchId: "b-1", createdAt: 1700000000000 },
  },
  {
    id: "n-agent",
    type: "agent",
    position: { x: 0, y: 0 },
    groupId: "g1",
    data: { label: "助理" },
  },
  {
    id: "g1",
    type: "group",
    // 持久化组 position 是历史垃圾值：展开态派生框绝不使用它。
    position: { x: 9999, y: 9999 },
    data: { name: "角色组", collapsed: false },
  },
  // 残缺载荷：缺 position，跳过并留痕
  { id: "n-broken", type: "asset" },
];

const createRegistry = (params: {
  windowOpen?: boolean;
  dispatch?: () => Promise<DispatchOutcome>;
  payloads?: readonly unknown[];
  annotations?: readonly unknown[];
} = {}): { registry: Registry; proxyCalls: Array<{ projectPath: string; candidate: unknown }> } => {
  const proxyCalls: Array<{ projectPath: string; candidate: unknown }> = [];
  const mod = loadExecutorModule();
  const registry = mod.createCliCommandExecutors({
    readProjects: () => [
      { nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 },
    ],
    windows: {
      openOrFocus: async () => ({ ok: true }),
      hasOpenWindow: () => params.windowOpen ?? false,
      closeByProjectPath: () => true,
      listOpenEditorProjects: () => [],
    },
    forwarder: { getJson: async () => ({ ok: true, payload: {} }), postJson: async () => ({ ok: true, payload: {} }) },
    storage: {
      createProject: () => ({ projectPath: PROJECT_PATH }),
      deleteProject: () => undefined,
      touchProjectOpenedAt: () => undefined,
      readMediaAssets: () => [IMAGE_ASSET, SQUARE_ASSET, UNPLACED_ASSET],
      readMediaAssetById: () => null,
      readAssetTaskIndex: () => new Map(),
      readAssetGenerationIndex: () => GENERATION_INDEX,
      readTaskOutputAssets: () => [],
      readBatchByClientRequestId: () => null,
      readTaskViewsByBatchId: () => [],
      readTaskById: () => null,
      readBatchById: () => null,
      readCanvasNodePayloads: () => params.payloads ?? PAYLOADS,
      readCanvasAnnotations: () => params.annotations ?? ANNOTATIONS,
    },
    proxy: {
      dispatch: async (projectPath: string, candidate: unknown) => {
        proxyCalls.push({ projectPath, candidate });
        if (params.dispatch === undefined) {
          return { ok: false, reason: "no_window", detail: "not wired" };
        }
        return params.dispatch();
      },
    },
  });
  return { registry, proxyCalls };
};

const expectInspectOk = (result: ExecutorResult) => {
  const parsed = parseResponse(result);
  if (!parsed.ok || parsed.command !== "canvas.inspect") throw new Error("unexpected response");
  return parsed;
};

describe("canvas.inspect：离线派生场景图（window 未打开）", () => {
  it("compact（缺省）：节点身份 join、媒体尺寸、容器两遍派生框、未落画布资产；asset 摘要为 null", async () => {
    const { registry, proxyCalls } = createRegistry();
    const parsed = expectInspectOk(await runInspect(registry));

    expect(proxyCalls).toHaveLength(0);
    expect(parsed.fidelity).toBe("derived");
    expect(parsed.viewport).toBeNull();
    expect(parsed.selection).toBeNull();
    // 残缺载荷被跳过（n-broken 无 position）
    expect(parsed.nodes.map((node) => node.node_id)).toEqual(["n-asset", "n-img", "n-audio", "n-task"]);
    expect(parsed.containers.map((container) => container.group_node_id)).toEqual(["n-agent", "g1"]);

    const assetNode = parsed.nodes.find((node) => node.node_id === "n-asset");
    expect(assetNode).toMatchObject({
      node_type: "asset",
      name: "猫图",
      position: { x: 100, y: 100 },
      // 1024x768 → 长边 320 等比展示尺寸
      size: { width: 320, height: 240 },
      bbox: { x: 100, y: 100, width: 320, height: 240 },
      group_id: "g1",
      asset_id: "a-img",
      // 节点级来源：data.sourceTaskId → 资产节点的产出任务；批次取 data.sourceBatchId。
      task_id: "t-gen",
      batch_id: "batch-1",
      source_file_name: "猫.png",
      created_at: ISO,
      // compact 档不嵌套 asset 摘要。
      asset: null,
    });
    // 提示词前 200 字符 + 省略号
    expect(assetNode?.prompt_preview).toBe(`${LONG_PROMPT.slice(0, 200)}…`);

    const squareNode = parsed.nodes.find((node) => node.node_id === "n-img");
    expect(squareNode?.size).toEqual({ width: 320, height: 320 });

    const audioNode = parsed.nodes.find((node) => node.node_id === "n-audio");
    expect(audioNode?.size).toEqual({ width: 200, height: 234 });
    expect(audioNode).toMatchObject({ task_id: null, batch_id: null, prompt_preview: null, created_at: null });

    const taskNode = parsed.nodes.find((node) => node.node_id === "n-task");
    expect(taskNode).toMatchObject({
      size: { width: 240, height: 160 },
      task_id: "t-1",
      batch_id: "b-1",
      created_at: ISO,
      asset: null,
    });

    // Agent 容器无成员：单节点静态 240×64
    const agentContainer = parsed.containers.find((container) => container.group_node_id === "n-agent");
    expect(agentContainer).toMatchObject({
      type: "agent_container",
      name: "助理",
      member_ids: [],
      position: { x: 0, y: 0 },
      size: { width: 240, height: 64 },
      nearest_neighbor: null,
    });

    // 组框由成员包围盒派生（不使用持久化 9999 位置）：
    // 成员包围盒 x 0..820、y 0..420 → position(-12,-40)、size(844,472)
    const group = parsed.containers.find((container) => container.group_node_id === "g1");
    expect(group).toMatchObject({
      type: "group",
      name: "角色组",
      member_ids: ["n-asset", "n-img", "n-agent"],
      position: { x: -12, y: -40 },
      size: { width: 844, height: 472 },
      bbox: { x: -12, y: -40, width: 844, height: 472 },
      collapsed: false,
      // 唯一顶层容器：没有最近邻。
      nearest_neighbor: null,
    });

    expect(parsed.assets_not_on_canvas).toEqual([
      { asset_id: "a-unplaced", media_type: "video", file_name: "未使用.mp4", created_at: ISO, batch_id: "batch-unplaced" },
    ]);

    // 注释全量输出；绑定节点标识来自持久化 binding（free 为 null）。
    expect(parsed.annotations).toEqual([
      {
        annotation_id: "ann-bound",
        content: "绑定在猫图上的说明",
        position: { x: 120, y: 80 },
        size: { width: 200, height: 60 },
        bound_to_node_id: "n-asset",
      },
      {
        annotation_id: "ann-free",
        content: "独立注释",
        position: { x: 900, y: 900 },
        size: { width: 180, height: 40 },
        bound_to_node_id: null,
      },
      {
        annotation_id: "ann-outside",
        content: "绑定在组外任务上",
        position: { x: 300, y: 700 },
        size: { width: 160, height: 40 },
        bound_to_node_id: "n-task",
      },
    ]);
    // 唯一顶层容器：不足两个容器 → min_gap 为 null，无相交对。
    expect(parsed.min_gap).toBeNull();
    expect(parsed.overlaps).toEqual([]);
  });

  it("--full：嵌套 asset 摘要 + 完整提示词（不截断）", async () => {
    const { registry } = createRegistry();
    const parsed = expectInspectOk(await runInspect(registry, { full: true }));

    const assetNode = parsed.nodes.find((node) => node.node_id === "n-asset");
    expect(assetNode?.prompt_preview).toBe(LONG_PROMPT);
    expect(assetNode?.asset).toMatchObject({
      asset_id: "a-img",
      media_type: "image",
      width: 1024,
      height: 768,
      file_name: "猫.png",
      batch_id: "batch-1",
      task_id: "t-gen",
      model_id: "model-a",
      local_file_path: join(PROJECT_PATH, "media", "a-img.png"),
      created_at: ISO,
      prompt_preview: LONG_PROMPT,
    });
  });

  it("--prompt-limit N：0 不输出提示词；N>0 截断到 N 字符 + 省略号；优先级高于 compact/full", async () => {
    const compact = expectInspectOk(await runInspect(createRegistry().registry, { prompt_limit: 10 }));
    expect(compact.nodes.find((node) => node.node_id === "n-asset")?.prompt_preview).toBe(
      `${LONG_PROMPT.slice(0, 10)}…`,
    );

    const full = expectInspectOk(await runInspect(createRegistry().registry, { full: true, prompt_limit: 10 }));
    expect(full.nodes.find((node) => node.node_id === "n-asset")?.prompt_preview).toBe(
      `${LONG_PROMPT.slice(0, 10)}…`,
    );
    expect(full.nodes.find((node) => node.node_id === "n-asset")?.asset?.prompt_preview).toBe(
      `${LONG_PROMPT.slice(0, 10)}…`,
    );

    const suppressed = expectInspectOk(
      await runInspect(createRegistry().registry, { full: true, prompt_limit: 0 }),
    );
    expect(suppressed.nodes.find((node) => node.node_id === "n-asset")?.prompt_preview).toBeNull();
    expect(suppressed.nodes.find((node) => node.node_id === "n-asset")?.asset?.prompt_preview).toBeNull();
  });

  it("--no-unplaced：未落画布资产置空（场景图其余部分不变）", async () => {
    const parsed = expectInspectOk(await runInspect(createRegistry().registry, { include_unplaced: false }));
    expect(parsed.assets_not_on_canvas).toEqual([]);
    expect(parsed.nodes).toHaveLength(4);
  });

  it("--group：只返回该容器、其后代节点/嵌套容器与绑定到这些节点的注释", async () => {
    const parsed = expectInspectOk(await runInspect(createRegistry().registry, { group: "g1" }));
    expect(parsed.containers.map((container) => container.group_node_id).sort()).toEqual(["g1", "n-agent"]);
    expect(parsed.nodes.map((node) => node.node_id).sort()).toEqual(["n-asset", "n-img"]);
    expect(parsed.annotations.map((annotation) => annotation.annotation_id)).toEqual(["ann-bound"]);
    // --group 时未落画布资产置空。
    expect(parsed.assets_not_on_canvas).toEqual([]);
    // 过滤后唯一顶层容器（g1）；嵌套 Agent 容器没有最近邻。
    expect(parsed.min_gap).toBeNull();
    expect(parsed.containers.find((container) => container.group_node_id === "n-agent")?.nearest_neighbor).toBeNull();
  });

  it("--group 指向不存在的容器 → group_not_found", async () => {
    const result = await runInspect(createRegistry().registry, { group: "ghost" });
    expect(parseResponse(result)).toMatchObject({
      ok: false,
      error: { code: "group_not_found", message: expect.stringContaining("ghost") },
    });
    expect(result.errorCode).toBe("group_not_found");
  });

  it("项目未打开时即使代理可用也不发起窗口几何查询", async () => {
    let dispatchCount = 0;
    const { registry } = createRegistry({
      windowOpen: false,
      dispatch: async () => {
        dispatchCount += 1;
        return { ok: false, reason: "no_window", detail: "x" };
      },
    });
    const parsed = expectInspectOk(await runInspect(registry));
    expect(dispatchCount).toBe(0);
    expect(parsed.fidelity).toBe("derived");
  });
});

describe("canvas.inspect：顶层容器间距与重叠（Chebyshev）", () => {
  const containerPayloads = (positions: Array<{ id: string; x: number; y: number }>): readonly unknown[] =>
    positions.map((entry) => ({
      id: entry.id,
      type: "agent",
      position: { x: entry.x, y: entry.y },
      data: { label: entry.id },
    }));

  it("两个不相交顶层容器：nearest_neighbor 与 min_gap 取实际间距，无 overlaps", async () => {
    const payloads = containerPayloads([
      { id: "a-agent", x: 0, y: 0 },
      { id: "b-agent", x: 300, y: 0 },
    ]);
    const parsed = expectInspectOk(
      await runInspect(createRegistry({ payloads, annotations: [] }).registry),
    );
    // 两框 240x64：dx = 300-(0+240) = 60，dy = 0-64 = -64，Chebyshev gap = 60。
    expect(parsed.min_gap).toEqual({ a_id: "a-agent", b_id: "b-agent", gap: 60 });
    expect(parsed.overlaps).toEqual([]);
    expect(parsed.containers.find((c) => c.group_node_id === "a-agent")?.nearest_neighbor).toEqual({
      node_id: "b-agent",
      gap: 60,
    });
    expect(parsed.containers.find((c) => c.group_node_id === "b-agent")?.nearest_neighbor).toEqual({
      node_id: "a-agent",
      gap: 60,
    });
  });

  it("两个相交顶层容器：overlaps 报交叠尺寸，min_gap 为负", async () => {
    const payloads = containerPayloads([
      { id: "a-agent", x: 0, y: 0 },
      { id: "b-agent", x: 100, y: 20 },
    ]);
    const parsed = expectInspectOk(
      await runInspect(createRegistry({ payloads, annotations: [] }).registry),
    );
    expect(parsed.min_gap).toEqual({ a_id: "a-agent", b_id: "b-agent", gap: -44 });
    expect(parsed.overlaps).toEqual([
      { a_id: "a-agent", b_id: "b-agent", overlap_width: 140, overlap_height: 44 },
    ]);
  });

  it("只有一个顶层容器：nearest_neighbor/min_gap 为 null，overlaps 为空", async () => {
    const parsed = expectInspectOk(
      await runInspect(
        createRegistry({ payloads: containerPayloads([{ id: "only", x: 10, y: 10 }]), annotations: [] }).registry,
      ),
    );
    expect(parsed.containers[0]?.nearest_neighbor).toBeNull();
    expect(parsed.min_gap).toBeNull();
    expect(parsed.overlaps).toEqual([]);
  });
});

describe("canvas.inspect：窗口精确几何合并（fidelity=exact）", () => {
  const NODE_IDS = ["n-asset", "n-img", "n-audio", "n-task", "n-agent", "g1"];
  const CONTAINER_IDS = ["n-agent", "g1"];

  const completeGeometry = () => ({
    sizes: Object.fromEntries(NODE_IDS.map((id) => [id, { width: 111, height: 22 }])),
    containers: Object.fromEntries(
      CONTAINER_IDS.map((id) => [id, { position: { x: 7, y: 8 }, size: { width: 333, height: 44 } }]),
    ),
    viewport: { x: 10, y: 20, zoom: 1.5 },
    selection: { node_ids: ["n-asset"], annotation_ids: ["anno-1"] },
  });

  it("每个节点与容器都有精确几何 → exact，尺寸/容器框/视口/选中态来自窗口", async () => {
    const { registry, proxyCalls } = createRegistry({
      windowOpen: true,
      dispatch: async () => ({
        ok: true,
        response: { command: "canvas.geometry.get", request_id: "ignored", ...completeGeometry() },
      }),
    });
    const parsed = expectInspectOk(await runInspect(registry));

    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]?.candidate).toEqual({ command: "canvas.geometry.get" });
    expect(parsed.fidelity).toBe("exact");
    // 几何快照只承载平移/缩放；画布像素宽高由窗口另行上报，契约扩展前如实 null。
    expect(parsed.viewport).toEqual({ x: 10, y: 20, zoom: 1.5, width: null, height: null });
    expect(parsed.selection).toEqual({ node_ids: ["n-asset"], annotation_ids: ["anno-1"] });
    // 位置保持持久化值，尺寸换成窗口精确值
    const assetNode = parsed.nodes.find((node) => node.node_id === "n-asset");
    expect(assetNode).toMatchObject({
      position: { x: 100, y: 100 },
      size: { width: 111, height: 22 },
      bbox: { x: 100, y: 100, width: 111, height: 22 },
    });
    // 容器 position/size 来自窗口派生框
    const group = parsed.containers.find((container) => container.group_node_id === "g1");
    expect(group).toMatchObject({
      position: { x: 7, y: 8 },
      size: { width: 333, height: 44 },
      bbox: { x: 7, y: 8, width: 333, height: 44 },
    });
    // 只有 g1 是顶层容器（n-agent 属于 g1）：间距统计不足两个容器。
    expect(parsed.min_gap).toBeNull();
  });

  it("窗口几何未覆盖全部节点 → 整体回落 derived 且视口/选中态为 null", async () => {
    const incomplete = completeGeometry();
    const partialSizes: Record<string, { width: number; height: number }> = { ...incomplete.sizes };
    delete partialSizes["n-img"];
    const { registry } = createRegistry({
      windowOpen: true,
      dispatch: async () => ({
        ok: true,
        response: {
          command: "canvas.geometry.get",
          request_id: "ignored",
          ...incomplete,
          sizes: partialSizes,
        },
      }),
    });
    const parsed = expectInspectOk(await runInspect(registry));
    expect(parsed.fidelity).toBe("derived");
    expect(parsed.viewport).toBeNull();
    expect(parsed.selection).toBeNull();
  });

  it("代理分发失败或抛异常 → 命令仍成功，返回 derived", async () => {
    const failed = createRegistry({
      windowOpen: true,
      dispatch: async () => ({ ok: false, reason: "no_window", detail: "窗口刚关闭" }),
    });
    expect(expectInspectOk(await runInspect(failed.registry)).fidelity).toBe("derived");

    const crashed = createRegistry({
      windowOpen: true,
      dispatch: async () => {
        throw new Error("ipc broke");
      },
    });
    expect(expectInspectOk(await runInspect(crashed.registry)).fidelity).toBe("derived");
  });
});
