// @vitest-environment node
//
// generate --wait 受理回执即时输出测试（2026-10-14 批次）。
// @spec: CLI-026
//
// spec §5.4 承诺「受理成功输出批次标识与任务标识列表」：受理响应返回后、开始轮询前，受理
// 回执必须即时写出并等待 flush 完成再继续轮询——否则等待中途进程死亡时调用方零输出，只能
// 盲目重提造成重复任务。输出通道：stdout 是 --json 数据契约通道（只承载最终结果），受理回执
// 属进度信息走 stderr；--json 模式为与受理响应同形的 JSON 对象，人读模式为简要文本。
// 客户端经 deps 注入 emitWaitProgress 与 fetchImpl（假上游），事件序断言「回执落定先于轮询」。
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const clientEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client.cjs`;

type ClientModule = {
  runCliClient: (
    argv: readonly string[],
    deps?: Record<string, unknown>,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const loadClientModule = (): ClientModule => requireDesktop(clientEntry) as ClientModule;

let stubRoot = "";
let stubDiscoveryPath = "";

beforeAll(() => {
  stubRoot = mkdtempSync(join(tmpdir(), `cli-client-receipt-${process.pid}`));
  stubDiscoveryPath = join(stubRoot, "stub-cli-runtime.json");
  // 发现文件只需可解析（fetchImpl 被注入替身，端口不真实使用）
  writeFileSync(
    stubDiscoveryPath,
    JSON.stringify({ port: 1, token: "stub-token", pid: process.pid, version: "stub", startedAt: new Date().toISOString() }),
    { encoding: "utf-8", mode: 0o600 },
  );
});

const PROJECT_PATH = join(stubRoot, "demo-project");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 假上游：generate → 受理响应（batch-1 / t1、t2）；task.get t1 → 第一次 generating 之后
 * succeeded；task.wait t1 → 终态 + 产物。事件序记录每次请求命令，供「回执先于轮询」断言。
 */
const makeFetchStub = (events: string[]): typeof fetch => {
  const pollCalls = new Map<string, number>();
  return (async (_input: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as { command: string; task_id?: string };
    events.push(`fetch:${request.command}${request.task_id !== undefined ? `:${request.task_id}` : ""}`);
    const payload: Record<string, unknown> = (() => {
      if (request.command === "generate") {
        return {
          command: "generate",
          ok: true,
          batch_id: "batch-1",
          tasks: [
            { task_id: "t1", task_index: 0 },
            { task_id: "t2", task_index: 1 },
          ],
          task_results: [],
        };
      }
      if (request.command === "task.get") {
        const taskId = request.task_id ?? "";
        const calls = (pollCalls.get(taskId) ?? 0) + 1;
        pollCalls.set(taskId, calls);
        // 每任务第一次轮询 generating、其后 succeeded（保证轮询至少发生一轮）
        const status = calls === 1 ? "generating" : "succeeded";
        return {
          command: "task.get",
          ok: true,
          task: { taskId, status, projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2 },
        };
      }
      const taskId = request.task_id ?? "";
      return {
        command: "task.wait",
        ok: true,
        task_result: {
          task: { taskId, status: "succeeded", projectPath: PROJECT_PATH, createdAt: 1, updatedAt: 2 },
          assets: [],
        },
      };
    })();
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
};

describe("generate --wait 受理回执即时输出（CLI-026）", () => {
  it("--json 模式：受理响应返回后、轮询开始前回执写入 stderr 通道并等待落定；最终结果仍完整走 stdout", async () => {
    const events: string[] = [];
    const receipts: string[] = [];
    const result = await loadClientModule().runCliClient(
      ["generate", "--prompt", "一张测试图", "--model", "demo-model", "--wait", "--project", PROJECT_PATH, "--json"],
      {
        discoveryFilePath: stubDiscoveryPath,
        pollIntervalMs: 5,
        fetchImpl: makeFetchStub(events),
        emitWaitProgress: async (text: string) => {
          events.push("emit:start");
          receipts.push(text);
          await sleep(20); // 回执落定非零耗时：轮询若不等 flush 会抢在 emit:end 之前发生
          events.push("emit:end");
        },
      },
    );

    expect(result.exitCode).toBe(0);
    // 回执恰好一次，内容为与受理响应同形的 JSON（批次标识 + 任务标识列表）
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(receipts[0] ?? "") as { command: string; ok: boolean; batch_id: string; tasks: { task_id: string }[] };
    expect(receipt.ok).toBe(true);
    expect(receipt.command).toBe("generate");
    expect(receipt.batch_id).toBe("batch-1");
    expect(receipt.tasks.map((task) => task.task_id)).toEqual(["t1", "t2"]);
    // 回执先于轮询落定（emit:end 早于首个 task.get）
    const emitEndIndex = events.indexOf("emit:end");
    const firstPollIndex = events.indexOf("fetch:task.get:t1");
    expect(emitEndIndex).toBeGreaterThan(-1);
    expect(firstPollIndex).toBeGreaterThan(emitEndIndex);
    // 最终结果不受回执影响：stdout 仍为完整终态响应（数据契约通道不被进度信息污染）
    const body = JSON.parse(result.stdout) as { ok: boolean; command: string; batch_id: string; task_results: { task: { taskId: string; status: string } }[] };
    expect(body.ok).toBe(true);
    expect(body.batch_id).toBe("batch-1");
    expect(body.task_results).toHaveLength(2);
    expect(body.task_results.every((entry) => entry.task.status === "succeeded")).toBe(true);
  });

  it("人读模式：受理回执为简要文本（含批次与任务标识），最终结果走 stdout", async () => {
    const receipts: string[] = [];
    const result = await loadClientModule().runCliClient(
      ["generate", "--prompt", "一张测试图", "--model", "demo-model", "--wait", "--project", PROJECT_PATH],
      {
        discoveryFilePath: stubDiscoveryPath,
        pollIntervalMs: 5,
        fetchImpl: makeFetchStub([]),
        emitWaitProgress: async (text: string) => {
          receipts.push(text);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain("生成已受理");
    expect(receipts[0]).toContain("batch-1");
    expect(receipts[0]).toContain("t1");
    expect(result.stdout).toContain("已到终态");
  });

  it("非 --wait 提交不发回执（stdout 即受理结果，回执会重复）", async () => {
    const receipts: string[] = [];
    const result = await loadClientModule().runCliClient(
      ["generate", "--prompt", "一张测试图", "--model", "demo-model", "--project", PROJECT_PATH, "--json"],
      {
        discoveryFilePath: stubDiscoveryPath,
        fetchImpl: makeFetchStub([]),
        emitWaitProgress: async (text: string) => {
          receipts.push(text);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(receipts).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, batch_id: "batch-1" });
  });
});

describe("runCliClientMain 回执接线 pin（CLI-026）", () => {
  // 生产接线是顺序敏感的源码级事实（deps 注入是否真的接到 stderr 写流），编译器与运行时
  // 测试都观测不到，只能源码级断言（风格照抄 cli-main-stdio-wiring.test.mts）。
  const source = readFileSync(`${workspaceRoot}/apps/desktop-shell/src/cli/cli-client-main.cts`, "utf8");

  it("emitWaitProgress 经 writeCliOutputCatching 写到 stderr（回执通道为 stderr，flush 序列复用）", () => {
    const wiringIndex = source.indexOf("emitWaitProgress");
    expect(wiringIndex).toBeGreaterThan(-1);
    // 接线窗口内（deps 注入对象附近）写到 stderr——排除文件尾部既有 result.stderr 落盘调用的假命中
    const wiringWindow = source.slice(wiringIndex, wiringIndex + 500);
    expect(wiringWindow).toContain("writeCliOutputCatching(streams.stderr");
  });
});
