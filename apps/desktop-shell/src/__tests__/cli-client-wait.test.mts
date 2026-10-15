// @vitest-environment node
// @spec: CLI-004, CLI-009, CLI-015
//
// CLI 客户端等待语义测试：
// 1) task.wait 至终态——对真实控制服务（executorDeps 注入假 forwarder：两次响应不同状态），
//    客户端轮询 task.get 后经 task.wait 命令取「终态 + 产物资产」，产物路径为本地绝对路径（CLI-009）；
// 2) --timeout 到期——退出码 1，输出超时错误，任务不受影响；
// 3) generate --wait——经契约同形的桩控制服务验证客户端编排：受理后轮询全部任务至终态，
//    部分失败逐任务如实输出、不整体掩盖（CLI-009）。
import { createRequire } from "node:module";
import * as http from "node:http";
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const serviceEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-control-service.cjs`;
const clientEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client.cjs`;

type ServiceHandle = { port: number; discoveryFilePath: string; stop: () => Promise<void> };
type ServiceModule = {
  startCliControlService: (options?: Record<string, unknown>) => Promise<ServiceHandle>;
};
type ClientModule = {
  runCliClient: (argv: readonly string[], deps?: Record<string, unknown>) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const loadServiceModule = (): ServiceModule => requireDesktop(serviceEntry) as ServiceModule;
const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;

const tempRoot = mkdtempSync(join(tmpdir(), `cli-client-wait-${process.pid}`));
const discoveryFilePath = join(tempRoot, "cli-runtime.json");

const taskView = (taskId: string, status: string) => ({
  taskId,
  status,
  projectPath: PROJECT_PATH,
  createdAt: 1,
  updatedAt: 2,
});

const PROJECT_PATH = join(tempRoot, "demo-project");
const ASSET = {
  assetId: "asset-1",
  mediaType: "image",
  original: { url: "local-media://spid_test/file-a.png", fileKey: "file-a.png", mimeType: "image/png" },
  thumbnail: { url: null, status: "ready" },
  lifecycle: { createdAt: 1, updatedAt: 2 },
};

describe("cli-client 等待语义（真实控制服务 + 假 forwarder）", () => {
  let service: ServiceHandle;
  let client: ClientModule;

  beforeAll(async () => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    const mod = loadServiceModule();
    let catalogCallCount = 0;    service = await mod.startCliControlService({
      port: 0,
      discoveryFilePath,
      executorDeps: {
        readProjects: () => [{ nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 }],
        windows: { openOrFocus: async () => ({ ok: true }), hasOpenWindow: () => false, closeByProjectPath: () => true },
        // 假 forwarder：任务 t1 第一次 generating、之后 succeeded（两次响应不同状态）；
        // 任务 t2 恒 generating（供 --timeout 到期用例）；测试结束后改挂起避免轮询空转。
        forwarder: {
          getJson: async (pathname: string) => {
            if (hangForwarder) return new Promise<never>(() => undefined);
            if (pathname.includes("/api/tasks/t1")) {
              catalogCallCount += 1;
              return {
                ok: true,
                payload: { task: taskView("t1", catalogCallCount === 1 ? "generating" : "succeeded") },
              };
            }
            if (pathname.includes("/api/tasks/t2")) {
              return { ok: true, payload: { task: taskView("t2", "generating") } };
            }
            return { ok: false, reason: "http_error", status: 404, detail: "not found" };
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
          readTaskOutputAssets: (_projectPath: string, taskId: string) => (taskId === "t1" ? [ASSET] : []),
          // 生成档案底座（CLI-038/039/040，task.get 轮询路径消费）：假实现无批次归属，档案内联缺省
          readTaskById: () => null,
          readBatchById: () => null,
          readCanvasNodePayloads: () => [],
        },
        pollIntervalMs: 10,
      },
    });
    // 发现文件可解析且含非空令牌（客户端鉴权前置）
    const discovery = JSON.parse(readFileSync(discoveryFilePath, "utf-8")) as { token: string };
    expect(discovery.token.length).toBeGreaterThan(0);
    client = loadClientModule();
  });

  let hangForwarder = false;

  afterAll(async () => {
    hangForwarder = true; // 让仍在轮询的执行器挂起（无挂起定时器，不阻塞测试进程收尾）
    await service.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("task.wait：轮询至终态，输出终态与产物资产本地绝对路径（CLI-009）", async () => {
    const result = await client.runCliClient(
      ["task", "wait", "t1", "--project", PROJECT_PATH, "--json"],
      { discoveryFilePath, pollIntervalMs: 10 },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      task_result: { task: { taskId: string; status: string }; assets: { local_file_path: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.command).toBe("task.wait");
    expect(body.task_result.task.status).toBe("succeeded");
    expect(body.task_result.assets).toHaveLength(1);
    expect(body.task_result.assets[0]?.local_file_path).toBe(join(PROJECT_PATH, "media", "file-a.png"));
  });

  it("task.wait --timeout 到期：退出码 1 + 超时错误，任务不受影响继续执行", async () => {
    const result = await client.runCliClient(
      ["task", "wait", "t2", "--project", PROJECT_PATH, "--timeout", "1", "--json"],
      { discoveryFilePath, pollIntervalMs: 10 },
    );
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain("等待任务超时");
    expect(body.error.message).toContain("任务仍在后台继续执行");
  }, 10000);

  it("task.wait：发现文件缺失 → not_running（CLI-004）", async () => {
    const result = await client.runCliClient(
      ["task", "wait", "t1", "--project", PROJECT_PATH, "--json"],
      { discoveryFilePath: join(tempRoot, "missing.json"), pollIntervalMs: 10 },
    );
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("not_running");
  });
});

/**
 * generate --wait 的客户端编排测试：generate 执行器归批次四（代理执行通道），
 * 此处以与 CLI 契约同形的桩控制服务承载「受理 → 轮询 → 终态结果」的响应序列，
 * 验证客户端轮询编排与部分失败如实输出。
 */
describe("cli-client generate --wait（桩控制服务）", () => {
  const stubRoot = mkdtempSync(join(tmpdir(), `cli-client-stub-${process.pid}`));
  const stubDiscoveryPath = join(stubRoot, "stub-cli-runtime.json");
  let server: http.Server;
  let t1Calls = 0;

  const respond = (res: http.ServerResponse, payload: unknown): void => {
    const body = JSON.stringify(payload);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const request = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { command: string; task_id?: string };
        if (request.command === "generate") {
          respond(res, {
            command: "generate",
            ok: true,
            batch_id: "batch-1",
            tasks: [
              { task_id: "t1", task_index: 0 },
              { task_id: "t2", task_index: 1 },
            ],
            task_results: [],
          });
          return;
        }
        if (request.command === "task.get") {
          const status = request.task_id === "t1" ? (t1Calls += 1) === 1 ? "generating" : "succeeded" : "failed";
          respond(res, { command: "task.get", ok: true, task: taskView(request.task_id ?? "", status) });
          return;
        }
        if (request.command === "task.wait") {
          if (request.task_id === "t1") {
            respond(res, {
              command: "task.wait",
              ok: true,
              task_result: { task: taskView("t1", "succeeded"), assets: [{ asset: ASSET, local_file_path: join(tempRoot, "media", "file-a.png") }] },
            });
          } else {
            respond(res, {
              command: "task.wait",
              ok: true,
              task_result: { task: { ...taskView("t2", "failed"), errorMessage: "生成失败" }, assets: [] },
            });
          }
          return;
        }
        res.writeHead(404);
        res.end("{}");
      })().catch(() => {
        res.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      stubDiscoveryPath,
      JSON.stringify({ port, token: "stub-token", pid: process.pid, version: "stub", startedAt: new Date().toISOString() }),
      { encoding: "utf-8", mode: 0o600 },
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(stubRoot, { recursive: true, force: true });
  });

  it("generate --wait：轮询全部任务至终态并逐任务输出终态与产物；部分失败如实输出（CLI-009）", async () => {
    const client = loadClientModule();
    const result = await client.runCliClient(
      ["generate", "--prompt", "一张测试图", "--model", "demo-model", "--wait", "--project", PROJECT_PATH, "--json"],
      { discoveryFilePath: stubDiscoveryPath, pollIntervalMs: 10 },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      batch_id: string;
      task_results: { task: { taskId: string; status: string; errorMessage?: string | null }; assets: unknown[] }[];
    };
    expect(body.ok).toBe(true);
    expect(body.batch_id).toBe("batch-1");
    expect(body.task_results).toHaveLength(2);
    const succeeded = body.task_results.find((entry) => entry.task.taskId === "t1");
    const failed = body.task_results.find((entry) => entry.task.taskId === "t2");
    expect(succeeded?.task.status).toBe("succeeded");
    expect(succeeded?.assets).toHaveLength(1);
    // 部分失败逐任务如实输出，不整体掩盖
    expect(failed?.task.status).toBe("failed");
    expect(failed?.task.errorMessage).toBe("生成失败");
    expect(failed?.assets).toHaveLength(0);
  }, 10000);
});
