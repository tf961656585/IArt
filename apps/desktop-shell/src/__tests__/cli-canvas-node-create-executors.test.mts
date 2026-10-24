// @vitest-environment node
// @spec: CLI-056
//
// canvas.node.create 执行器测试（资产回填画布，spec §5.3 / §6.3 代理执行通道）：
// - 前置校验：项目未打开 / 资产不存在 / 单轴坐标 → 画布零改动、不触达代理通道；
// - 成功：公共参数原样进候选，生成来源摘要由主进程反查后补充（画布窗口无溯源读通道）；
// - dry-run：dry_run 透传，响应 node_id/operation_id 为 null，导入素材候选不带 source_*。
//
// 从 cli-command-executors-proxy.test.mts 拆出（该文件接近 max-lines 预算，拆分先例同
// cli-canvas-read-executors / cli-canvas-write-executors）。

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliCommandRequestSchema, CliCommandResponseSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const executorsEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-command-executors.cjs`;

type ExecutorResult = { response: unknown; errorCode: string | null };
type Executor = (request: unknown) => ExecutorResult | Promise<ExecutorResult>;
type Registry = Map<string, Executor>;

type DispatcherOutcome =
  | { ok: true; response: unknown }
  | { ok: false; reason: string; detail: string };

type ProxyCall = { projectPath: string; candidate: Record<string, unknown> };

type ExecutorModule = {
  createCliCommandExecutors: (deps: Record<string, unknown>) => Registry;
};

type GenerationEntry = {
  taskId: string;
  batchId: string | null;
  modelId: string | null;
  prompt: string | null;
};

const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;

const parseResponse = (result: ExecutorResult) => CliCommandResponseSchema.parse(result.response);

const runExecutor = async (registry: Registry, command: string, request: unknown): Promise<ExecutorResult> => {
  const executor = registry.get(command);
  if (executor === undefined) throw new Error(`executor missing: ${command}`);
  return await executor(CliCommandRequestSchema.parse(request));
};

const PROJECT_PATH = join(tmpdir(), `cli-node-create-exec-proj-${process.pid}`);

const buildRegistry = (overrides: {
  windowOpen?: boolean;
  mediaAsset?: Record<string, unknown> | null;
  generationIndex?: Map<string, GenerationEntry>;
  dispatchOutcome?: DispatcherOutcome;
} = {}): { registry: Registry; proxyCalls: ProxyCall[] } => {
  const proxyCalls: ProxyCall[] = [];
  const dispatchOutcome: DispatcherOutcome =
    overrides.dispatchOutcome !== undefined
      ? overrides.dispatchOutcome
      : {
          ok: true,
          response: {
            command: "canvas.node.create",
            request_id: "ignored",
            node_id: "node-new",
            asset_id: "asset-1",
            position: { x: 0, y: 0 },
            group_id: null,
            operation_id: "op-create",
            dry_run: false,
          },
        };
  const mod = loadExecutorModule();
  const registry = mod.createCliCommandExecutors({
    readProjects: () => [
      { nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 },
    ],
    windows: {
      openOrFocus: async () => ({ ok: true }),
      hasOpenWindow: () => overrides.windowOpen ?? true,
      closeByProjectPath: () => true,
      listOpenEditorProjects: () => [],
    },
    forwarder: {
      getJson: async () => ({ ok: true, payload: {} }),
      postJson: async () => ({ ok: true, payload: {} }),
    },
    storage: {
      createProject: () => ({ projectPath: PROJECT_PATH }),
      deleteProject: () => undefined,
      touchProjectOpenedAt: () => undefined,
      readMediaAssets: () => [],
      readMediaAssetById: () => overrides.mediaAsset ?? null,
      readAssetTaskIndex: () => new Map(),
      readAssetGenerationIndex: () => overrides.generationIndex ?? new Map(),
      readTaskOutputAssets: () => [],
      readCanvasNodePayloads: () => [],
    },
    proxy: {
      dispatch: async (projectPath: string, candidate: Record<string, unknown>) => {
        proxyCalls.push({ projectPath, candidate });
        return dispatchOutcome;
      },
    },
  });
  return { registry, proxyCalls };
};

describe("canvas.node.create 执行器（CLI-056）", () => {
  it("资产不存在 → asset_not_found；单轴 → command_rejected；项目未打开 → project_not_open（均不触达代理通道）", async () => {
    const missing = buildRegistry({ windowOpen: true, mediaAsset: null });
    const missingResult = await runExecutor(missing.registry, "canvas.node.create", {
      command: "canvas.node.create",
      project: "demo",
      asset: "asset-ghost",
    });
    expect(parseResponse(missingResult)).toMatchObject({ ok: false, error: { code: "asset_not_found" } });
    expect(missing.proxyCalls).toHaveLength(0);

    const singleAxis = buildRegistry({
      windowOpen: true,
      mediaAsset: { assetId: "asset-1", mediaType: "image" },
    });
    const axisResult = await runExecutor(singleAxis.registry, "canvas.node.create", {
      command: "canvas.node.create",
      project: "demo",
      asset: "asset-1",
      x: 10,
    });
    expect(parseResponse(axisResult)).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    expect(singleAxis.proxyCalls).toHaveLength(0);

    // 项目未打开：先于资产校验拒绝（与画布写命令同一前提）
    const closed = buildRegistry({ windowOpen: false, mediaAsset: { assetId: "asset-1", mediaType: "image" } });
    const closedResult = await runExecutor(closed.registry, "canvas.node.create", {
      command: "canvas.node.create",
      project: "demo",
      asset: "asset-1",
    });
    expect(parseResponse(closedResult)).toMatchObject({ ok: false, error: { code: "project_not_open" } });
    expect(closed.proxyCalls).toHaveLength(0);
  });

  it("成功：候选带 group/x/y 与主进程补充的生成来源，结果直通", async () => {
    const generationIndex = new Map([
      ["asset-1", { taskId: "task-1", batchId: "batch-1", modelId: "model-a", prompt: "一只猫" }],
    ]);
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      mediaAsset: { assetId: "asset-1", mediaType: "image" },
      generationIndex,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.node.create",
          request_id: "r-c1",
          node_id: "node-new",
          asset_id: "asset-1",
          position: { x: 10, y: 20 },
          group_id: "g-1",
          operation_id: "op-create",
          dry_run: false,
        },
      },
    });
    const result = await runExecutor(registry, "canvas.node.create", {
      command: "canvas.node.create",
      project: "demo",
      asset: "asset-1",
      group: "g-1",
      x: 10,
      y: 20,
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.node.create") throw new Error("unexpected");
    expect(parsed).toMatchObject({
      node_id: "node-new",
      asset_id: "asset-1",
      position: { x: 10, y: 20 },
      group_id: "g-1",
      operation_id: "op-create",
      dry_run: false,
    });
    // 生成来源由主进程反查后补充（画布窗口没有资产→任务溯源读通道）
    expect(proxyCalls[0]?.candidate).toMatchObject({
      command: "canvas.node.create",
      asset: "asset-1",
      group: "g-1",
      x: 10,
      y: 20,
      source_batch_id: "batch-1",
      source_task_id: "task-1",
      source_model_id: "model-a",
    });
  });

  it("--dry-run：dry_run 透传，响应 node_id/operation_id 为 null；导入素材候选不带 source_*", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      // 导入素材：无生成来源，候选不带 source_* 字段
      mediaAsset: { assetId: "asset-imp", mediaType: "video" },
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.node.create",
          request_id: "r-c2",
          node_id: null,
          asset_id: "asset-imp",
          position: { x: 3, y: 4 },
          group_id: null,
          operation_id: null,
          dry_run: true,
        },
      },
    });
    const result = await runExecutor(registry, "canvas.node.create", {
      command: "canvas.node.create",
      project: "demo",
      asset: "asset-imp",
      dry_run: true,
    });
    const parsed = parseResponse(result);
    if (!parsed.ok || parsed.command !== "canvas.node.create") throw new Error("unexpected");
    expect(parsed).toMatchObject({ node_id: null, operation_id: null, dry_run: true, group_id: null });
    const candidate = proxyCalls[0]?.candidate ?? {};
    expect(candidate).toMatchObject({ command: "canvas.node.create", asset: "asset-imp", dry_run: true });
    expect(candidate).not.toHaveProperty("source_batch_id");
    expect(candidate).not.toHaveProperty("source_task_id");
    expect(candidate).not.toHaveProperty("source_model_id");
  });
});
